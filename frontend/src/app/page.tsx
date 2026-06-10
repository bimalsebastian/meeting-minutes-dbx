'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import dynamic from 'next/dynamic';
import { motion } from 'framer-motion';
import { RecordingControls } from '@/components/RecordingControls';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { usePermissionCheck } from '@/hooks/usePermissionCheck';
import { useRecordingState, RecordingStatus } from '@/contexts/RecordingStateContext';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { useConfig } from '@/contexts/ConfigContext';
import { StatusOverlays } from '@/app/_components/StatusOverlays';
import Analytics from '@/lib/analytics';
import { SettingsModals } from './_components/SettingsModal';
import { TranscriptPanel } from './_components/TranscriptPanel';
import { useModalState } from '@/hooks/useModalState';
import { useRecordingStateSync } from '@/hooks/useRecordingStateSync';
import { useRecordingStart } from '@/hooks/useRecordingStart';
import { useRecordingStop } from '@/hooks/useRecordingStop';
import { useTranscriptRecovery } from '@/hooks/useTranscriptRecovery';
import { TranscriptRecovery } from '@/components/TranscriptRecovery';
import { indexedDBService } from '@/services/indexedDBService';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { useCalendarPolling } from '@/hooks/useCalendarPolling';
import { useGenieLiveCycles } from '@/hooks/useGenieLiveCycles';
import { useAttachments } from '@/contexts/AttachmentsContext';

// Load new feature panels dynamically — isolates any module-level error to
// that panel's chunk and prevents it from breaking the main page bundle.
const AttachmentsPanel = dynamic(() => import('./_components/AttachmentsPanel').then(m => m.AttachmentsPanel), { ssr: false });
const CopilotSidebar   = dynamic(() => import('./_components/GenieLiveSidebar'), { ssr: false });
const CalendarSplitBanner = dynamic(() => import('@/components/CalendarSplitBanner'), { ssr: false });
const RecallBanner     = dynamic(() => import('@/components/RecallBanner').then(m => ({ default: m.RecallBanner })), { ssr: false });

// Drag-to-resize handle between two panels.
// dragging left (negative delta) makes the right panel wider.
function ResizeHandle({ onDelta }: { onDelta: (delta: number) => void }) {
  const dragging = useRef(false);
  const lastX = useRef(0);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragging.current = true;
    lastX.current = e.clientX;
    e.preventDefault();
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = e.clientX - lastX.current;
      lastX.current = e.clientX;
      onDelta(delta);
    };
    const onUp = () => { dragging.current = false; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [onDelta]);

  return (
    <div
      onMouseDown={onMouseDown}
      className="w-1 flex-shrink-0 bg-[var(--separator)] hover:bg-[var(--accent-hex)] cursor-col-resize transition-colors z-10"
      title="Drag to resize"
    />
  );
}

