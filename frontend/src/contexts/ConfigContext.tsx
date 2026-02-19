'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, ReactNode, useRef } from 'react';
import { TranscriptModelProps } from '@/components/TranscriptSettings';
import { SelectedDevices } from '@/components/DeviceSelection';
import { configService, ModelConfig } from '@/services/configService';
import { invoke } from '@tauri-apps/api/core';
import { secureRetrieve } from '@/lib/stronghold';

export interface OllamaModel {
  name: string;
  id: string;
  size: string;
  modified: string;
}

export interface StorageLocations {
  database: string;
  models: string;
  recordings: string;
}

export interface NotificationSettings {
  recording_notifications: boolean;
  time_based_reminders: boolean;
  meeting_reminders: boolean;
  respect_do_not_disturb: boolean;
  notification_sound: boolean;
  system_permission_granted: boolean;
  consent_given: boolean;
  manual_dnd_mode: boolean;
  notification_preferences: {
    show_recording_started: boolean;
    show_recording_stopped: boolean;
    show_recording_paused: boolean;
    show_recording_resumed: boolean;
    show_transcription_complete: boolean;
    show_meeting_reminders: boolean;
    show_system_errors: boolean;
    meeting_reminder_minutes: number[];
  };
}

interface ConfigContextType {
  // Model configuration
  modelConfig: ModelConfig;
  setModelConfig: (config: ModelConfig | ((prev: ModelConfig) => ModelConfig)) => void;

  // Transcript model configuration
  transcriptModelConfig: TranscriptModelProps;
  setTranscriptModelConfig: (config: TranscriptModelProps | ((prev: TranscriptModelProps) => TranscriptModelProps)) => void;

  // Device configuration
  selectedDevices: SelectedDevices;
  setSelectedDevices: (devices: SelectedDevices) => void;

  // Language preference
  selectedLanguage: string;
  setSelectedLanguage: (lang: string) => void;

  // UI preferences
  showConfidenceIndicator: boolean;
  toggleConfidenceIndicator: (checked: boolean) => void;

  // Ollama models
  models: OllamaModel[];
  modelOptions: Record<ModelConfig['provider'], string[]>;
  error: string;

  // Summary configuration
  isAutoSummary: boolean;
  toggleIsAutoSummary: (checked: boolean) => void;

  // Preference settings (lazy loaded)
  notificationSettings: NotificationSettings | null;
  storageLocations: StorageLocations | null;
  isLoadingPreferences: boolean;
  loadPreferences: () => Promise<void>;
  updateNotificationSettings: (settings: NotificationSettings) => Promise<void>;
}

const ConfigContext = createContext<ConfigContextType | undefined>(undefined);


