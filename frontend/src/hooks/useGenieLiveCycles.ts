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
  const intervalMinutesRef = useRef(intervalMinutes);

  // Keep refs in sync on every render without triggering effect re-runs
  isPausedRef.current = isPaused;
  intervalMinutesRef.current = intervalMinutes;

  const fireCycle = async () => {
    const meetingId = meetingIdRef.current;
    if (!meetingId) return;
    if (isPausedRef.current) return;

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

  // Effect 1: manage timer lifecycle tied to recording state only.
  // intervalMinutes is intentionally NOT a dep — use intervalMinutesRef so
  // a settings change never tears down and re-creates the timers mid-recording.
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
        }, intervalMinutesRef.current * 60_000);
      })
      .catch(() => {});

    return clear;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRecording]);

  // Effect 2: when interval changes mid-recording, reschedule the repeating
  // timer without touching the first-run timeout or the meeting ID.
  useEffect(() => {
    if (!isRecording || !cycleTimerRef.current) return;
    clearInterval(cycleTimerRef.current);
    cycleTimerRef.current = setInterval(() => {
      fireCycle();
    }, intervalMinutes * 60_000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMinutes]);
}
