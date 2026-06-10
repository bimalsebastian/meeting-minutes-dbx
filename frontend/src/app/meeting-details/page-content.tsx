"use client";
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { motion } from 'framer-motion';
import { ChevronLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';
import type { Transcript } from '@/types';
import { Summary, SummaryResponse } from '@/types';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import Analytics from '@/lib/analytics';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { TranscriptPanel } from '@/components/MeetingDetails/TranscriptPanel';
import { SummaryPanel } from '@/components/MeetingDetails/SummaryPanel';
import { ModelConfig } from '@/components/ModelSettingsModal';
import { AttachmentsPanel } from '@/app/_components/AttachmentsPanel';
import { GenieSuggestionsTab } from '@/app/_components/GenieSuggestionsTab';
import { useAttachments } from '@/contexts/AttachmentsContext';

import { useMeetingData } from '@/hooks/meeting-details/useMeetingData';
import { useSummaryGeneration } from '@/hooks/meeting-details/useSummaryGeneration';
import { useTemplates } from '@/hooks/meeting-details/useTemplates';
import { useCopyOperations } from '@/hooks/meeting-details/useCopyOperations';
import { useMeetingOperations } from '@/hooks/meeting-details/useMeetingOperations';
import { useConfig } from '@/contexts/ConfigContext';

function formatMeetingDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    });
  } catch { return ''; }
}

function SparkleIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l1.6 5.2L19 10l-5.4 1.8L12 17l-1.6-5.2L5 10l5.4-1.8L12 3z" />
    </svg>
  );
}