export default function Home() {
  // Local page state (not moved to contexts)
  const [isRecording, setIsRecordingState] = useState(false);
  const [barHeights, setBarHeights] = useState(['58%', '76%', '58%']);
  const [showRecoveryDialog, setShowRecoveryDialog] = useState(false);
  const [copilotEnabled, setCopilotEnabled] = useState(false);
  const [copilotIntervalMinutes, setCopilotIntervalMinutes] = useState(5);
  const [geniePaused, setGeniePaused] = useState(false);

  // Resizable panel widths (px)
  const [attachWidth, setAttachWidth] = useState(200);
  const [genieWidth, setGenieWidth] = useState(420);
  const onAttachDelta = useCallback((delta: number) => {
    setAttachWidth(w => Math.max(160, Math.min(480, w - delta)));
  }, []);
  const onGenieDelta = useCallback((delta: number) => {
    setGenieWidth(w => Math.max(200, Math.min(560, w - delta)));
  }, []);

  // Use contexts for state management
  const { meetingTitle, currentMeetingId, setMeetingTitle, clearTranscripts } = useTranscripts();
  const { transcriptModelConfig, selectedDevices } = useConfig();
  const recordingState = useRecordingState();

  // Extract status from global state
  const { status, isStopping, isProcessing, isSaving } = recordingState;

  // Hooks
  const { hasMicrophone } = usePermissionCheck();
  const { setIsMeetingActive, isCollapsed: sidebarCollapsed, refetchMeetings } = useSidebar();
  const { modals, messages, showModal, hideModal } = useModalState(transcriptModelConfig);
  const { isRecordingDisabled, setIsRecordingDisabled } = useRecordingStateSync(isRecording, setIsRecordingState, setIsMeetingActive);
  const { handleRecordingStart } = useRecordingStart(isRecording, setIsRecordingState, showModal);

  // Get handleRecordingStop function and setIsStopping (state comes from global context)
  const { handleRecordingStop, setIsStopping } = useRecordingStop(
    setIsRecordingState,
    setIsRecordingDisabled
  );

  // Attachments context — survives navigation
  const { loadForMeeting, clearAttachments } = useAttachments();

  // Load screenshots with Rust UUID when recording starts; clear on stop
  useEffect(() => {
    if (recordingState.isRecording) {
      invoke<string | null>('get_current_meeting_id')
        .then(id => { if (id) loadForMeeting(id); })
        .catch(() => {});
    } else {
      clearAttachments();
      setGeniePaused(false);  // always reset Genie pause when recording ends
    }
  }, [recordingState.isRecording, loadForMeeting, clearAttachments]);

  // Calendar polling for auto-split feature
  const calendarState = useCalendarPolling();

  // Read transcripts from memory and send to Genie Live backend on each cycle.
  // TranscriptContext is cleared on every new recording, so all transcripts in
  // it belong to the current session — no time-based filtering needed.
  const { transcriptsRef, notesRef } = useTranscripts();
  useGenieLiveCycles(
    recordingState.isRecording,
    recordingState.isPaused || geniePaused,   // audio pause OR user-toggled Genie pause
    () => transcriptsRef.current.map(t => t.text).join(' ').trim(),
    copilotIntervalMinutes,
    () => notesRef.current.map(n => n.text),
  );

  // Recovery hook
  const {
    recoverableMeetings,
    isLoading: isLoadingRecovery,
    isRecovering,
    checkForRecoverableTranscripts,
    recoverMeeting,
    loadMeetingTranscripts,
    deleteRecoverableMeeting
  } = useTranscriptRecovery();

  const router = useRouter();

  // Handle "Split Now" from the calendar banner: stop current recording (no navigation),
  // acknowledge the split, then start a new recording with the next event title.
  const handleCalendarSplitNow = async () => {
    // Capture next event title before stopping (state may change)
    const nextTitle = calendarState.nextEventTitle;

    // Stop the current recording without navigating away
    await handleRecordingStop(true, { skipNavigation: true });
    await new Promise(r => setTimeout(r, 500));

    // Tell the backend the split was handled
    try {
      await fetch('http://localhost:5167/api/calendar/acknowledge_split', { method: 'POST' });
    } catch {
      // ignore — best effort
    }

    // Start a fresh recording named after the next calendar event
    if (nextTitle) {
      try {
        setMeetingTitle(nextTitle);
        clearTranscripts();
        await handleRecordingStart();
        console.log('[CalendarSplit] Started new recording for:', nextTitle);
      } catch (err) {
        console.error('[CalendarSplit] Failed to start new recording:', err);
      }
    }
  };

  // Dismiss the split banner for this event
  const handleKeepRecording = () => {
    if (calendarState.nextEventId) {
      fetch('http://localhost:5167/api/calendar/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_id: calendarState.nextEventId }),
      }).catch(() => {});
    }
  };

  useEffect(() => {
    // Track page view
    Analytics.trackPageView('home');
  }, []);

  // Load copilot enabled state on mount
  useEffect(() => {
    fetch('http://localhost:5167/api/copilot/settings')
      .then(r => r.json())
      .then(d => {
        setCopilotEnabled(!!d.copilotEnabled);
        setCopilotIntervalMinutes(d.copilotIntervalMinutes ?? 5);
      })
      .catch(() => {});
  }, []);

  // Startup recovery check
  useEffect(() => {
    const performStartupChecks = async () => {
      try {
        // Skip recovery check if currently recording or processing stop
        // This prevents the recovery dialog from showing when:
        if (recordingState.isRecording ||
          status === RecordingStatus.STOPPING ||
          status === RecordingStatus.PROCESSING_TRANSCRIPTS ||
          status === RecordingStatus.SAVING) {
          console.log('Skipping recovery check - recording in progress or processing');
          return;
        }

        // 1. Clean up old meetings (7+ days)
        try {
          await indexedDBService.deleteOldMeetings(7);
        } catch (error) {
          console.warn('⚠️ Failed to clean up old meetings:', error);
        }

        // 2. Clean up saved meetings (24+ hours after save)
        try {
          await indexedDBService.deleteSavedMeetings(24);
        } catch (error) {
          console.warn('⚠️ Failed to clean up saved meetings:', error);
        }

        // 3. Always check for recoverable meetings on startup
        // Don't skip based on sessionStorage - we need to check every time
        await checkForRecoverableTranscripts();
      } catch (error) {
        console.error('Failed to perform startup checks:', error);
      }
    };

    performStartupChecks();
  }, [checkForRecoverableTranscripts, recordingState.isRecording, status]);

  // Watch for recoverable meetings changes and show dialog once per session
  useEffect(() => {
    // Only show dialog if we have meetings and haven't shown it yet this session
    if (recoverableMeetings.length > 0) {
      const shownThisSession = sessionStorage.getItem('recovery_dialog_shown');
      if (!shownThisSession) {
        setShowRecoveryDialog(true);
        sessionStorage.setItem('recovery_dialog_shown', 'true');
      }
    }
  }, [recoverableMeetings]);

  // Handle recovery with toast notifications and navigation
  const handleRecovery = async (meetingId: string) => {
    try {
      const result = await recoverMeeting(meetingId);

      if (result.success) {
        toast.success('Meeting recovered successfully!', {
          description: result.audioRecoveryStatus?.status === 'success'
            ? 'Transcripts and audio recovered'
            : 'Transcripts recovered (no audio available)',
          action: result.meetingId ? {
            label: 'View Meeting',
            onClick: () => {
              router.push(`/meeting-details?id=${result.meetingId}`);
            }
          } : undefined,
          duration: 10000,
        });

        // Refresh sidebar to show the newly recovered meeting
        await refetchMeetings();

        // If no more recoverable meetings, clear session flag so dialog can show again
        if (recoverableMeetings.length === 0) {
          sessionStorage.removeItem('recovery_dialog_shown');
        }

        // Auto-navigate after a short delay
        if (result.meetingId) {
          setTimeout(() => {
            router.push(`/meeting-details?id=${result.meetingId}`);
          }, 2000);
        }
      }
    } catch (error) {
      toast.error('Failed to recover meeting', {
        description: error instanceof Error ? error.message : 'Unknown error occurred',
      });
      throw error;
    }
  };

  // Handle dialog close - clear session flag if no meetings left
  const handleDialogClose = () => {
    setShowRecoveryDialog(false);
    // If user closes dialog and there are no more meetings, clear the flag
    // This allows the dialog to show again next session if new meetings appear
    if (recoverableMeetings.length === 0) {
      sessionStorage.removeItem('recovery_dialog_shown');
    }
  };

  useEffect(() => {
    if (recordingState.isRecording) {
      const interval = setInterval(() => {
        setBarHeights(prev => {
          const newHeights = [...prev];
          newHeights[0] = Math.random() * 20 + 10 + 'px';
          newHeights[1] = Math.random() * 20 + 10 + 'px';
          newHeights[2] = Math.random() * 20 + 10 + 'px';
          return newHeights;
        });
      }, 300);

      return () => clearInterval(interval);
    }
  }, [recordingState.isRecording]);

  // Computed values using global status
  const isProcessingStop = status === RecordingStatus.PROCESSING_TRANSCRIPTS || isProcessing;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="flex flex-col h-screen bg-[var(--app-bg)]"
    >
      <RecallBanner />
      {/* All Modals supported*/}
      <SettingsModals
        modals={modals}
        messages={messages}
        onClose={hideModal}
      />

      {/* Recovery Dialog */}
      <TranscriptRecovery
        isOpen={showRecoveryDialog}
        onClose={handleDialogClose}
        recoverableMeetings={recoverableMeetings}
        onRecover={handleRecovery}
        onDelete={deleteRecoverableMeeting}
        onLoadPreview={loadMeetingTranscripts}
      />
      <div className="flex flex-col flex-1 overflow-hidden">

        {/* ── Header bar: recording controls ── */}
        {(hasMicrophone || isRecording) &&
          status !== RecordingStatus.PROCESSING_TRANSCRIPTS &&
          status !== RecordingStatus.SAVING && (
            <div
              className="flex-shrink-0 flex items-center px-4 gap-3"
              style={{ height: 54, borderBottom: '1px solid var(--separator)', background: 'var(--panel-bg)' }}
            >
              {/* Meeting title */}
              <p className="flex-1 min-w-0 text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                {meetingTitle || 'Recording'}
              </p>
              {/* Controls pill */}
              <div className="pill-glass rounded-full shadow-sm flex-shrink-0">
                <RecordingControls
                  isRecording={recordingState.isRecording}
                  onRecordingStop={(callApi = true) => handleRecordingStop(callApi)}
                  onRecordingStart={handleRecordingStart}
                  onTranscriptReceived={() => {}}
                  onStopInitiated={() => setIsStopping(true)}
                  barHeights={barHeights}
                  onTranscriptionError={(message) => showModal('errorAlert', message)}
                  isRecordingDisabled={isRecordingDisabled}
                  isParentProcessing={isProcessingStop}
                  selectedDevices={selectedDevices}
                  meetingName={meetingTitle}
                />
              </div>
            </div>
          )}

        {/* Calendar auto-split banner */}
        {recordingState.isRecording && (
          <CalendarSplitBanner
            state={calendarState}
            onSplitNow={handleCalendarSplitNow}
            onKeepRecording={handleKeepRecording}
          />
        )}

        {/* ── Top zone: Genie Live (full width, dominant) ── */}
        <div className="flex-1 overflow-hidden min-h-0">
          <CopilotSidebar
            meetingId={currentMeetingId}
            isRecording={recordingState.isRecording}
            isEnabled={copilotEnabled}
            geniePaused={geniePaused}
            onToggleGeniePause={() => setGeniePaused(p => !p)}
          />
        </div>

        {/* ── Bottom strip: Transcript (left, dim) + Screenshots (right) ── */}
        <div
          className="flex flex-shrink-0 overflow-hidden"
          style={{ height: 240, borderTop: '1px solid var(--separator)' }}
        >
          {/* Transcript — low opacity, auto-scrolling */}
          <div className="flex-1 overflow-hidden min-w-0" style={{ opacity: 0.55, borderRight: '1px solid var(--separator)' }}>
            <TranscriptPanel
              isProcessingStop={isProcessingStop}
              isStopping={isStopping}
              showModal={showModal}
              stripMode
            />
          </div>

          {/* Screenshots */}
          <AttachmentsPanel
            meetingId={currentMeetingId}
            isRecording={recordingState.isRecording}
            width={220}
          />
        </div>

        {/* Status Overlays */}
        <StatusOverlays
          isProcessing={status === RecordingStatus.PROCESSING_TRANSCRIPTS && !recordingState.isRecording}
          isSaving={status === RecordingStatus.SAVING}
          sidebarCollapsed={sidebarCollapsed}
        />
      </div>
    </motion.div>
  );
}
