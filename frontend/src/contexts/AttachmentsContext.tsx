'use client';

import { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';

export interface Attachment {
  attachment_id: string;
  meeting_id: string;
  timestamp: number;
  file_path: string;
  created_at: string;
}

interface AttachmentsContextType {
  attachments: Attachment[];
  loadForMeeting: (meetingId: string) => Promise<void>;
  clearAttachments: () => void;
  removeAttachment: (attachmentId: string) => void;
}

const AttachmentsContext = createContext<AttachmentsContextType>({
  attachments: [],
  loadForMeeting: async () => {},
  clearAttachments: () => {},
  removeAttachment: () => {},
});

export const useAttachments = () => useContext(AttachmentsContext);

export function AttachmentsProvider({ children }: { children: ReactNode }) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const activeMeetingIdRef = useRef<string | null>(null);

  // Listen for real-time clipboard screenshots — this listener is above the router
  // so it survives navigation between pages.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const setup = async () => {
      unlisten = await listen<Attachment>('attachment-captured', (event) => {
        setAttachments(prev => {
          const exists = prev.some(a => a.attachment_id === event.payload.attachment_id);
          return exists ? prev : [...prev, event.payload];
        });
      });
    };
    setup();
    return () => { if (unlisten) unlisten(); };
  }, []);

  const loadForMeeting = useCallback(async (meetingId: string) => {
    if (!meetingId) return;
    activeMeetingIdRef.current = meetingId;

    // Try Python backend first
    try {
      const res = await fetch(`http://localhost:5167/api/meetings/${meetingId}/attachments`);
      if (res.ok) {
        const data = await res.json() as Array<Record<string, unknown>>;
        if (data.length > 0) {
          setAttachments(data.map(item => ({
            attachment_id: item.id as string,
            meeting_id: item.meeting_id as string,
            timestamp: item.timestamp as number,
            file_path: item.file_path as string,
            created_at: item.created_at as string,
          })));
          return;
        }
      }
    } catch { /* backend not running */ }

    // Fallback: ask Rust to list files in the meeting folder
    try {
      const paths = await invoke<string[]>('list_meeting_attachments', { meetingId });
      setAttachments(paths.map(filePath => ({
        attachment_id: filePath.split('/').pop()?.replace('.png', '') ?? filePath,
        meeting_id: meetingId,
        timestamp: 0,
        file_path: filePath,
        created_at: '',
      })));
    } catch { /* ignore */ }
  }, []);

  const clearAttachments = useCallback(() => {
    activeMeetingIdRef.current = null;
    setAttachments([]);
  }, []);

  const removeAttachment = useCallback((attachmentId: string) => {
    setAttachments(prev => prev.filter(a => a.attachment_id !== attachmentId));
  }, []);

  return (
    <AttachmentsContext.Provider value={{ attachments, loadForMeeting, clearAttachments, removeAttachment }}>
      {children}
    </AttachmentsContext.Provider>
  );
}