export default function PageContent({
  meeting,
  summaryData,
  shouldAutoGenerate = false,
  onAutoGenerateComplete,
  onMeetingUpdated,
  segments,
  hasMore,
  isLoadingMore,
  totalCount,
  loadedCount,
  onLoadMore,
}: {
  meeting: any;
  summaryData: Summary | null;
  shouldAutoGenerate?: boolean;
  onAutoGenerateComplete?: () => void;
  onMeetingUpdated?: () => Promise<void>;
  segments?: any[];
  hasMore?: boolean;
  isLoadingMore?: boolean;
  totalCount?: number;
  loadedCount?: number;
  onLoadMore?: () => void;
}) {
  const [customPrompt, setCustomPrompt] = useState('');
  const [isRecording] = useState(false);
  const [summaryResponse] = useState<SummaryResponse | null>(null);
  const openModelSettingsRef = useRef<(() => void) | null>(null);
  const router = useRouter();

  const { modelConfig, setModelConfig } = useConfig();
  const meetingData = useMeetingData({ meeting, summaryData, onMeetingUpdated, modelConfig });
  const templates = useTemplates();

  const handleRegisterModalOpen = (openFn: () => void) => {
    openModelSettingsRef.current = openFn;
  };

  const handleSaveModelConfig = async (config?: ModelConfig) => {
    if (!config) return;
    try {
      await invoke('api_save_model_config', {
        provider: config.provider,
        model: config.model,
        whisperModel: config.whisperModel,
        apiKey: config.apiKey ?? null,
        ollamaEndpoint: config.ollamaEndpoint ?? null,
      });
      const { emit } = await import('@tauri-apps/api/event');
      await emit('model-config-updated', config);
      toast.success('Model settings saved successfully');
    } catch {
      toast.error('Failed to save model settings');
    }
  };

  const summaryGeneration = useSummaryGeneration({
    meeting,
    transcripts: meetingData.transcripts,
    modelConfig,
    isModelConfigLoading: false,
    selectedTemplate: templates.selectedTemplate,
    onMeetingUpdated,
    updateMeetingTitle: meetingData.updateMeetingTitle,
    setAiSummary: meetingData.setAiSummary,
    onOpenModelSettings: () => openModelSettingsRef.current?.(),
  });

  const copyOperations = useCopyOperations({
    meeting,
    transcripts: meetingData.transcripts,
    meetingTitle: meetingData.meetingTitle,
    aiSummary: meetingData.aiSummary,
    blockNoteSummaryRef: meetingData.blockNoteSummaryRef,
  });

  const meetingOperations = useMeetingOperations({ meeting });

  useEffect(() => { Analytics.trackPageView('meeting_details'); }, []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (shouldAutoGenerate && meetingData.transcripts.length > 0 && !cancelled) {
        await summaryGeneration.handleGenerateSummary('');
        if (onAutoGenerateComplete && !cancelled) onAutoGenerateComplete();
      }
    };
    run();
    return () => { cancelled = true; };
  }, [shouldAutoGenerate, meeting.id]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="flex flex-col h-screen"
      style={{ background: 'var(--app-bg)' }}
    >
      {/* ── Meeting header ── */}
      <header
        className="flex-shrink-0 flex items-center gap-3 px-4 py-3"
        style={{ borderBottom: '1px solid var(--separator)', background: 'var(--panel-bg)' }}
      >
        <button
          onClick={() => router.back()}
          className="flex-shrink-0 flex items-center justify-center rounded-lg transition-colors"
          style={{
            width: 28, height: 28,
            background: 'rgba(120,120,128,0.16)',
            color: 'var(--text-secondary)',
            border: 'none', cursor: 'pointer',
          }}
          title="Back"
        >
          <ChevronLeft size={16} />
        </button>

        <div className="flex-1 min-w-0">
          {/* Inline editable title */}
          <MeetingTitle
            title={meetingData.meetingTitle}
            isEditing={meetingData.isEditingTitle}
            onStartEditing={() => meetingData.setIsEditingTitle(true)}
            onFinishEditing={() => meetingData.setIsEditingTitle(false)}
            onChange={meetingData.handleTitleChange}
          />
          {meeting.created_at && (
            <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--text-secondary)' }}>
              {formatMeetingDate(meeting.created_at)}
            </p>
          )}
        </div>

        {/* Save button — only when dirty */}
        {meetingData.isTitleDirty && (
          <button
            onClick={meetingData.saveAllChanges}
            disabled={meetingData.isSaving}
            className="flex-shrink-0 text-xs px-3 py-1.5 rounded-lg font-medium transition-opacity disabled:opacity-50"
            style={{ background: 'var(--accent-hex)', color: '#fff', border: 'none', cursor: 'pointer' }}
          >
            {meetingData.isSaving ? 'Saving…' : 'Save'}
          </button>
        )}
      </header>

      {/* ── Body: resizable Genie left · Reference tabbed right ── */}
      <ResizableSplit
        meeting={meeting}
        meetingData={meetingData}
        summaryGeneration={summaryGeneration}
        copyOperations={copyOperations}
        meetingOperations={meetingOperations}
        templates={templates}
        modelConfig={modelConfig}
        setModelConfig={setModelConfig}
        handleSaveModelConfig={handleSaveModelConfig}
        handleRegisterModalOpen={handleRegisterModalOpen}
        customPrompt={customPrompt}
        summaryResponse={summaryResponse}
        isRecording={isRecording}
        segments={segments}
        hasMore={hasMore}
        isLoadingMore={isLoadingMore}
        totalCount={totalCount}
        loadedCount={loadedCount}
        onLoadMore={onLoadMore}
      />
    </motion.div>
  );
}

// ── Resizable split container ────────────────────────────────────────────────

function ResizableSplit(props: any) {
  // leftPct: percentage of total width given to Genie column (left)
  // Default 58% for Genie (front & center), 42% for reference
  const [leftPct, setLeftPct] = useState(58);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startPct = useRef(58);

  const MIN_PCT = 30; // Genie never shrinks below 30%
  const MAX_PCT = 75; // Reference column needs at least 25%

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragging.current = true;
    startX.current = e.clientX;
    startPct.current = leftPct;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  }, [leftPct]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const containerW = containerRef.current.offsetWidth;
      const delta = e.clientX - startX.current;
      const deltaPct = (delta / containerW) * 100;
      const next = Math.max(MIN_PCT, Math.min(MAX_PCT, startPct.current + deltaPct));
      setLeftPct(next);
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  return (
    <div ref={containerRef} className="flex flex-1 overflow-hidden" style={{ minHeight: 0 }}>
      {/* LEFT — Genie (primary, front and center) */}
      <div className="flex flex-col overflow-hidden" style={{ width: `${leftPct}%`, flexShrink: 0 }}>
        <GenieSuggestionsTab meetingId={props.meeting.id} />
      </div>

      {/* Drag handle */}
      <div
        onMouseDown={onMouseDown}
        className="flex-shrink-0 cursor-col-resize transition-colors z-10 flex items-center justify-center group"
        style={{ width: 6, background: 'var(--db-line)' }}
        title="Drag to resize"
      >
        <div className="flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {[0, 1, 2].map(i => (
            <div key={i} style={{ width: 3, height: 3, borderRadius: '50%', background: 'var(--db-ink-muted)' }} />
          ))}
        </div>
      </div>

      {/* RIGHT — Reference tabbed panel */}
      <div className="flex flex-col overflow-hidden" style={{ flex: '1 1 0', minWidth: 320 }}>
        <RightTabbedPanel {...props} />
      </div>
    </div>
  );
}

