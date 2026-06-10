'use client';

import React, { useState, useEffect, useRef } from 'react';
import { CalendarIcon, Scissors, X, Loader2 } from 'lucide-react';
import { CalendarPollingState } from '@/hooks/useCalendarPolling';

interface CalendarSplitBannerProps {
  state: CalendarPollingState;
  onSplitNow: () => Promise<void>;
  onKeepRecording: () => void;
}

/**
 * Banner shown when a calendar event ends during an active recording.
 * Displays a 3-minute countdown, a "Split Now" button, and a "Keep Recording" dismiss.
 * Automatically fires onSplitNow when the grace period expires.
 */
export default function CalendarSplitBanner({
  state,
  onSplitNow,
  onKeepRecording,
}: CalendarSplitBannerProps) {
  const [splitting, setSplitting] = useState(false);
  const autoSplitFiredRef = useRef(false);

  // Auto-split when backend triggers it (grace period expired)
  useEffect(() => {
    if (state.autoSplitTriggered && !splitting && !autoSplitFiredRef.current) {
      autoSplitFiredRef.current = true;
      setSplitting(true);
      onSplitNow().finally(() => setSplitting(false));
    }
    // Reset ref if state cleared
    if (!state.autoSplitTriggered) {
      autoSplitFiredRef.current = false;
    }
  }, [state.autoSplitTriggered, splitting, onSplitNow]);

  // Don't render if no pending split and auto-split not triggered
  if (!state.pendingSplit && !state.autoSplitTriggered) {
    return null;
  }

  const mins = Math.floor(state.graceSecondsRemaining / 60);
  const secs = state.graceSecondsRemaining % 60;
  const countdownStr = `${mins}:${secs.toString().padStart(2, '0')}`;

  const handleSplitNow = async () => {
    if (splitting) return;
    setSplitting(true);
    try {
      await onSplitNow();
    } finally {
      setSplitting(false);
    }
  };

  return (
    <div
      className="rounded-lg p-3 mx-4 my-2"
      style={{ background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.35)', boxShadow: 'var(--hint-shadow)' }}
    >
      <div className="flex items-start gap-3">
        <CalendarIcon className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: '#D97706' }} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium" style={{ color: '#D97706' }}>
            Meeting{' '}
            {state.pendingEventTitle && (
              <strong>&ldquo;{state.pendingEventTitle}&rdquo;</strong>
            )}{' '}
            has ended.
            {state.nextEventTitle && (
              <span className="font-normal">
                {' '}
                Next: <strong>{state.nextEventTitle}</strong>
              </span>
            )}
          </p>
          <p className="text-xs mt-0.5" style={{ color: '#D97706', opacity: 0.85 }}>
            {state.graceSecondsRemaining > 0
              ? `Auto-splitting in ${countdownStr} — or split now to start the next meeting.`
              : 'Splitting now...'}
          </p>
          <div className="flex gap-2 mt-2">
            <button
              onClick={handleSplitNow}
              disabled={splitting}
              className="px-3 py-1 text-xs text-white rounded-md disabled:opacity-50 flex items-center gap-1 transition-opacity hover:opacity-90"
              style={{ background: '#D97706' }}
            >
              {splitting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Scissors className="w-3 h-3" />}
              {splitting ? 'Splitting...' : 'Split Now'}
            </button>
            <button
              onClick={onKeepRecording}
              disabled={splitting}
              className="px-3 py-1 text-xs rounded-md disabled:opacity-50 flex items-center gap-1 transition-opacity hover:opacity-80"
              style={{ border: '1px solid rgba(245,158,11,0.5)', color: '#D97706' }}
            >
              <X className="w-3 h-3" />
              Keep Recording
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
