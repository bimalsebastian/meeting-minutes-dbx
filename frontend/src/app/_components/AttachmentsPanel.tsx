'use client';

import { useState, useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { convertFileSrc } from '@tauri-apps/api/core';

interface Attachment {
  attachment_id: string;
  meeting_id: string;
  timestamp: number;
  file_path: string;
  created_at: string;
}

interface AttachmentsPanelProps {
  meetingId: string | null;
  isRecording: boolean;
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function AttachmentsPanel({ meetingId, isRecording }: AttachmentsPanelProps) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  // Fetch existing attachments when meetingId changes
  useEffect(() => {
    if (!meetingId) {
      setAttachments([]);
      return;
    }

    const fetchAttachments = async () => {
      try {
        const res = await fetch(
          `http://localhost:5167/api/meetings/${meetingId}/attachments`
        );
        if (res.ok) {
          const data = await res.json();
          // Backend returns {id, meeting_id, ...} but we normalise to attachment_id
          setAttachments(
            (data as Array<Record<string, unknown>>).map((item) => ({
              attachment_id: item.id as string,
              meeting_id: item.meeting_id as string,
              timestamp: item.timestamp as number,
              file_path: item.file_path as string,
              created_at: item.created_at as string,
            }))
          );
        }
      } catch (err) {
        console.warn('Failed to fetch attachments:', err);
      }
    };

    fetchAttachments();
  }, [meetingId]);

  // Listen for real-time attachment events from Tauri
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setup = async () => {
      unlisten = await listen<Attachment>('attachment-captured', (event) => {
        setAttachments((prev) => [...prev, event.payload]);
      });
    };

    setup();

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const handleDelete = async (attachmentId: string, meetingId: string) => {
    try {
      const res = await fetch(
        `http://localhost:5167/api/meetings/${meetingId}/attachments/${attachmentId}`,
        { method: 'DELETE' }
      );
      if (res.ok) {
        setAttachments((prev) =>
          prev.filter((a) => a.attachment_id !== attachmentId)
        );
      }
    } catch (err) {
      console.warn('Failed to delete attachment:', err);
    }
  };

  return (
    <div className="w-72 flex-shrink-0 border-l border-gray-200 bg-white overflow-y-auto p-3">
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
        Screenshots
      </h3>

      {attachments.length === 0 && !isRecording && (
        <p className="text-xs text-gray-400 text-center mt-4">
          No screenshots captured
        </p>
      )}

      {attachments.length === 0 && isRecording && (
        <p className="text-xs text-gray-400 text-center mt-4">
          Screenshots copied to clipboard will appear here
        </p>
      )}

      {attachments.map((att) => (
        <div
          key={att.attachment_id}
          className="relative mb-3 rounded-lg overflow-hidden border border-gray-100"
        >
          <img
            src={convertFileSrc(att.file_path)}
            alt={`Screenshot at ${formatTimestamp(att.timestamp)}`}
            className="w-full object-contain max-h-48"
          />
          {/* Bottom overlay bar */}
          <div className="flex items-center justify-between bg-black bg-opacity-50 px-2 py-1">
            <span className="text-xs text-white font-mono">
              {formatTimestamp(att.timestamp)}
            </span>
            <button
              onClick={() => handleDelete(att.attachment_id, att.meeting_id)}
              className="text-white text-xs hover:text-red-300 transition-colors ml-2"
              title="Remove screenshot"
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