// ── Tabbed right panel ────────────────────────────────────────────────────────

type RightTab = 'summary' | 'transcript' | 'screenshots';

function TabButton({ id, label, icon, count, active, onClick }: {
  id: RightTab; label: string; icon?: React.ReactNode;
  count?: number; active: RightTab; onClick: (id: RightTab) => void;
}) {
  const isActive = active === id;
  return (
    <button
      onClick={() => onClick(id)}
      className="inline-flex items-center gap-1.5 px-4 h-10 relative text-sm transition-colors"
      style={{ background: 'none', border: 'none', cursor: 'pointer', color: isActive ? 'var(--db-navy)' : 'var(--db-ink-muted)', fontWeight: isActive ? 700 : 500 }}
    >
      {icon && <span style={{ color: isActive ? 'var(--db-lava)' : 'currentColor' }}>{icon}</span>}
      {label}
      {count != null && count > 0 && (
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--db-lava)', background: 'var(--db-lava-tint)', borderRadius: 999, padding: '1px 7px' }}>{count}</span>
      )}
      {isActive && <span style={{ position: 'absolute', left: 12, right: 12, bottom: 0, height: 2.5, borderRadius: 3, background: 'var(--db-lava)' }} />}
    </button>
  );
}

function RightTabbedPanel({ meeting, meetingData, summaryGeneration, copyOperations, meetingOperations, templates, modelConfig, setModelConfig, handleSaveModelConfig, handleRegisterModalOpen, customPrompt, summaryResponse, isRecording, segments, hasMore, isLoadingMore, totalCount, loadedCount, onLoadMore }: any) {
  // Default to AI Summary — Genie is already front-and-centre on the left
  const [tab, setTab] = useState<RightTab>('summary');
  const { attachments, loadForMeeting } = useAttachments();

  // Pre-load screenshots so the badge count and content are ready when tab is clicked
  useEffect(() => {
    if (meeting.id && !isRecording) loadForMeeting(meeting.id);
  }, [meeting.id, isRecording, loadForMeeting]);

  return (
    <div className="flex flex-col overflow-hidden h-full" style={{ background: 'var(--db-oat)' }}>
      {/* Tab bar */}
      <div className="flex-shrink-0 flex items-center" style={{ background: 'var(--panel-bg)', borderBottom: '1px solid var(--db-line)', padding: '0 6px' }}>
        <TabButton id="summary" label="AI Summary" active={tab} onClick={setTab}
          icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"><path d="M12 3l1.6 5.2L19 10l-5.4 1.8L12 17l-1.6-5.2L5 10l5.4-1.8L12 3z"/></svg>} />
        <TabButton id="transcript" label="Transcript" active={tab} onClick={setTab}
          icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"><path d="M4 12h2M9 7v10M14 4v16M19 9v6"/></svg>} />
        <TabButton id="screenshots" label="Screenshots" count={attachments.length} active={tab} onClick={setTab}
          icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5L5 21"/></svg>} />
      </div>
      {/* Content */}
      <div className="flex-1 overflow-hidden flex flex-col" style={{ minHeight: 0 }}>
        {tab === 'summary' && (
          <div className="flex-1 overflow-hidden flex flex-col" style={{ background: 'var(--panel-bg)' }}>
            <SummaryPanel meeting={meeting} meetingTitle={meetingData.meetingTitle} onTitleChange={meetingData.handleTitleChange} isEditingTitle={meetingData.isEditingTitle} onStartEditTitle={() => meetingData.setIsEditingTitle(true)} onFinishEditTitle={() => meetingData.setIsEditingTitle(false)} isTitleDirty={meetingData.isTitleDirty} summaryRef={meetingData.blockNoteSummaryRef} isSaving={meetingData.isSaving} onSaveAll={meetingData.saveAllChanges} onCopySummary={copyOperations.handleCopySummary} onOpenFolder={meetingOperations.handleOpenMeetingFolder} aiSummary={meetingData.aiSummary} summaryStatus={summaryGeneration.summaryStatus} transcripts={meetingData.transcripts} modelConfig={modelConfig} setModelConfig={setModelConfig} onSaveModelConfig={handleSaveModelConfig} onGenerateSummary={summaryGeneration.handleGenerateSummary} onStopGeneration={summaryGeneration.handleStopGeneration} customPrompt={customPrompt} summaryResponse={summaryResponse} onSaveSummary={meetingData.handleSaveSummary} onSummaryChange={meetingData.handleSummaryChange} onDirtyChange={meetingData.setIsSummaryDirty} summaryError={summaryGeneration.summaryError} onRegenerateSummary={summaryGeneration.handleRegenerateSummary} getSummaryStatusMessage={summaryGeneration.getSummaryStatusMessage} availableTemplates={templates.availableTemplates} selectedTemplate={templates.selectedTemplate} onTemplateSelect={templates.handleTemplateSelection} isModelConfigLoading={false} onOpenModelSettings={handleRegisterModalOpen} />
          </div>
        )}
        {tab === 'transcript' && (
          <div className="flex-1 overflow-hidden flex flex-col" style={{ background: 'var(--panel-bg)' }}>
            <TranscriptPanel
              transcripts={meetingData.transcripts}
              customPrompt={customPrompt}
              onPromptChange={() => {}}
              onCopyTranscript={copyOperations.handleCopyTranscript}
              onOpenMeetingFolder={meetingOperations.handleOpenMeetingFolder}
              isRecording={isRecording}
              disableAutoScroll={true}
              usePagination={true}
              segments={segments}
              hasMore={hasMore}
              isLoadingMore={isLoadingMore}
              totalCount={totalCount}
              loadedCount={loadedCount}
              onLoadMore={onLoadMore}
            />
          </div>
        )}
        {tab === 'screenshots' && (
          <div className="flex-1 overflow-y-auto" style={{ background: 'var(--db-oat)', padding: 14 }}>
            <AttachmentsPanel meetingId={meeting.id} isRecording={isRecording} />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Dark-mode safe inline title — avoids EditableTitle's hardcoded gray classes
function MeetingTitle({ title, isEditing, onStartEditing, onFinishEditing, onChange }: {
  title: string;
  isEditing: boolean;
  onStartEditing: () => void;
  onFinishEditing: () => void;
  onChange: (v: string) => void;
}) {
  return isEditing ? (
    <input
      autoFocus
      value={title}
      onChange={e => onChange(e.target.value)}
      onBlur={onFinishEditing}
      onKeyDown={e => { if (e.key === 'Enter') onFinishEditing(); }}
      className="text-base font-semibold w-full rounded px-1 focus:outline-none"
      style={{
        background: 'var(--panel-elevated)',
        border: '1px solid var(--accent-hex)',
        color: 'var(--text-primary)',
        letterSpacing: '-0.02em',
      }}
    />
  ) : (
    <h1
      onClick={onStartEditing}
      className="text-base font-semibold truncate cursor-pointer rounded px-1 -mx-1 transition-colors"
      style={{ color: 'var(--text-primary)', letterSpacing: '-0.02em' }}
      title="Click to rename"
    >
      {title}
    </h1>
  );
}

// ── Compact transcript + notes card ──────────────────────────────────────────

function formatTs(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

interface MeetingNote {
  id: string;
  text: string;
  wall_clock_time: string;
  created_at: string;
}

type TimelineItem =
  | { kind: 'transcript'; id: string; audioSecs: number; text: string }
  | { kind: 'note'; id: string; audioSecs: number; text: string; wallClock: string };

function CompactTranscript({ meetingId, meetingCreatedAt, transcripts, onCopy }: {
  meetingId: string;
  meetingCreatedAt?: string;
  transcripts: Transcript[];
  onCopy: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [notes, setNotes] = useState<MeetingNote[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Fetch persisted user notes for this meeting
  useEffect(() => {
    if (!meetingId) return;
    fetch(`http://localhost:5167/api/meetings/${meetingId}/notes`)
      .then(r => r.ok ? r.json() : { notes: [] })
      .then(d => setNotes(d.notes ?? []))
      .catch(() => {});
  }, [meetingId]);

  // Scroll to bottom when content changes
  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcripts.length, notes.length, open]);

  // Build merged, time-sorted timeline
  const timeline = useMemo((): TimelineItem[] => {
    const meetingStartMs = meetingCreatedAt ? new Date(meetingCreatedAt).getTime() : 0;

    const tItems: TimelineItem[] = transcripts.map(t => ({
      kind: 'transcript',
      id: t.id,
      audioSecs: t.audio_start_time ?? 0,
      text: t.text,
    }));

    const nItems: TimelineItem[] = notes.map(n => {
      // Estimate audio offset from ISO created_at vs meeting start
      const noteMs = new Date(n.created_at).getTime();
      const audioSecs = meetingStartMs > 0
        ? Math.max(0, (noteMs - meetingStartMs) / 1000)
        : 0;
      return {
        kind: 'note',
        id: n.id,
        audioSecs,
        text: n.text,
        wallClock: n.wall_clock_time,
      };
    });

    return [...tItems, ...nItems].sort((a, b) => a.audioSecs - b.audioSecs);
  }, [transcripts, notes, meetingCreatedAt]);


  return (
    <div
      className="rounded-xl overflow-hidden flex flex-col"
      style={{
        background: 'var(--panel-bg)',
        border: '1px solid var(--separator)',
        height: 200,
        opacity: 0.7,
        flexShrink: 0,
      }}
    >
      {/* Header */}
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-2 px-4 py-2.5 w-full text-left flex-shrink-0"
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          borderBottom: open ? '1px solid var(--separator)' : 'none',
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.75" strokeLinecap="round" style={{ color: 'var(--text-secondary)', flexShrink: 0 }}>
          <path d="M4 12h2M9 7v10M14 4v16M19 9v6" />
        </svg>
        <span className="text-xs font-semibold flex-1" style={{ color: 'var(--text-secondary)', letterSpacing: '0.02em', textTransform: 'uppercase' }}>
          Transcript {notes.length > 0 && `+ ${notes.length} note${notes.length !== 1 ? 's' : ''}`}
        </span>
        <button
          onClick={e => { e.stopPropagation(); onCopy(); }}
          className="mr-1 p-1 rounded transition-colors"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)' }}
          title="Copy transcript"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
            <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" />
          </svg>
        </button>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"
          style={{ color: 'var(--text-tertiary)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .2s', flexShrink: 0 }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {/* Merged timeline */}
      {open && (
        <div ref={scrollRef} className="flex-1 overflow-y-auto custom-scrollbar px-3 py-2" style={{ minHeight: 0 }}>
          {timeline.length === 0 ? (
            <p className="text-xs text-center mt-4" style={{ color: 'var(--text-tertiary)' }}>No transcript yet</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {timeline.map(item => (
                item.kind === 'transcript' ? (
                  <div key={item.id} className="flex gap-2 items-start">
                    <span
                      className="flex-shrink-0 font-mono"
                      style={{ fontSize: 10, color: 'var(--text-tertiary)', minWidth: 36, paddingTop: 1 }}
                    >
                      {formatTs(item.audioSecs)}
                    </span>
                    <p style={{ fontSize: 11, lineHeight: 1.4, color: 'var(--text-primary)', flex: 1 }}>
                      {item.text}
                    </p>
                  </div>
                ) : (
                  /* User note — visually distinct */
                  <div
                    key={item.id}
                    className="flex gap-2 items-start rounded-lg px-2 py-1.5 my-0.5"
                    style={{
                      background: 'var(--note-bg)',
                      border: '1px solid color-mix(in srgb, var(--note-border) 35%, transparent)',
                    }}
                  >
                    <span style={{ fontSize: 11, flexShrink: 0, paddingTop: 1 }}>📝</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="flex items-center gap-2 mb-0.5">
                        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--note-border)' }}>Your note</span>
                        {item.wallClock && (
                          <span className="font-mono" style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>
                            {item.wallClock}
                          </span>
                        )}
                      </div>
                      <p style={{ fontSize: 11, lineHeight: 1.4, color: 'var(--text-primary)' }}>
                        {item.text}
                      </p>
                    </div>
                  </div>
                )
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
