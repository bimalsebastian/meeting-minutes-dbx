/**
 * Detects when a meeting app (Zoom, Teams, Google Meet) is the active window via Tauri.
 * Used with Google Calendar to auto-start Meetily recording when a meeting is about to start.
 */

import { invoke } from '@tauri-apps/api/core';

/** Known meeting app window title patterns (case-insensitive). */
const MEETING_APP_PATTERNS = [
  { name: 'Zoom', patterns: ['zoom', 'zoom meeting'] },
  { name: 'Microsoft Teams', patterns: ['microsoft teams', 'teams meeting'] },
  { name: 'Google Meet', patterns: ['google meet', 'meet - ', 'meet.google.com'] },
  { name: 'Webex', patterns: ['webex'] },
  { name: 'GoToMeeting', patterns: ['gotomeeting'] },
] as const;

export interface MeetingAppDetection {
  isMeetingApp: boolean;
  appName: string | null;
  windowTitle: string;
}

/**
 * Get the current active window title from the OS (via Tauri).
 * Returns empty string if unsupported or on error.
 */
export async function getActiveWindowTitle(): Promise<string> {
  try {
    const title = await invoke<string>('get_active_window_title');
    return title ?? '';
  } catch {
    return '';
  }
}

/**
 * Check if the active window is a known meeting app (Zoom, Teams, Meet, etc.).
 */
export async function detectMeetingApp(): Promise<MeetingAppDetection> {
  const windowTitle = await getActiveWindowTitle();
  const lower = windowTitle.toLowerCase();
  for (const { name, patterns } of MEETING_APP_PATTERNS) {
    if (patterns.some((p) => lower.includes(p))) {
      return { isMeetingApp: true, appName: name, windowTitle };
    }
  }
  return { isMeetingApp: false, appName: null, windowTitle };
}

/**
 * Start polling for meeting app activity and invoke the callback when a meeting app becomes active.
 * Returns a stop function.
 */
export function startMeetingDetector(
  onMeetingAppActive: (detection: MeetingAppDetection) => void,
  pollIntervalMs: number = 5000
): () => void {
  let stopped = false;
  let lastWasMeeting = false;

  const poll = async () => {
    if (stopped) return;
    const detection = await detectMeetingApp();
    if (detection.isMeetingApp && !lastWasMeeting) {
      lastWasMeeting = true;
      onMeetingAppActive(detection);
    } else if (!detection.isMeetingApp) {
      lastWasMeeting = false;
    }
    if (!stopped) setTimeout(poll, pollIntervalMs);
  };

  poll();

  return () => {
    stopped = true;
  };
}
