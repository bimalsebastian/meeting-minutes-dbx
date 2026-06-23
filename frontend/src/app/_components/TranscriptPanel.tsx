import { VirtualizedTranscriptView } from '@/components/VirtualizedTranscriptView';
import { PermissionWarning } from '@/components/PermissionWarning';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Copy, GlobeIcon } from 'lucide-react';
import { useTranscripts, UserNote } from '@/contexts/TranscriptContext';
import { useConfig } from '@/contexts/ConfigContext';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { usePermissionCheck } from '@/hooks/usePermissionCheck';
import { ModalType } from '@/hooks/useModalState';
import { useIsLinux } from '@/hooks/usePlatform';
import { useMemo, useState, useRef, useCallback, KeyboardEvent } from 'react';

interface TranscriptPanelProps {
  isProcessingStop: boolean;
  isStopping: boolean;
  showModal: (name: ModalType, message?: string) => void;
  /** Strip mode: compact header, no past-notes list, single-row note input */
  stripMode?: boolean;
}

export function TranscriptPanel({
  isProcessingStop,
  isStopping,
  showModal,
  stripMode = false,
}: TranscriptPanelProps) {
  const { transcripts, transcriptContainerRef, copyTranscript, userNotes, addUserNote } = useTranscripts();
  const { transcriptModelConfig } = useConfig();
  const { isRecording, isPaused } = useRecordingState();
  const { checkPermissions, isChecking, hasSystemAudio, hasMicrophone } = usePermissionCheck();
  const isLinux = useIsLinux();

  const [noteText, setNoteText] = useState('');
  const noteInputRef = useRef<HTMLTextAreaElement>(null);

  const submitNote = useCallback(() => {
    const trimmed = noteText.trim();
    if (!trimmed) return;
    addUserNote(trimmed);
    setNoteText('');
    // Reset textarea height
    if (noteInputRef.current) {
      noteInputRef.current.style.height = 'auto';
      noteInputRef.current.focus();
    }
  }, [noteText, addUserNote]);

  const handleNoteKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitNote();
    }
  }, [submitNote]);

  const segments = useMemo(() =>
    transcripts.map(t => ({
      id: t.id,
      timestamp: t.audio_start_time ?? 0,
      endTime: t.audio_end_time,
      text: t.text,
      confidence: t.confidence,
    })),
    [transcripts]
  );

  // ── Strip mode: compact layout for bottom bar ──────────────────────────────
  if (stripMode) {
    return (
      <div className="flex-1 min-w-0 flex flex-col bg-[var(--panel-bg)] overflow-hidden h-full">
        {/* Transcript + notes scroll — fills most of strip */}
        <div ref={transcriptContainerRef} className="flex-1 overflow-y-auto min-h-0 px-3 py-2">
          <VirtualizedTranscriptView
            segments={segments}
            isRecording={isRecording}
            isPaused={isPaused}
            isProcessing={isProcessingStop}
            isStopping={isStopping}
            enableStreaming={isRecording}
            showConfidence={false}
            hideStatusBar={true}
            compact={true}
          />
          {/* User notes shown below transcript in strip mode */}
          {userNotes.length > 0 && (
            <div className="flex flex-col gap-1 mt-1">
              {userNotes.map(note => (
                <div
                  key={note.id}
                  className="flex items-start gap-1.5 rounded-lg px-2 py-1"
                  style={{
                    background: 'var(--note-bg)',
                    border: '1px solid color-mix(in srgb, var(--note-border) 35%, transparent)',
                  }}
                >
                  <span style={{ fontSize: 11, flexShrink: 0 }}>📝</span>
                  <span className="font-mono flex-shrink-0" style={{ fontSize: 10, color: 'var(--text-tertiary)', paddingTop: 1 }}>
                    {note.wallClockTime}
                  </span>
                  <p style={{ fontSize: 11, lineHeight: 1.4, color: 'var(--text-primary)', flex: 1 }}>{note.text}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Compact single-row note input */}
        {isRecording && (
          <div
            className="flex-shrink-0 flex items-center gap-2 px-3 py-2"
            style={{ borderTop: '1px solid var(--separator)', background: 'var(--panel-bg)' }}
          >
            <span className="text-amber-500 text-xs flex-shrink-0 select-none">📝</span>
            <input
              value={noteText}
              onChange={e => setNoteText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submitNote(); } }}
              placeholder="Add a note… (Enter to save)"
              className="flex-1 bg-transparent text-xs outline-none"
              style={{
                color: 'var(--text-primary)',
                background: 'var(--note-bg)',
                border: '1px solid color-mix(in srgb, var(--note-border) 40%, transparent)',
                borderRadius: 8, padding: '4px 8px',
              }}
            />
            <button
              onClick={submitNote}
              disabled={!noteText.trim()}
              className="flex-shrink-0 px-2 py-1 text-xs font-medium rounded-lg transition-opacity disabled:opacity-30"
              style={{ background: 'var(--accent-hex)', color: '#fff' }}
            >
              Save
            </button>
          </div>
        )}
      </div>
    );
  }

  // ── Full mode: original layout ──────────────────────────────────────────────
  return (
    <div
      className="flex-1 min-w-0 flex flex-col bg-[var(--panel-bg)] overflow-hidden"
      style={{ borderRight: '1px solid var(--separator)' }}
    >
      {/* Sticky header */}
      <div className="flex-shrink-0 bg-[var(--panel-bg)] p-4" style={{ borderBottom: '1px solid var(--separator)' }}>
        <div className="flex justify-center items-center">
          <ButtonGroup>
            {transcripts?.length > 0 && (
              <Button variant="outline" size="sm" onClick={copyTranscript} title="Copy Transcript">
                <Copy /><span className="hidden md:inline">Copy</span>
              </Button>
            )}
            {transcriptModelConfig.provider === 'localWhisper' && (
              <Button variant="outline" size="sm" onClick={() => showModal('languageSettings')} title="Language">
                <GlobeIcon /><span className="hidden md:inline">Language</span>
              </Button>
            )}
          </ButtonGroup>
        </div>
      </div>

      {/* Scrollable transcript */}
      <div ref={transcriptContainerRef} className="flex-1 overflow-y-auto" style={{ paddingBottom: '1rem' }}>
        {!isRecording && !isChecking && !isLinux && (
          <div className="flex justify-center px-4 pt-4">
            <PermissionWarning hasMicrophone={hasMicrophone} hasSystemAudio={hasSystemAudio}
              onRecheck={checkPermissions} isRechecking={isChecking} />
          </div>
        )}
        <div className="flex justify-center">
          <div className="w-2/3 max-w-[750px]">
            <VirtualizedTranscriptView segments={segments} isRecording={isRecording} isPaused={isPaused}
              isProcessing={isProcessingStop} isStopping={isStopping} enableStreaming={isRecording} showConfidence={true} />
          </div>
        </div>
      </div>

      {/* Note input */}
      {isRecording && (
        <div className="flex-shrink-0 px-4 py-3" style={{ borderTop: '1px solid var(--separator)', background: 'var(--panel-bg)' }}>
          <div className="max-w-[750px] mx-auto flex flex-col gap-2">
            {userNotes.length > 0 && (
              <div className="flex flex-col gap-1.5 max-h-36 overflow-y-auto">
                {[...userNotes].reverse().map(note => <InlineNoteCard key={note.id} note={note} />)}
              </div>
            )}
            <div className="flex items-start gap-2 rounded-xl px-3 py-2 transition-all"
              style={{ background: 'var(--note-bg)', border: '1px solid color-mix(in srgb, var(--note-border) 40%, transparent)' }}>
              <span className="text-amber-500 text-sm mt-0.5 flex-shrink-0 select-none">📝</span>
              <textarea ref={noteInputRef} value={noteText} onChange={e => setNoteText(e.target.value)}
                onKeyDown={handleNoteKeyDown}
                placeholder="Add a note… (Enter to save · Shift+Enter for new line)" rows={1}
                className="flex-1 bg-transparent text-xs placeholder-amber-400 resize-none outline-none leading-relaxed"
                style={{ color: 'var(--text-primary)', minHeight: '20px', maxHeight: '96px' }}
                onInput={e => { const t = e.currentTarget; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 96) + 'px'; }} />
            </div>
            <div className="flex items-center justify-between">
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>Genie prioritises your notes</p>
              <button onClick={submitNote} disabled={!noteText.trim()}
                className="px-3 py-1.5 text-xs font-medium rounded-lg transition-opacity disabled:opacity-30"
                style={{ background: 'var(--accent-hex)', color: '#fff' }}>Save Note</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InlineNoteCard({ note }: { note: UserNote }) {
  return (
    <div
      className="border-l-4 rounded-xl px-3 py-2"
      style={{
        borderLeftColor: 'var(--note-border)',
        background: 'var(--note-bg)',
        boxShadow: 'var(--hint-shadow)',
      }}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-semibold" style={{ color: 'var(--note-border)' }}>📝 Your Note</span>
        <span className="text-xs font-mono" style={{ color: 'var(--text-secondary)' }}>{note.wallClockTime}</span>
      </div>
      <p className="text-xs leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--text-primary)' }}>{note.text}</p>
    </div>
  );
}
