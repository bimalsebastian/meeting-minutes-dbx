'use client';

import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { ArrowLeft, Settings2, Mic, Database as DatabaseIcon, SparkleIcon, CalendarIcon, BotIcon, Sun, Moon, Monitor } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { invoke } from '@tauri-apps/api/core';
import { useTheme, Theme } from '@/contexts/ThemeContext';
import { motion } from 'framer-motion';
import { TranscriptSettings, TranscriptModelProps } from '@/components/TranscriptSettings';
import { RecordingSettings } from '@/components/RecordingSettings';
import { PreferenceSettings } from '@/components/PreferenceSettings';
import { SummaryModelSettings } from '@/components/SummaryModelSettings';
import CalendarSettings from '@/components/CalendarSettings';
import { GenieLiveSettings } from '@/components/GenieLiveSettings';
import { useConfig } from '@/contexts/ConfigContext';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

// Tabs configuration (constant)
const TABS = [
  { value: 'general', label: 'General', icon: Settings2 },
  { value: 'recording', label: 'Recordings', icon: Mic },
  { value: 'Transcriptionmodels', label: 'Transcription', icon: DatabaseIcon },
  { value: 'summaryModels', label: 'Summary', icon: SparkleIcon },
  { value: 'calendar', label: 'Calendar', icon: CalendarIcon },
  { value: 'copilot', label: 'Genie Live', icon: BotIcon },
] as const;

