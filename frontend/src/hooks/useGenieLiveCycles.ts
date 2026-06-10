'use client';

import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';

export function useGenieLiveCycles(
  isRecording: boolean,
  isPaused: boolean,
  getRecentTranscriptText: () => string,
  intervalMinutes: number = 5,
  getRecentNotes: () => string[] = () => [],
) {
  const meetingIdRef = useRef<string | null>(null);
  const cycleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const firstRunTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isPausedRef = useRef(isPaused);

  // Keep ref in sync so fireCycle always sees latest pause state without re-registering timers
  isPausedRef.current = isPaused;

  const fireCycle = async () => {
    const meetingId = meetingIdRef.current;
    if (!meetingId) return;
    if (isPausedRef.current) return; // don't fire while paused

    const transcriptChunk = getRecentTranscriptText();
    if (!transcriptChunk.trim()) return;

    const userNotes = getRecentNotes();

    fetch('http://localhost:5167/api/genie-live/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        meeting_id: meetingId,
        transcript_chunk: transcriptChunk,
        user_notes: userNotes,
      }),
    }).catch(() => {});
  };

  useEffect(() => {
    const clear = () => {
      if (cycleTimerRef.current) clearInterval(cycleTimerRef.current);
      if (firstRunTimerRef.current) clearTimeout(firstRunTimerRef.current);
      cycleTimerRef.current = null;
      firstRunTimerRef.current = null;
      meetingIdRef.current = null;
    };

    if (!isRecording) {
      clear();
      return;
    }

    invoke<string | null>('get_current_meeting_id')
      .then((id) => {
        meetingIdRef.current = id;
        if (!id) return;

        firstRunTimerRef.current = setTimeout(() => {
          fireCycle();
        }, 45_000);

        cycleTimerRef.current = setInterval(() => {
          fireCycle();
        }, intervalMinutes * 60_000);
      })
      .catch(() => {});

    return clear;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRecording, intervalMinutes]);
}
