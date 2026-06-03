import { useState, useEffect } from 'react';

export interface CalendarPollingState {
  pendingSplit: boolean;
  pendingEventTitle: string | null;
  nextEventTitle: string | null;
  nextEventId: string | null;
  graceSecondsRemaining: number;
  autoSplitTriggered: boolean;
  connected: boolean;
}

/**
 * Polls the backend calendar status endpoint every 10 seconds.
 * Returns the current calendar split state for use in CalendarSplitBanner.
 */
export function useCalendarPolling(): CalendarPollingState {
  const [state, setState] = useState<CalendarPollingState>({
    pendingSplit: false,
    pendingEventTitle: null,
    nextEventTitle: null,
    nextEventId: null,
    graceSecondsRemaining: 180,
    autoSplitTriggered: false,
    connected: false,
  });

  useEffect(() => {
    const poll = async () => {
      try {
        const r = await fetch('http://localhost:5167/api/calendar/status');
        if (!r.ok) return;
        const d = await r.json();
        setState({
          pendingSplit: d.pending_split ?? false,
          pendingEventTitle: d.pending_event_title ?? null,
          nextEventTitle: d.next_event_title ?? null,
          nextEventId: d.next_event_id ?? null,
          graceSecondsRemaining: d.grace_seconds_remaining ?? 180,
          autoSplitTriggered: d.auto_split_triggered ?? false,
          connected: d.connected ?? false,
        });
      } catch {
        // Backend not available — silent fail
      }
    };

    poll();
    const id = setInterval(poll, 10000);
    return () => clearInterval(id);
  }, []);

  return state;
}
