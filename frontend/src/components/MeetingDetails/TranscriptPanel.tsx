"use client";

import { Transcript, TranscriptSegmentData } from '@/types';
import { VirtualizedTranscriptView } from '@/components/VirtualizedTranscriptView';
import { TranscriptButtonGroup } from './TranscriptButtonGroup';
import { useMemo, useState, useEffect } from 'react';

interface MeetingNote {
  id: string;
  text: string;
  created_at: string;
  wall_clock_time?: string;
}

interface TranscriptPanelProps {
  meetingId?: string;
  meetingCreatedAt?: string;
  transcripts: Transcript[];
  customPrompt: string;
  onPromptChange: (value: string) => void;
  onCopyTranscript: () => void;
  onOpenMeetingFolder: () => Promise<void>;
  isRecording: boolean;
  disableAutoScroll?: boolean;

  // Optional pagination props (when using virtualization)
  usePagination?: boolean;
  segments?: TranscriptSegmentData[];
  hasMore?: boolean;
  isLoadingMore?: boolean;
  totalCount?: number;
  loadedCount?: number;
  onLoadMore?: () => void;
}

function formatTs(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function TranscriptPanel({
  meetingId,
  meetingCreatedAt,
  transcripts,
  customPrompt,
  onPromptChange,
  onCopyTranscript,
  onOpenMeetingFolder,
  isRecording,
  disableAutoScroll = false,
  usePagination = false,
  segments,
  hasMore,
  isLoadingMore,
  totalCount,
  loadedCount,
  onLoadMore,
}: TranscriptPanelProps) {
  const [notes, setNotes] = useState<MeetingNote[]>([]);

  useEffect(() => {
    if (!meetingId || isRecording) return;
    fetch(`http://localhost:5167/api/meetings/${meetingId}/notes`)
      .then(r => r.ok ? r.json() : { notes: [] })
      .then(d => setNotes(d.notes ?? []))
      .catch(() => {});
  }, [meetingId, isRecording]);

  const convertedSegments = useMemo(() => {
    if (usePagination && segments) return segments;
    return transcripts.map(t => ({
      id: t.id,
      timestamp: t.audio_start_time ?? 0,
      endTime: t.audio_end_time,
      text: t.text,
      confidence: t.confidence,
    }));
  }, [transcripts, usePagination, segments]);

  // Build a merged, time-sorted list of transcript segments + notes for inline display
  const notesByAudioSecs = useMemo(() => {
    if (!notes.length) return new Map<number, MeetingNote[]>();
    const meetingStartMs = meetingCreatedAt ? new Date(meetingCreatedAt).getTime() : 0;
    const map = new Map<number, MeetingNote[]>();
    notes.forEach(n => {
      const audioSecs = meetingStartMs > 0
        ? Math.max(0, Math.round((new Date(n.created_at).getTime() - meetingStartMs) / 1000))
        : 0;
      const existing = map.get(audioSecs) ?? [];
      map.set(audioSecs, [...existing, n]);
    });
    return map;
  }, [notes, meetingCreatedAt]);

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full bg-[var(--panel-bg)]">
      {/* Title area */}
      <div className="p-4" style={{ borderBottom: '1px solid var(--separator)' }}>
        <TranscriptButtonGroup
          transcriptCount={usePagination ? (totalCount ?? convertedSegments.length) : (transcripts?.length || 0)}
          onCopyTranscript={onCopyTranscript}
          onOpenMeetingFolder={onOpenMeetingFolder}
        />
      </div>

      {/* Transcript + notes content */}
      {notes.length > 0 ? (
        // Custom renderer when notes exist — interleaves notes with transcript segments
        <div className="flex-1 overflow-y-auto custom-scrollbar px-4 py-3" style={{ minHeight: 0 }}>
          {convertedSegments.length === 0 && notes.length === 0 && (
            <p className="text-xs text-center mt-8" style={{ color: 'var(--text-tertiary)' }}>No transcript yet</p>
          )}
          {(() => {
            type Item =
              | { kind: 'seg'; seg: TranscriptSegmentData }
              | { kind: 'note'; note: MeetingNote; audioSecs: number };

            const meetingStartMs = meetingCreatedAt ? new Date(meetingCreatedAt).getTime() : 0;
            const noteItems: Item[] = notes.map(n => ({
              kind: 'note',
              note: n,
              audioSecs: meetingStartMs > 0
                ? Math.max(0, (new Date(n.created_at).getTime() - meetingStartMs) / 1000)
                : 0,
            }));
            const segItems: Item[] = convertedSegments.map(seg => ({ kind: 'seg', seg }));
            const all = [...segItems, ...noteItems].sort((a, b) => {
              const ta = a.kind === 'seg' ? a.seg.timestamp : a.audioSecs;
              const tb = b.kind === 'seg' ? b.seg.timestamp : b.audioSecs;
              return ta - tb;
            });

            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {all.map(item =>
                  item.kind === 'seg' ? (
                    <div key={item.seg.id} className="flex gap-2 items-start">
                      <span className="flex-shrink-0 font-mono" style={{ fontSize: 11, color: 'var(--text-tertiary)', minWidth: 36, paddingTop: 2 }}>
                        {formatTs(item.seg.timestamp)}
                      </span>
                      <p style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text-primary)', flex: 1 }}>{item.seg.text}</p>
                    </div>
                  ) : (
                    <div
                      key={item.note.id}
                      className="flex gap-2 items-start rounded-lg px-2 py-1.5 my-0.5"
                      style={{
                        background: 'var(--note-bg)',
                        border: '1px solid color-mix(in srgb, var(--note-border) 35%, transparent)',
                      }}
                    >
                      <span style={{ fontSize: 13, flexShrink: 0, paddingTop: 1 }}>📝</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="flex items-center gap-2 mb-0.5">
                          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--note-border)' }}>Your note</span>
                          {item.note.wall_clock_time && (
                            <span className="font-mono" style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>
                              {item.note.wall_clock_time}
                            </span>
                          )}
                        </div>
                        <p style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text-primary)' }}>{item.note.text}</p>
                      </div>
                    </div>
                  )
                )}
              </div>
            );
          })()}
        </div>
      ) : (
        <div className="flex-1 overflow-hidden pb-4">
          <VirtualizedTranscriptView
            segments={convertedSegments}
            isRecording={isRecording}
            isPaused={false}
            isProcessing={false}
            isStopping={false}
            enableStreaming={false}
            showConfidence={true}
            disableAutoScroll={disableAutoScroll}
            hasMore={hasMore}
            isLoadingMore={isLoadingMore}
            totalCount={totalCount}
            loadedCount={loadedCount}
            onLoadMore={onLoadMore}
          />
        </div>
      )}

      {/* Custom prompt input at bottom */}
      {!isRecording && convertedSegments.length > 0 && (
        <div className="p-1" style={{ borderTop: '1px solid var(--separator)' }}>
          <textarea
            placeholder="Add context for AI summary. For example people involved, meeting overview, objective etc..."
            className="w-full px-3 py-2 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-[var(--accent-hex)] shadow-sm min-h-[80px] resize-y bg-[var(--panel-elevated)]"
            style={{ border: '1px solid var(--separator)', color: 'var(--text-primary)' }}
            value={customPrompt}
            onChange={(e) => onPromptChange(e.target.value)}
          />
        </div>
      )}
    </div>
  );
}
