import { useState, useCallback } from 'react';
import { Transcript, Summary } from '@/types';
import { ModelConfig } from '@/components/ModelSettingsModal';
import { CurrentMeeting, useSidebar } from '@/components/Sidebar/SidebarProvider';
import { invoke as invokeTauri } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import Analytics from '@/lib/analytics';
import { isOllamaNotInstalledError } from '@/lib/utils';
import { BuiltInModelInfo } from '@/lib/builtin-ai';
import { DatabricksAuthError, getValidDatabricksToken } from '@/lib/databricks-azure-client';
import { secureRetrieve } from '@/lib/stronghold';
import { syncMeetingToObsidian } from '@/lib/obsidian-formatter';

type SummaryStatus = 'idle' | 'processing' | 'summarizing' | 'regenerating' | 'completed' | 'error';

interface UseSummaryGenerationProps {
  meeting: any;
  transcripts: Transcript[];
  modelConfig: ModelConfig;
  isModelConfigLoading: boolean;
  selectedTemplate: string;
  onMeetingUpdated?: () => Promise<void>;
  updateMeetingTitle: (title: string) => void;
  setAiSummary: (summary: Summary | null) => void;
  onOpenModelSettings?: () => void;
}

export function useSummaryGeneration({
  meeting,
  transcripts,
  modelConfig,
  isModelConfigLoading,
  selectedTemplate,
  onMeetingUpdated,
  updateMeetingTitle,
  setAiSummary,
  onOpenModelSettings,
}: UseSummaryGenerationProps) {
  const [summaryStatus, setSummaryStatus] = useState<SummaryStatus>('idle');
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [originalTranscript, setOriginalTranscript] = useState<string>('');

  const { startSummaryPolling, stopSummaryPolling } = useSidebar();

  // Helper to get status message
  const getSummaryStatusMessage = useCallback((status: SummaryStatus) => {
    switch (status) {
      case 'processing':
        return 'Processing transcript...';
      case 'summarizing':
        return 'Generating summary...';
      case 'regenerating':
        return 'Regenerating summary...';
      case 'completed':
        return 'Summary completed';
      case 'error':
        return 'Error generating summary';
      default:
        return '';
    }
  }, []);

  // Obsidian sync helper — NO transcripts, summaries only
  const syncToObsidian = useCallback(async (summaryText: string) => {
    try {
      const vaultPath = (await secureRetrieve('obsidian_vault_path'))?.trim()
        || modelConfig.obsidianVaultPath?.trim()
        || '';
      
      if (!vaultPath) {
        console.log('[Obsidian] No vault path, skipping auto-sync');
        return;
      }
      
      const token = (await secureRetrieve('databricks_token')) || '';
      const meetingDate = meeting.created_at
        ? new Date(meeting.created_at).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0];
      const meetingTitle = meeting.title || `Meeting ${meetingDate}`;
      const duration = 'Unknown'; // Duration not tracked in current schema
      
      await syncMeetingToObsidian({
        meetingTitle,
        meetingDate,
        duration,
        summaryText,
        modelConfig,
        token,
        vaultPath,
      });
      
      toast.success('Saved to Obsidian', {
        description: 'Meeting note created in vault',
        duration: 3000,
      });
    } catch (e) {
      console.error('[Obsidian] Auto-sync after generation failed:', e);
      // Non-fatal — never block summary display
      toast.error('Obsidian sync failed', {
        description: 'Summary saved but could not write to vault',
        duration: 3000,
      });
    }
  }, [meeting, modelConfig]);

  // Unified summary processing logic
  const processSummary = useCallback(async ({
    transcriptText,
    customPrompt = '',
    isRegeneration = false,
  }: {
    transcriptText: string;
    customPrompt?: string;
    isRegeneration?: boolean;
  }) => {
    setSummaryStatus(isRegeneration ? 'regenerating' : 'processing');
    setSummaryError(null);

    try {
      if (!transcriptText.trim()) {
        throw new Error('No transcript text available. Please add some text first.');
      }

      if (!isRegeneration) {
        setOriginalTranscript(transcriptText);
      }

      console.log('Processing transcript with template:', selectedTemplate);

      // Calculate time since recording
      const timeSinceRecording = (Date.now() - new Date(meeting.created_at).getTime()) / 60000; // minutes

      // Track summary generation started
      await Analytics.trackSummaryGenerationStarted(
        modelConfig.provider,
        modelConfig.model,
        transcriptText.length,
        timeSinceRecording
      );

      // Track custom prompt usage if present
      if (customPrompt.trim().length > 0) {
        await Analytics.trackCustomPromptUsed(customPrompt.trim().length);
      }

      // Show toast notification for generation start
      toast.info(`${isRegeneration ? 'Regenerating' : 'Generating'} summary...`, {
        description: `Using ${modelConfig.provider}/${modelConfig.model}`,
        duration: 3000,
      });

      // Databricks: Azure CLI auth + Model Serving
      if (modelConfig.provider === 'databricks') {
        console.log('[Summary] Databricks provider selected');
        console.log('[Summary] ========== START DATABRICKS SUMMARY GENERATION ==========');
        console.log('[Summary] Meeting ID:', meeting.id);
        console.log('[Summary] Transcript length:', transcriptText.length, 'characters');

        const endpoint = (modelConfig.model || modelConfig.databricksEndpoint || '').trim();
        console.log('[Summary] Config from modelConfig:', {
          endpointName: endpoint,
          modelField: modelConfig.model,
          databricksEndpointField: modelConfig.databricksEndpoint,
        });

        if (!endpoint) {
          const err = new Error('Databricks serving endpoint name is required. Set it in Model Settings.');
          console.error('[Summary] Configuration error:', err.message);
          throw err;
        }

        try {
          console.log('[Summary] Loading workspace URL from Stronghold (key: databricks_base_url)...');
          const baseUrlFromStronghold = await secureRetrieve('databricks_base_url');
          const baseUrl = baseUrlFromStronghold?.trim() || modelConfig.databricksWorkspaceUrl?.trim() || '';
          console.log('[Summary] Config retrieved:', {
            hasBaseUrl: !!baseUrl,
            fromStronghold: baseUrlFromStronghold?.trim() ? 'yes' : 'no',
            fromModelConfig: modelConfig.databricksWorkspaceUrl?.trim() ? 'yes' : 'no',
            baseUrlLength: baseUrl.length,
            baseUrlPreview: baseUrl ? `${baseUrl.slice(0, 50)}...` : '(empty)',
            endpointName: endpoint,
          });

          if (!baseUrl) {
            const err = new Error('Databricks workspace URL is required. Configure it in Model Settings.');
            console.error('[Summary] Configuration error:', err.message);
            throw err;
          }

          // Get token (with expiry check and auto-refresh) — no fetch from frontend to avoid CORS/preflight
          console.log('[Summary] Loading token for backend call...');
          const token = await getValidDatabricksToken();

          console.log('[Summary] Calling backend databricks_generate_summary (no frontend fetch)...');
          setSummaryStatus('summarizing');

          let markdown: string;
          try {
            markdown = await invokeTauri<string>('databricks_generate_summary', {
              args: {
                workspaceUrl: baseUrl.trim().replace(/\/$/, ''),
                endpointName: endpoint,
                token: token.trim(),
                transcript: transcriptText,
              },
            });
            console.log('[Summary] Summary generated successfully, length:', markdown?.length ?? 0);
          } catch (genErr: unknown) {
            const msg = genErr instanceof Error ? genErr.message : String(genErr);
            console.error('[Summary] databricks_generate_summary failed:', {
              errorName: genErr instanceof Error ? genErr.name : undefined,
              errorMessage: msg,
              fullError: genErr,
            });
            if (/auth|sign in|401|token|expired|invalid/i.test(msg)) {
              throw new DatabricksAuthError(msg);
            }
            throw genErr;
          }

          console.log('[Summary] ========== DATABRICKS SUMMARY GENERATION SUCCESS ==========');
          setAiSummary({ markdown } as unknown as Summary);
          setSummaryStatus('completed');
          await invokeTauri('api_save_meeting_summary', {
            meetingId: meeting.id,
            summary: { markdown },
          });
          await invokeTauri('save_meeting_summary', {
            meetingId: meeting.id,
            summaryText: markdown,
            provider: 'databricks',
            model: endpoint,
          });
          toast.success('Summary generated successfully!', { description: 'Your meeting summary is ready', duration: 4000 });
          
          // Sync to Obsidian if configured (NO transcript)
          await syncToObsidian(markdown);
          
          if (onMeetingUpdated) await onMeetingUpdated();
          await Analytics.trackSummaryGenerationCompleted(modelConfig.provider, modelConfig.model, true);
          return;
        } catch (err) {
          console.error('[Summary] ========== DATABRICKS SUMMARY GENERATION FAILED ==========');
          console.error('[Summary] Error:', {
            message: err instanceof Error ? err.message : String(err),
            name: err instanceof Error ? err.name : undefined,
            stack: err instanceof Error ? err.stack : undefined,
          });
          if (err instanceof DatabricksAuthError) {
            setSummaryError(err.message);
            setSummaryStatus('error');
            toast.error('Databricks sign-in required', {
              description: err.message,
              action: onOpenModelSettings ? { label: 'Settings', onClick: onOpenModelSettings } : undefined,
            });
            await Analytics.trackSummaryGenerationCompleted(modelConfig.provider, modelConfig.model, false, undefined, err.message);
            return;
          }
          throw err;
        }
      }

      // Process transcript and get process_id (all other providers)
      const result = await invokeTauri('api_process_transcript', {
        text: transcriptText,
        model: modelConfig.provider,
        modelName: modelConfig.model,
        meetingId: meeting.id,
        chunkSize: 40000,
        overlap: 1000,
        customPrompt: customPrompt,
        templateId: selectedTemplate,
      }) as any;

      const process_id = result.process_id;
      console.log('Process ID:', process_id);

      // Start global polling via context
      startSummaryPolling(meeting.id, process_id, async (pollingResult) => {
        console.log('Summary status:', pollingResult);

        // Handle cancellation
        if (pollingResult.status === 'cancelled') {
          console.log('Summary generation was cancelled');

          // Reload summary from database (backend has already restored from backup)
          try {
            const existingSummary = await invokeTauri('api_get_summary', {
              meetingId: meeting.id
            }) as any;

            if (existingSummary?.data) {
              console.log('Restored previous summary after cancellation');
              setAiSummary(existingSummary.data);
              setSummaryStatus('completed');
            } else {
              setSummaryStatus('idle');
            }
          } catch (error) {
            console.error('Failed to reload summary after cancellation:', error);
            setSummaryStatus('idle');
          }

          setSummaryError(null);
          return;
        }

        // Handle errors
        if (pollingResult.status === 'error' || pollingResult.status === 'failed') {
          console.error('Backend returned error:', pollingResult.error);
          const errorMessage = pollingResult.error || `Summary ${isRegeneration ? 'regeneration' : 'generation'} failed`;

          // If this was a regeneration, try to restore previous summary from database
          if (isRegeneration) {
            try {
              const existingSummary = await invokeTauri('api_get_summary', {
                meetingId: meeting.id
              }) as any;

              if (existingSummary?.data) {
                console.log('Restored previous summary after regeneration failure');
                setAiSummary(existingSummary.data);
                setSummaryStatus('completed');
                setSummaryError(null);

                // Show error toast with restoration message
                toast.error(`Failed to regenerate summary`, {
                  description: `${errorMessage}. Your previous summary has been restored.`,
                });

                await Analytics.trackSummaryGenerationCompleted(
                  modelConfig.provider,
                  modelConfig.model,
                  false,
                  undefined,
                  errorMessage
                );
                return;
              }
            } catch (error) {
              console.error('Failed to reload summary after error:', error);
            }
          }

          // Continue with normal error handling if not regeneration or reload failed
          setSummaryError(errorMessage);
          setSummaryStatus('error');

          // Check if this is a "model is required" error
          const isModelRequiredError = errorMessage.includes('model is required') ||
            errorMessage.includes('"model":"required"') ||
            errorMessage.toLowerCase().includes('model') && errorMessage.toLowerCase().includes('required');

          // Show error toast
          toast.error(`Failed to ${isRegeneration ? 'regenerate' : 'generate'} summary`, {
            description: errorMessage.includes('Connection refused')
              ? 'Could not connect to LLM service. Please ensure Ollama or your configured LLM provider is running.'
              : errorMessage,
          });

          // Auto-open model settings modal if model is missing
          if (isModelRequiredError && onOpenModelSettings) {
            console.log('🔧 Model required error detected, opening model settings...');
            onOpenModelSettings();
          }

          await Analytics.trackSummaryGenerationCompleted(
            modelConfig.provider,
            modelConfig.model,
            false,
            undefined,
            errorMessage
          );
          return;
        }

        // Handle successful completion
        if (pollingResult.status === 'completed' && pollingResult.data) {
          console.log('Summary generation completed:', pollingResult.data);

          // Update meeting title if available
          const meetingName = pollingResult.data.MeetingName || pollingResult.meetingName;
          if (meetingName) {
            updateMeetingTitle(meetingName);
          }

          // Check if backend returned markdown format (new flow)
          if (pollingResult.data.markdown) {
            console.log('Received markdown format from backend');
            const markdown = pollingResult.data.markdown;
            setAiSummary({ markdown } as any);
            setSummaryStatus('completed');

            await invokeTauri('save_meeting_summary', {
              meetingId: meeting.id,
              summaryText: markdown,
              provider: modelConfig.provider,
              model: modelConfig.model,
            }).catch((e) => console.warn('save_meeting_summary failed:', e));

            // Show success toast
            toast.success('Summary generated successfully!', {
              description: 'Your meeting summary is ready',
              duration: 4000,
            });

            // Sync to Obsidian if configured (NO transcript)
            await syncToObsidian(markdown);

            if (meetingName && onMeetingUpdated) {
              await onMeetingUpdated();
            }

            await Analytics.trackSummaryGenerationCompleted(
              modelConfig.provider,
              modelConfig.model,
              true
            );
            return;
          }

          // Legacy format handling
          const summarySections = Object.entries(pollingResult.data).filter(([key]) => key !== 'MeetingName');
          const allEmpty = summarySections.every(([, section]) => !(section as any).blocks || (section as any).blocks.length === 0);

          if (allEmpty) {
            console.error('Summary completed but all sections empty');
            setSummaryError('Summary generation completed but returned empty content.');
            setSummaryStatus('error');

            await Analytics.trackSummaryGenerationCompleted(
              modelConfig.provider,
              modelConfig.model,
              false,
              undefined,
              'Empty summary generated'
            );
            return;
          }

          // Remove MeetingName from data before formatting
          const { MeetingName, ...summaryData } = pollingResult.data;

          // Format legacy summary data
          const formattedSummary: Summary = {};
          const sectionKeys = pollingResult.data._section_order || Object.keys(summaryData);

          for (const key of sectionKeys) {
            try {
              const section = summaryData[key];
              if (section && typeof section === 'object' && 'title' in section && 'blocks' in section) {
                const typedSection = section as { title?: string; blocks?: any[] };

                if (Array.isArray(typedSection.blocks)) {
                  formattedSummary[key] = {
                    title: typedSection.title || key,
                    blocks: typedSection.blocks.map((block: any) => ({
                      ...block,
                      color: 'default',
                      content: block?.content?.trim() || ''
                    }))
                  };
                } else {
                  formattedSummary[key] = {
                    title: typedSection.title || key,
                    blocks: []
                  };
                }
              }
            } catch (error) {
              console.warn(`Error processing section ${key}:`, error);
            }
          }

          setAiSummary(formattedSummary);
          setSummaryStatus('completed');

          await invokeTauri('save_meeting_summary', {
            meetingId: meeting.id,
            summaryText: JSON.stringify(formattedSummary),
            provider: modelConfig.provider,
            model: modelConfig.model,
          }).catch((e) => console.warn('save_meeting_summary failed:', e));

          // Show success toast
          toast.success('Summary generated successfully!', {
            description: 'Your meeting summary is ready',
            duration: 4000,
          });

          // Sync to Obsidian if configured (convert legacy format to markdown, NO transcript)
          const legacySummaryMarkdown = JSON.stringify(formattedSummary, null, 2);
          await syncToObsidian(legacySummaryMarkdown);

          await Analytics.trackSummaryGenerationCompleted(
            modelConfig.provider,
            modelConfig.model,
            true
          );

          if (meetingName && onMeetingUpdated) {
            await onMeetingUpdated();
          }
        }
      });
    } catch (error) {
      console.error(`Failed to ${isRegeneration ? 'regenerate' : 'generate'} summary:`, error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setSummaryError(errorMessage);
      setSummaryStatus('error');
      // Note: We don't clear the summary here because the backend has already restored from backup

      toast.error(`Failed to ${isRegeneration ? 'regenerate' : 'generate'} summary`, {
        description: errorMessage,
      });

      await Analytics.trackSummaryGenerationCompleted(
        modelConfig.provider,
        modelConfig.model,
        false,
        undefined,
        errorMessage
      );
    }
  }, [
    meeting.id,
    meeting.created_at,
    modelConfig,
    selectedTemplate,
    startSummaryPolling,
    setAiSummary,
    updateMeetingTitle,
    onMeetingUpdated,
    onOpenModelSettings,
  ]);

  // Helper function to fetch ALL transcripts for summary generation
  const fetchAllTranscripts = useCallback(async (meetingId: string): Promise<Transcript[]> => {
    try {
      console.log('📊 Fetching all transcripts for meeting:', meetingId);

      // First, get total count by fetching first page
      const firstPage = await invokeTauri('api_get_meeting_transcripts', {
        meetingId,
        limit: 1,
        offset: 0,
      }) as { transcripts: Transcript[]; total_count: number; has_more: boolean };

      const totalCount = firstPage.total_count;
      console.log(`📊 Total transcripts in database: ${totalCount}`);

      if (totalCount === 0) {
        return [];
      }

      // Fetch all transcripts in one call
      const allData = await invokeTauri('api_get_meeting_transcripts', {
        meetingId,
        limit: totalCount,
        offset: 0,
      }) as { transcripts: Transcript[]; total_count: number; has_more: boolean };

      console.log(`✅ Fetched ${allData.transcripts.length} transcripts from database`);
      return allData.transcripts;
    } catch (error) {
      console.error('❌ Error fetching all transcripts:', error);
      toast.error('Failed to fetch transcripts for summary generation');
      return [];
    }
  }, []);

  // Public API: Generate summary from transcripts
  // NOTE: modelConfig is passed from parent (page-content.tsx) which gets it from useConfig() / ConfigContext.
  // ConfigContext loads it on mount via configService.getModelConfig() (backend api_get_model_config).
  // For Databricks, workspace URL is NOT in modelConfig; it is loaded from keychain (databricks_base_url) inside processSummary.
  const handleGenerateSummary = useCallback(async (customPrompt: string = '') => {
    console.log('[Summary] handleGenerateSummary called');

    // Check if model config is still loading
    if (isModelConfigLoading) {
      console.log('⏳ Model configuration is still loading, please wait...');
      toast.info('Loading model configuration, please wait...');
      return;
    }

    console.log('[Summary] Loading model config...');
    console.log('[Summary] Model config loaded:', {
      provider: modelConfig?.provider,
      hasEndpoint: !!modelConfig?.model,
      endpoint: modelConfig?.model,
      databricksEndpoint: modelConfig?.databricksEndpoint,
      note: "workspaceUrl is loaded from keychain (databricks_base_url) in processSummary when provider is databricks",
      fullConfig: modelConfig,
    });

    // CHANGE: Fetch ALL transcripts from database, not from pagination state
    console.log('📊 Fetching all transcripts for summary generation...');
    const allTranscripts = await fetchAllTranscripts(meeting.id);

    if (!allTranscripts.length) {
      const error_msg = 'No transcripts available for summary';
      console.log(error_msg);
      toast.error(error_msg);
      return;
    }

    console.log(`✅ Proceeding with ${allTranscripts.length} transcripts`);

    console.log('🚀 Starting summary generation with config:', {
      provider: modelConfig.provider,
      model: modelConfig.model,
      template: selectedTemplate
    });

    // Check if Ollama provider has models available
    if (modelConfig.provider === 'ollama') {
      try {
        const endpoint = modelConfig.ollamaEndpoint || null;
        const models = await invokeTauri('get_ollama_models', { endpoint }) as any[];

        if (!models || models.length === 0) {
          toast.error(
            'No Ollama models found. Please download gemma3:1b from Model Settings.',
            { duration: 5000 }
          );
          return;
        }
      } catch (error) {
        console.error('Error checking Ollama models:', error);
        const errorMessage = error instanceof Error ? error.message : String(error);

        if (isOllamaNotInstalledError(errorMessage)) {
          // Ollama is not installed - show specific message with download link
          toast.error(
            'Ollama is not installed',
            {
              description: 'Please download and install Ollama to use local models.',
              duration: 7000,
              action: {
                label: 'Download',
                onClick: () => invokeTauri('open_external_url', { url: 'https://ollama.com/download' })
              }
            }
          );
        } else {
          // Other error - generic message
          toast.error(
            'Failed to check Ollama models. Please ensure Ollama is running and download a model from Settings.',
            { duration: 5000 }
          );
        }
        return;
      }
    }

    // Check if built-in AI provider has models available
    if (modelConfig.provider === 'builtin-ai') {
      try {
        const selectedModel = modelConfig.model;

        if (!selectedModel) {
          toast.error('No built-in AI model selected', {
            description: 'Please select a model in settings',
            duration: 5000,
          });
          if (onOpenModelSettings) {
            onOpenModelSettings();
          }
          return;
        }

        // Check model readiness with filesystem refresh
        const isReady = await invokeTauri<boolean>('builtin_ai_is_model_ready', {
          modelName: selectedModel,
          refresh: true,
        });

        if (!isReady) {
          // Get detailed model status
          const modelInfo = await invokeTauri<BuiltInModelInfo | null>('builtin_ai_get_model_info', {
            modelName: selectedModel,
          });

          if (modelInfo) {
            const status = modelInfo.status;

            if (status.type === 'downloading') {
              toast.info('Model download in progress', {
                description: `${selectedModel} is downloading (${status.progress}%). Please wait until download completes.`,
                duration: 5000,
              });
              return;
            }

            if (status.type === 'not_downloaded') {
              toast.error('Built-in AI model not downloaded', {
                description: `${selectedModel} needs to be downloaded. Please download it in model settings.`,
                duration: 7000,
              });
              if (onOpenModelSettings) {
                onOpenModelSettings();
              }
              return;
            }

            if (status.type === 'corrupted' || status.type === 'error') {
              const errorDesc = status.type === 'error'
                ? status.Error || 'The model file has an error'
                : 'The model file is corrupted';
              toast.error('Built-in AI model not available', {
                description: `${errorDesc}. Please check model settings.`,
                duration: 7000,
              });
              if (onOpenModelSettings) {
                onOpenModelSettings();
              }
              return;
            }
          }

          // Fallback if we couldn't get model info
          toast.error('Built-in AI model not ready', {
            description: 'Please ensure the model is downloaded in settings',
            duration: 5000,
          });
          if (onOpenModelSettings) {
            onOpenModelSettings();
          }
          return;
        }

        // Model is ready, continue to backend call
      } catch (error) {
        console.error('Error validating built-in AI model:', error);
        toast.error('Failed to validate built-in AI model', {
          description: error instanceof Error ? error.message : String(error),
          duration: 5000,
        });
        return;
      }
    }

    // Format timestamps as recording-relative [MM:SS] instead of wall-clock time
    const formatTime = (seconds: number | undefined, fallbackTimestamp: string): string => {
      if (seconds === undefined) {
        // For old transcripts without audio_start_time, use wall-clock time
        return fallbackTimestamp;
      }
      const totalSecs = Math.floor(seconds);
      const mins = Math.floor(totalSecs / 60);
      const secs = totalSecs % 60;
      return `[${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}]`;
    };

    const fullTranscript = allTranscripts
      .map(t => `${formatTime(t.audio_start_time, t.timestamp)} ${t.text}`)
      .join('\n');

    await processSummary({ transcriptText: fullTranscript, customPrompt });
  }, [meeting.id, fetchAllTranscripts, processSummary, modelConfig, isModelConfigLoading, selectedTemplate]);

  // Public API: Regenerate summary from original transcript
  const handleRegenerateSummary = useCallback(async () => {
    if (!originalTranscript.trim()) {
      console.error('No original transcript available for regeneration');
      return;
    }

    await processSummary({
      transcriptText: originalTranscript,
      isRegeneration: true
    });
  }, [originalTranscript, processSummary]);

  // Public API: Stop ongoing summary generation
  const handleStopGeneration = useCallback(async () => {
    console.log('Stopping summary generation for meeting:', meeting.id);

    try {
      // Call backend to cancel the summary generation
      await invokeTauri('api_cancel_summary', {
        meetingId: meeting.id
      });
      console.log('✓ Backend cancellation request sent for meeting:', meeting.id);
    } catch (error) {
      console.error('Failed to cancel summary generation:', error);
      // Continue with frontend cleanup even if backend call fails
    }

    // Stop polling
    stopSummaryPolling(meeting.id);

    // Reset status to idle
    setSummaryStatus('idle');
    setSummaryError(null);

    // Show toast notification
    toast.info('Summary generation stopped', {
      description: 'You can generate a new summary anytime',
      duration: 3000,
    });
  }, [meeting.id, stopSummaryPolling]);

  return {
    summaryStatus,
    summaryError,
    handleGenerateSummary,
    handleRegenerateSummary,
    handleStopGeneration,
    getSummaryStatusMessage,
  };
}