export function ConfigProvider({ children }: { children: ReactNode }) {
  // Model configuration state
  const [modelConfig, setModelConfig] = useState<ModelConfig>({
    provider: 'databricks',
    model: '',
    whisperModel: 'large-v3'
  });

  // Transcript model configuration state
  const [transcriptModelConfig, setTranscriptModelConfig] = useState<TranscriptModelProps>({
    provider: 'parakeet',
    model: 'parakeet-tdt-0.6b-v3-int8',
    apiKey: null
  });

  // Ollama models list and error state
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [error, setError] = useState<string>('');

  // Device configuration state
  const [selectedDevices, setSelectedDevices] = useState<SelectedDevices>({
    micDevice: null,
    systemDevice: null
  });

  // Language preference state
  const [selectedLanguage, setSelectedLanguage] = useState('auto-translate');

  // UI preferences state
  const [showConfidenceIndicator, setShowConfidenceIndicator] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('showConfidenceIndicator');
      return saved !== null ? saved === 'true' : true;
    }
    return true;
  });

  // Summary configs
  const [isAutoSummary, setisAutoSummary] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('isAutoSummary');
      return saved !== null ? saved === 'true' : false
    }
    return false;
  });

  // Preference settings state (lazy loaded)
  const [notificationSettings, setNotificationSettings] = useState<NotificationSettings | null>(null);
  const [storageLocations, setStorageLocations] = useState<StorageLocations | null>(null);
  const [isLoadingPreferences, setIsLoadingPreferences] = useState(false);
  const preferencesLoadedRef = useRef(false);
  const isLoadingRef = useRef(false);

  // Format size helper function for Ollama models
  const formatSize = (size: number): string => {
    if (size < 1024) {
      return `${size} B`;
    } else if (size < 1024 * 1024) {
      return `${(size / 1024).toFixed(1)} KB`;
    } else if (size < 1024 * 1024 * 1024) {
      return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    } else {
      return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    }
  };

  // Load Ollama models on mount
  useEffect(() => {
    const loadModels = async () => {
      try {
        const response = await fetch('http://localhost:11434/api/tags', {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          },
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        const modelList = data.models.map((model: any) => ({
          name: model.name,
          id: model.model,
          size: formatSize(model.size),
          modified: model.modified_at
        }));
        setModels(modelList);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load Ollama models');
        console.error('Error loading models:', err);
      }
    };

    loadModels();
  }, []);

  // Auto-select first Ollama model when models load
  useEffect(() => {
    if (models.length > 0 && modelConfig.provider === 'ollama') {
      setModelConfig(prev => ({
        ...prev,
        model: models[0].name
      }));
    }
  }, [models, modelConfig.provider]);

  // Load transcript configuration on mount
  useEffect(() => {
    const loadTranscriptConfig = async () => {
      try {
        const config = await configService.getTranscriptConfig();
        if (config) {
          console.log('[ConfigContext] Loaded saved transcript config:', config);
          setTranscriptModelConfig({
            provider: config.provider || 'parakeet',
            model: config.model || 'parakeet-tdt-0.6b-v3-int8',
            apiKey: config.apiKey || null
          });
        }
      } catch (error) {
        console.error('[ConfigContext] Failed to load transcript config:', error);
      }
    };
    loadTranscriptConfig();
  }, []);

  // Load model configuration on mount
  useEffect(() => {
    const resolveProviderOnStartup = async (loadedConfig: ModelConfig): Promise<ModelConfig> => {
      console.log('[Startup] Checking Databricks availability...');
      
      try {
        // Check Stronghold first, then SQLite fallback
        const [strongholdUrl, strongholdEndpoint] = await Promise.all([
          secureRetrieve('databricks_base_url'),
          secureRetrieve('databricks_endpoint_name'),
        ]);
        
        const workspaceUrl = strongholdUrl?.trim() 
          || loadedConfig.databricksWorkspaceUrl?.trim() 
          || '';
        const endpointName = strongholdEndpoint?.trim() 
          || loadedConfig.model?.trim() 
          || '';
        
        console.log('[Startup] Databricks config check:', {
          workspaceUrl: workspaceUrl || '(empty)',
          endpointName: endpointName || '(empty)',
          currentProvider: loadedConfig.provider,
        });
        
        // If Databricks is fully configured, make it the active provider
        if (workspaceUrl && endpointName) {
          console.log('[Startup] Databricks configured — setting as active provider');
          
          const updatedConfig: ModelConfig = {
            ...loadedConfig,
            provider: 'databricks',
            model: endpointName,
            databricksWorkspaceUrl: workspaceUrl,
          };
          
          // Persist this provider selection back to SQLite so it 
          // survives the next restart too
          try {
            await invoke('api_save_model_config', {
              args: {
                provider: updatedConfig.provider,
                model: updatedConfig.model,
                whisperModel: updatedConfig.whisperModel,
                apiKey: null,
                ollamaEndpoint: null,
                databricksWorkspaceUrl: updatedConfig.databricksWorkspaceUrl,
              },
            });
            console.log('[Startup] Saved Databricks as active provider to database');
          } catch (saveErr) {
            console.warn('[Startup] Failed to save Databricks provider to database:', saveErr);
          }
          
          return updatedConfig;
        }
        
        console.log('[Startup] Databricks not fully configured, keeping provider:', 
          loadedConfig.provider);
        return loadedConfig;
        
      } catch (e) {
        // Stronghold not ready yet or other error — don't block startup
        console.warn('[Startup] Could not check Databricks availability:', e);
        return loadedConfig;
      }
    };

    const fetchModelConfig = async () => {
      try {
        const data = await configService.getModelConfig();
        if (data && data.provider) {
          // First, check if we should auto-promote Databricks
          const resolvedData = await resolveProviderOnStartup(data);
          
          // If provider is custom-openai, fetch the additional config
          if (resolvedData.provider === 'custom-openai') {
            try {
              const customConfig = await configService.getCustomOpenAIConfig();
              if (customConfig) {
                // Merge custom config fields into modelConfig
                console.log('[ConfigContext] Loading custom OpenAI config:', {
                  endpoint: customConfig.endpoint,
                  model: customConfig.model,
                });
                setModelConfig(prev => ({
                  ...prev,
                  provider: resolvedData.provider,
                  model: customConfig.model || resolvedData.model || prev.model,
                  whisperModel: resolvedData.whisperModel || prev.whisperModel,
                  customOpenAIEndpoint: customConfig.endpoint,
                  customOpenAIModel: customConfig.model,
                  customOpenAIApiKey: customConfig.apiKey,
                  maxTokens: customConfig.maxTokens,
                  temperature: customConfig.temperature,
                  topP: customConfig.topP,
                }));
                return; // Early return
              }
            } catch (err) {
              console.error('[ConfigContext] Failed to fetch custom OpenAI config:', err);
            }
          }

          // For databricks, also load endpoint name from Stronghold (same as workspace URL) so it persists across provider switches
          if (resolvedData.provider === 'databricks') {
            try {
              const endpointName = await secureRetrieve('databricks_endpoint_name');
              const modelValue = (endpointName?.trim() || (resolvedData.model ?? '')).trim();
              console.log('[ConfigContext] Loaded Databricks config:', {
                model: modelValue,
                workspaceUrl: resolvedData.databricksWorkspaceUrl || '(empty)',
                fromStronghold: !!endpointName?.trim(),
                fromDatabase: resolvedData.model,
              });
              setModelConfig(prev => ({
                ...prev,
                provider: resolvedData.provider,
                model: modelValue,
                whisperModel: resolvedData.whisperModel || prev.whisperModel,
                databricksWorkspaceUrl: resolvedData.databricksWorkspaceUrl || null,
              }));
              return;
            } catch (e) {
              console.warn('[ConfigContext] Could not load databricks_endpoint_name from Stronghold:', e);
            }
          }

          // For non-custom-openai providers, just set base config.
          setModelConfig(prev => {
            const modelValue = resolvedData.provider === 'databricks'
              ? (resolvedData.model ?? '')
              : (resolvedData.model || prev.model);
            console.log('[ConfigContext] Loaded model config:', {
              provider: resolvedData.provider,
              model: modelValue,
              fromApi: resolvedData.model,
            });
            return {
              ...prev,
              provider: resolvedData.provider,
              model: modelValue,
              whisperModel: resolvedData.whisperModel || prev.whisperModel,
            };
          });
        }
      } catch (error) {
        console.error('Failed to fetch saved model config in ConfigContext:', error);
      }
    };
    fetchModelConfig();
  }, []);

  // Listen for model config updates from other components
  useEffect(() => {
    const setupListener = async () => {
      const { listen } = await import('@tauri-apps/api/event');
      const unlisten = await listen<ModelConfig>('model-config-updated', (event) => {
        console.log('[ConfigContext] Received model-config-updated event:', event.payload);
        setModelConfig(event.payload);
      });
      return unlisten;
    };

    let cleanup: (() => void) | undefined;
    setupListener().then(fn => cleanup = fn);

    return () => {
      cleanup?.();
    };
  }, []);

  // Load device preferences on mount
  useEffect(() => {
    const loadDevicePreferences = async () => {
      try {
        const prefs = await configService.getRecordingPreferences();
        if (prefs && (prefs.preferred_mic_device || prefs.preferred_system_device)) {
          setSelectedDevices({
            micDevice: prefs.preferred_mic_device,
            systemDevice: prefs.preferred_system_device
          });
          console.log('Loaded device preferences:', prefs);
        }
      } catch (error) {
        console.log('No device preferences found or failed to load:', error);
      }
    };
    loadDevicePreferences();
  }, []);

  // Load language preference on mount
  useEffect(() => {
    const loadLanguagePreference = async () => {
      try {
        const language = await configService.getLanguagePreference();
        if (language) {
          setSelectedLanguage(language);
          console.log('Loaded language preference:', language);
        }
      } catch (error) {
        console.log('No language preference found or failed to load, using default (auto-translate):', error);
        // Default to 'auto-translate' (Auto Detect with English translation) if no preference is saved
        setSelectedLanguage('auto-translate');
      }
    };
    loadLanguagePreference();
  }, []);

  // Calculate model options based on available models
  const modelOptions: Record<ModelConfig['provider'], string[]> = {
    ollama: models.map(model => model.name),
    claude: ['claude-3-5-sonnet-latest'],
    groq: ['llama-3.3-70b-versatile'],
    openrouter: [],
    openai: ['gpt-4', 'gpt-4-turbo', 'gpt-3.5-turbo'],
    'builtin-ai': [],
    'custom-openai': [],
    databricks: [], // Endpoint name set in Azure CLI auth (Model Settings)
  };

  // Toggle confidence indicator with localStorage persistence
  const toggleConfidenceIndicator = useCallback((checked: boolean) => {
    setShowConfidenceIndicator(checked);
    if (typeof window !== 'undefined') {
      localStorage.setItem('showConfidenceIndicator', checked.toString());
    }
    // Trigger a custom event to notify other components
    window.dispatchEvent(new CustomEvent('confidenceIndicatorChanged', { detail: checked }));
  }, []);

  const toggleIsAutoSummary = useCallback((checked: boolean) => {
    setisAutoSummary(checked);
    if (typeof window !== 'undefined') {
      localStorage.setItem('isAutoSummary', checked.toString());
    }
  }, [])

  // Lazy load preference settings (only loads if not already cached)
  const loadPreferences = useCallback(async () => {
    // If already loaded, don't reload
    if (preferencesLoadedRef.current) {
      return;
    }

    // If currently loading, don't start another load
    if (isLoadingRef.current) {
      return;
    }

    isLoadingRef.current = true;
    setIsLoadingPreferences(true);
    try {
      // Load notification settings from backend
      let settings: NotificationSettings | null = null;
      try {
        settings = await invoke<NotificationSettings>('get_notification_settings');
        setNotificationSettings(settings);
      } catch (notifError) {
        console.error('[ConfigContext] Failed to load notification settings:', notifError);
        // Use default values if notification settings fail to load
        setNotificationSettings(null);
      }

      // Load storage locations
      const [dbDir, modelsDir, recordingsDir] = await Promise.all([
        invoke<string>('get_database_directory'),
        invoke<string>('whisper_get_models_directory'),
        invoke<string>('get_default_recordings_folder_path')
      ]);

      setStorageLocations({
        database: dbDir,
        models: modelsDir,
        recordings: recordingsDir
      });

      // Mark as loaded
      preferencesLoadedRef.current = true;
    } catch (error) {
      console.error('[ConfigContext] Failed to load preferences:', error);
    } finally {
      isLoadingRef.current = false;
      setIsLoadingPreferences(false);
    }
  }, []);

  // Update notification settings
  const updateNotificationSettings = useCallback(async (settings: NotificationSettings) => {
    try {
      await invoke('set_notification_settings', { settings });
      setNotificationSettings(settings);
    } catch (error) {
      console.error('[ConfigContext] Failed to update notification settings:', error);
      throw error; // Re-throw so component can handle error
    }
  }, []);

  const value: ConfigContextType = useMemo(() => ({
    modelConfig,
    setModelConfig,
    isAutoSummary,
    toggleIsAutoSummary,
    transcriptModelConfig,
    setTranscriptModelConfig,
    selectedDevices,
    setSelectedDevices,
    selectedLanguage,
    setSelectedLanguage,
    showConfidenceIndicator,
    toggleConfidenceIndicator,
    models,
    modelOptions,
    error,
    notificationSettings,
    storageLocations,
    isLoadingPreferences,
    loadPreferences,
    updateNotificationSettings,
  }), [
    modelConfig,
    isAutoSummary,
    toggleIsAutoSummary,
    transcriptModelConfig,
    selectedDevices,
    selectedLanguage,
    showConfidenceIndicator,
    toggleConfidenceIndicator,
    models,
    modelOptions,
    error,
    notificationSettings,
    storageLocations,
    isLoadingPreferences,
    loadPreferences,
    updateNotificationSettings,
  ]);

  return (
    <ConfigContext.Provider value={value}>
      {children}
    </ConfigContext.Provider>
  );
}

export function useConfig() {
  const context = useContext(ConfigContext);
  if (context === undefined) {
    throw new Error('useConfig must be used within a ConfigProvider');
  }
  return context;
}
