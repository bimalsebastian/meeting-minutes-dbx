'use client';

import { useEffect, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useAttachments, Attachment } from '@/contexts/AttachmentsContext';

interface AttachmentsPanelProps {
  meetingId: string | null;
  isRecording: boolean;
  width?: number; // used by recording page for resizable panel
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function ImageIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2.4" />
      <circle cx="8.5" cy="9.5" r="1.6" />
      <path d="M21 16l-5-5L5 21" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
      style={{
        color: 'var(--text-secondary)',
        transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
        transition: 'transform 0.2s ease',
        flexShrink: 0,
      }}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function AttachmentsPanel({ meetingId, isRecording, width }: AttachmentsPanelProps) {
  const { attachments, loadForMeeting } = useAttachments();
  const [lightbox, setLightbox] = useState<Attachment | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);

  // Auto-load only on the summary page (no width prop = not the recording page).
  // On the recording page, screenshots arrive via attachment-captured events; loading
  // by meeting ID would pull in the *previous* session's screenshots on each new recording.
  useEffect(() => {
    if (!width && !isRecording && meetingId) {
      loadForMeeting(meetingId);
    }
  }, [width, meetingId, isRecording, loadForMeeting]);

  // Close lightbox on Escape
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightbox(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  const handleDelete = async (attachmentId: string, attMeetingId: string) => {
    try {
      await fetch(
        `http://localhost:5167/api/meetings/${attMeetingId}/attachments/${attachmentId}`,
        { method: 'DELETE' }
      );
    } catch { /* backend not running */ }
  };

  // Two visual modes:
  // - Recording page (width provided): fixed-width sidebar, no border-radius, left-border only
  // - Summary page (no width): rounded card inside a stacked column
  const outerStyle: React.CSSProperties = width
    ? { width, flexShrink: 0, borderLeft: '1px solid var(--separator)', background: 'var(--panel-bg)', display: 'flex', flexDirection: 'column', overflowY: 'auto' }
    : { background: 'var(--panel-bg)', border: '1px solid var(--separator)', borderRadius: 12, overflow: 'hidden' };

  return (
    <>
      <div style={outerStyle}>
        {/* Collapsible panel header */}
        <button
          onClick={() => setPanelOpen(v => !v)}
          className="flex items-center gap-2 px-4 py-3 w-full text-left"
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            borderBottom: panelOpen ? '1px solid var(--separator)' : 'none',
          }}
        >
          <span style={{ color: 'var(--text-secondary)', display: 'flex' }}>
            <ImageIcon />
          </span>
          <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
            Screenshots
          </span>
          {attachments.length > 0 && (
            <span
              className="text-xs font-semibold px-2 py-0.5 rounded-full"
              style={{ background: 'rgba(120,120,128,0.16)', color: 'var(--text-secondary)' }}
            >
              {attachments.length}
            </span>
          )}
          <div style={{ flex: 1 }} />
          <Chevron open={panelOpen} />
        </button>

        {panelOpen && <div className="p-3">
          {attachments.length === 0 ? (
            <div
              className="rounded-xl px-5 py-8 text-center"
              style={{ border: '1.5px dashed var(--separator-strong)' }}
            >
              <div className="flex justify-center mb-3" style={{ color: 'var(--text-tertiary)' }}>
                <ImageIcon />
              </div>
              <p className="text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                No screenshots
              </p>
              <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)', maxWidth: 300, margin: '0 auto' }}>
                {isRecording
                  ? 'Screenshots copied to clipboard during recording will appear here.'
                  : 'No screenshots were captured during this meeting.'}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2.5">
              {attachments.map(att => (
                <Thumbnail
                  key={att.attachment_id}
                  att={att}
                  onClick={() => setLightbox(att)}
                  onDelete={() => handleDelete(att.attachment_id, att.meeting_id)}
                />
              ))}
            </div>
          )}
        </div>}
      </div>

      {/* Lightbox */}
      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(12px)' }}
        >
          <div
            onClick={e => e.stopPropagation()}
            className="rounded-2xl overflow-hidden flex flex-col"
            style={{
              width: 'min(820px, 90vw)',
              boxShadow: '0 30px 80px rgba(0,0,0,0.6)',
              background: 'var(--panel-elevated)',
            }}
          >
            <img
              src={convertFileSrc(lightbox.file_path)}
              alt="Screenshot"
              className="w-full object-contain max-h-[70vh]"
            />
            <div
              className="flex items-center justify-between px-4 py-3"
              style={{ borderTop: '1px solid var(--separator)' }}
            >
              <div>
                {lightbox.timestamp > 0 && (
                  <span className="text-xs font-mono" style={{ color: 'var(--text-secondary)' }}>
                    Captured at {formatTimestamp(lightbox.timestamp)}
                  </span>
                )}
              </div>
              <button
                onClick={() => setLightbox(null)}
                className="text-xs px-3 py-1.5 rounded-lg transition-colors"
                style={{
                  background: 'rgba(120,120,128,0.16)',
                  color: 'var(--text-secondary)',
                  border: 'none', cursor: 'pointer',
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Thumbnail({ att, onClick, onDelete }: {
  att: Attachment;
  onClick: () => void;
  onDelete: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className="relative rounded-xl overflow-hidden cursor-pointer transition-all duration-150"
      style={{
        aspectRatio: '16/10',
        boxShadow: hovered
          ? `0 0 0 1.5px var(--accent-hex), 0 8px 20px rgba(0,0,0,0.25)`
          : '0 0 0 1px var(--separator)',
        transform: hovered ? 'translateY(-1px)' : 'none',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
    >
      <img
        src={convertFileSrc(att.file_path)}
        alt="Screenshot"
        className="w-full h-full object-cover"
      />
      {/* Timestamp overlay */}
      {att.timestamp > 0 && (
        <div
          className="absolute bottom-1.5 left-2 text-xs font-mono"
          style={{
            color: '#fff',
            textShadow: '0 1px 4px rgba(0,0,0,0.8)',
            pointerEvents: 'none',
          }}
        >
          {formatTimestamp(att.timestamp)}
        </div>
      )}
      {/* Delete button */}
      {hovered && (
        <button
          onClick={e => { e.stopPropagation(); onDelete(); }}
          className="absolute top-1.5 right-1.5 flex items-center justify-center rounded-md text-xs transition-colors"
          style={{
            width: 22, height: 22,
            background: 'rgba(0,0,0,0.55)',
            backdropFilter: 'blur(4px)',
            color: 'rgba(255,255,255,0.8)',
            border: 'none', cursor: 'pointer',
          }}
          title="Remove"
        >
          ×
        </button>
      )}
    </div>
  );
}