export default function SettingsPage() {
  const router = useRouter();
  const { transcriptModelConfig, setTranscriptModelConfig } = useConfig();
  const { theme, setTheme } = useTheme();

  // Telemetry settings state
  const [telemetryEnabled, setTelemetryEnabled] = useState(true);
  const [telemetryPath, setTelemetryPath] = useState('');
  const [installId, setInstallId] = useState('');
  const [recentEvents, setRecentEvents] = useState<any[]>([]);
  const [showEventsModal, setShowEventsModal] = useState(false);
  const [telemetrySaved, setTelemetrySaved] = useState(false);

  useEffect(() => {
    fetch('http://localhost:5167/api/telemetry/settings')
      .then(r => r.json())
      .then(d => {
        setTelemetryEnabled(d.telemetryEnabled ?? true);
        setTelemetryPath(d.telemetryPath ?? '');
        setInstallId(d.installId ?? '');
      })
      .catch(() => {});
  }, []);

  const saveTelemetry = useCallback(async (enabled: boolean, path: string) => {
    try {
      await fetch('http://localhost:5167/api/telemetry/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telemetryEnabled: enabled, telemetryPath: path, telemetryConsentShown: true }),
      });
      setTelemetrySaved(true);
      setTimeout(() => setTelemetrySaved(false), 2000);
    } catch {}
  }, []);

  const loadRecentEvents = useCallback(async () => {
    try {
      const r = await fetch('http://localhost:5167/api/telemetry/recent');
      const d = await r.json();
      setRecentEvents(d.events ?? []);
      setShowEventsModal(true);
    } catch {}
  }, []);

  // Animation state for tabs
  const [activeTab, setActiveTab] = useState('general');
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [underlineStyle, setUnderlineStyle] = useState({ left: 0, width: 0 });

  // Load saved transcript configuration on mount
  useEffect(() => {
    const loadTranscriptConfig = async () => {
      try {
        const config = await invoke('api_get_transcript_config') as any;
        if (config) {
          console.log('Loaded saved transcript config:', config);
          setTranscriptModelConfig({
            provider: config.provider || 'localWhisper',
            model: config.model || 'large-v3',
            apiKey: config.apiKey || null
          });
        }
      } catch (error) {
        console.error('Failed to load transcript config:', error);
      }
    };
    loadTranscriptConfig();
  }, [setTranscriptModelConfig]);

  // Update underline position when active tab changes
  useLayoutEffect(() => {
    const activeIndex = TABS.findIndex(tab => tab.value === activeTab);
    const activeTabElement = tabRefs.current[activeIndex];

    if (activeTabElement) {
      const { offsetLeft, offsetWidth } = activeTabElement;
      setUnderlineStyle({ left: offsetLeft, width: offsetWidth });
    }
  }, [activeTab]);

  return (
    <div className="h-screen flex flex-col bg-[var(--app-bg)]">
      {/* Fixed Header */}
      <div className="sticky top-0 z-10 bg-[var(--app-bg)]" style={{ borderBottom: '1px solid var(--separator)' }}>
        <div className="max-w-6xl mx-auto px-8 py-6">
          <div className="flex items-center gap-4">
            <button
              onClick={() => router.back()}
              className="flex items-center gap-2 transition-colors"
              style={{ color: 'var(--text-secondary)' }}
            >
              <ArrowLeft className="w-5 h-5" />
              <span>Back</span>
            </button>
            <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>Settings</h1>
          </div>
        </div>
      </div>

      {/* Scrollable Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto p-8 pt-6">
          {/* Tabs */}
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="bg-transparent relative rounded-none p-0 h-auto" style={{ borderBottom: '1px solid var(--separator)' }}>
              {TABS.map((tab, index) => {
                const Icon = tab.icon;
                return (
                  <TabsTrigger
                    key={tab.value}
                    value={tab.value}
                    ref={el => { tabRefs.current[index] = el }}
                    className="flex items-center gap-2 px-6 py-4 bg-transparent rounded-none border-0 data-[state=active]:bg-transparent data-[state=active]:shadow-none relative z-10 transition-colors"
                    style={{ color: activeTab === tab.value ? 'var(--accent-hex)' : 'var(--text-secondary)' }}
                  >
                    <Icon className="w-4 h-4" />
                    {tab.label}
                  </TabsTrigger>
                );
              })}

              <motion.div
                className="absolute bottom-0 z-20 h-0.5"
                style={{ background: 'var(--accent-hex)', left: underlineStyle.left, width: underlineStyle.width }}
                layoutId="underline"
                transition={{ type: 'spring', stiffness: 400, damping: 40 }}
              />
            </TabsList>

            <TabsContent value="general">
              {/* Appearance / Theme */}
              <div className="mt-6 mb-2 rounded-xl p-5" style={{ background: 'var(--panel-bg)', boxShadow: 'var(--hint-shadow)' }}>
                <h3 className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>Appearance</h3>
                <p className="text-xs mb-4" style={{ color: 'var(--text-secondary)' }}>Choose between light, dark, or follow your system setting.</p>
                <div className="flex gap-2">
                  {([
                    { value: 'light', label: 'Light', icon: Sun },
                    { value: 'dark', label: 'Dark', icon: Moon },
                    { value: 'system', label: 'System', icon: Monitor },
                  ] as { value: Theme; label: string; icon: React.ElementType }[]).map(({ value: t, label, icon: Icon }) => (
                    <button
                      key={t}
                      onClick={() => setTheme(t)}
                      className="flex-1 flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl text-sm font-medium transition-all"
                      style={theme === t ? {
                        background: 'var(--accent-hex)',
                        color: '#FFFFFF',
                        boxShadow: '0 2px 8px rgba(0,122,255,0.3)',
                      } : {
                        background: 'var(--panel-elevated)',
                        color: 'var(--text-secondary)',
                        border: '1px solid var(--separator)',
                      }}
                    >
                      <Icon className="w-4 h-4" />
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {/* Analytics section */}
              <div className="mt-4 mb-2 rounded-xl p-5" style={{ background: 'var(--panel-bg)', boxShadow: 'var(--hint-shadow)' }}>
                <h3 className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>Analytics</h3>
                <p className="text-xs mb-4" style={{ color: 'var(--text-secondary)' }}>
                  Anonymous usage statistics — no meeting content, no personal data.
                </p>

                {/* Toggle row */}
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm" style={{ color: 'var(--text-primary)' }}>Share anonymous usage data</span>
                  <button
                    onClick={() => {
                      const next = !telemetryEnabled;
                      setTelemetryEnabled(next);
                      saveTelemetry(next, telemetryPath);
                    }}
                    className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors"
                    style={{ background: telemetryEnabled ? 'var(--accent-hex)' : 'var(--separator)' }}
                    aria-checked={telemetryEnabled}
                    role="switch"
                  >
                    <span
                      className="inline-block h-4 w-4 rounded-full bg-white shadow transition-transform"
                      style={{ transform: telemetryEnabled ? 'translateX(22px)' : 'translateX(2px)' }}
                    />
                  </button>
                </div>

                {/* Path input */}
                <div className="mb-3">
                  <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>
                    Analytics folder path
                  </label>
                  <input
                    type="text"
                    value={telemetryPath}
                    onChange={e => setTelemetryPath(e.target.value)}
                    placeholder="/path/to/Google Drive folder  or  https://your-endpoint.com/telemetry"
                    className="w-full text-xs px-3 py-2 rounded-lg outline-none transition-all"
                    style={{
                      background: 'var(--panel-elevated)',
                      color: 'var(--text-primary)',
                      border: '1px solid var(--separator)',
                    }}
                    onBlur={() => saveTelemetry(telemetryEnabled, telemetryPath)}
                  />
                  <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
                    Local/mounted folder path <em>or</em> HTTP endpoint URL — both work
                  </p>
                </div>

                {/* View events link */}
                <button
                  onClick={loadRecentEvents}
                  className="text-xs underline mb-3 block transition-opacity hover:opacity-70"
                  style={{ color: 'var(--accent-hex)' }}
                >
                  View what&#39;s being collected →
                </button>

                {/* Install ID */}
                {installId && (
                  <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)', opacity: 0.7 }}>
                    Your anonymous install ID: <span className="font-mono">{installId}</span>
                    <br />This ID is random and not linked to you.
                  </p>
                )}

                {telemetrySaved && (
                  <p className="text-xs mt-2" style={{ color: 'var(--accent-hex)' }}>Saved.</p>
                )}
              </div>

              {/* Recent events modal */}
              {showEventsModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
                  <div className="w-full max-w-lg rounded-2xl p-6 mx-4 max-h-[80vh] flex flex-col" style={{ background: 'var(--panel-bg)', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>What&#39;s being collected</h3>
                      <button onClick={() => setShowEventsModal(false)} className="text-sm opacity-50 hover:opacity-100" style={{ color: 'var(--text-secondary)' }}>✕</button>
                    </div>
                    {recentEvents.length === 0 ? (
                      <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>No events collected yet in this session.</p>
                    ) : (
                      <div className="flex-1 overflow-y-auto space-y-2">
                        {recentEvents.map((ev, i) => {
                          const labels: Record<string, string> = {
                            app_opened: 'App was opened',
                            backend_started: 'Backend started',
                            recording_started: 'Recording started',
                            recording_stopped: 'Recording stopped',
                            screenshot_captured: 'Screenshot was captured',
                            screenshot_dismissed: 'Screenshot was dismissed',
                            genie_live_cycle_fired: 'Genie Live checked the transcript',
                            genie_live_cycle_completed: 'Genie Live completed a cycle',
                            genie_live_skipped: 'Genie Live skipped (no topic)',
                            calendar_connected: 'Calendar was connected',
                            meeting_split_triggered: 'Meeting was split',
                            recall_brief_shown: 'Pre-meeting brief was shown',
                            recall_brief_dismissed: 'Pre-meeting brief was dismissed',
                            settings_saved: 'Settings were saved',
                            app_error: 'An error occurred',
                          };
                          return (
                            <div key={i} className="rounded-lg p-3 text-xs" style={{ background: 'var(--panel-elevated)' }}>
                              <div className="flex items-center justify-between mb-1">
                                <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                                  {labels[ev.event] ?? ev.event}
                                </span>
                                <span style={{ color: 'var(--text-secondary)' }}>
                                  {new Date(ev.timestamp).toLocaleTimeString()}
                                </span>
                              </div>
                              <pre className="text-xs overflow-x-auto" style={{ color: 'var(--text-secondary)' }}>
                                {JSON.stringify({ install_id: ev.install_id, ...ev.properties }, null, 2)}
                              </pre>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}

              <PreferenceSettings />
            </TabsContent>
            <TabsContent value="recording">
              <RecordingSettings />
            </TabsContent>
            <TabsContent value="Transcriptionmodels">
              <TranscriptSettings
                transcriptModelConfig={transcriptModelConfig}
                setTranscriptModelConfig={setTranscriptModelConfig}
              />
            </TabsContent>
            <TabsContent value="summaryModels">
              <SummaryModelSettings />
            </TabsContent>
            <TabsContent value="calendar">
              <CalendarSettings />
            </TabsContent>
            <TabsContent value="copilot">
              <GenieLiveSettings />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
};
