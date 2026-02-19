/**
 * Google Calendar integration for auto-start: OAuth and upcoming meetings.
 * Uses Stronghold for secure token storage.
 */

import { invoke } from '@tauri-apps/api/core';
import { secureStore, secureRetrieve, secureDelete } from '@/lib/stronghold';

const STORAGE_KEYS = {
  tokenSet: 'google_calendar_token_set',
  pkceVerifier: 'google_calendar_pkce_verifier',
  pkceState: 'google_calendar_pkce_state',
} as const;

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';

/** Stored token set (access_token, refresh_token, expires_at ms). */
export interface GoogleTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/** Upcoming calendar event with a conferencing link. */
export interface UpcomingMeeting {
  id: string;
  summary: string;
  start: string; // ISO
  end: string;
  hangoutLink?: string;
  conferenceLink?: string;
}

/** Config for Google OAuth (client ID from Google Cloud Console). */
export interface GoogleCalendarConfig {
  clientId: string;
  redirectUri: string;
  /** Optional; required for refresh in installed apps if no secret. */
  clientSecret?: string;
}

function generateRandomString(length: number = 43): string {
  const array = new Uint8Array(length);
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(array);
  } else {
    for (let i = 0; i < length; i++) array[i] = Math.floor(Math.random() * 256);
  }
  const base64 = btoa(String.fromCharCode(...array));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, length);
}

const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

async function getStoredTokenSet(): Promise<GoogleTokenSet | null> {
  try {
    const raw = await secureRetrieve(STORAGE_KEYS.tokenSet);
    if (!raw) return null; // Handle null from secureRetrieve
    const data = JSON.parse(raw) as GoogleTokenSet;
    if (data?.accessToken && data?.refreshToken != null && typeof data?.expiresAt === 'number') return data;
  } catch {
    // ignore
  }
  return null;
}

async function persistTokenSet(tokenSet: GoogleTokenSet): Promise<void> {
  await secureStore(STORAGE_KEYS.tokenSet, JSON.stringify(tokenSet));
}

/**
 * Start Google Calendar OAuth: open browser; handle callback with exchangeGoogleCalendarCode().
 */
export async function authorizeGoogleCalendar(config: GoogleCalendarConfig): Promise<void> {
  const verifier = generateRandomString(43);
  const state = generateRandomString(32);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: CALENDAR_SCOPE,
    state,
    code_challenge: await sha256Base64Url(verifier),
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  });
  await secureStore(STORAGE_KEYS.pkceVerifier, verifier);
  await secureStore(STORAGE_KEYS.pkceState, state);
  const url = `${GOOGLE_AUTH_URL}?${params.toString()}`;
  await invoke('open_external_url', { url });
}

async function sha256Base64Url(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const hash = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(input));
  const base64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Exchange authorization code for tokens. Call after redirect with code and state.
 */
export async function exchangeGoogleCalendarCode(
  code: string,
  stateFromRedirect: string | undefined,
  config: GoogleCalendarConfig
): Promise<GoogleTokenSet> {
  const [storedVerifier, storedState] = await Promise.all([
    secureRetrieve(STORAGE_KEYS.pkceVerifier),
    secureRetrieve(STORAGE_KEYS.pkceState),
  ]).catch(() => ['', '']);
  if (!storedVerifier || !storedState) throw new Error('No PKCE state. Call authorizeGoogleCalendar() first.');
  if (stateFromRedirect !== undefined && stateFromRedirect !== storedState) throw new Error('State mismatch.');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    code_verifier: storedVerifier,
  });
  if (config.clientSecret) body.set('client_secret', config.clientSecret);
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = `Token failed: ${res.status}`;
    try {
      const j = JSON.parse(text) as { error_description?: string };
      if (j.error_description) msg = j.error_description;
    } catch {
      if (text) msg += ` ${text}`;
    }
    throw new Error(msg);
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  const expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
  const tokenSet: GoogleTokenSet = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? (await getStoredTokenSet())?.refreshToken ?? '',
    expiresAt,
  };
  await secureDelete(STORAGE_KEYS.pkceVerifier);
  await secureDelete(STORAGE_KEYS.pkceState);
  await persistTokenSet(tokenSet);
  return tokenSet;
}

async function getValidAccessToken(config: GoogleCalendarConfig): Promise<string> {
  let tokenSet = await getStoredTokenSet();
  if (!tokenSet) throw new Error('Not signed in to Google Calendar. Authorize in settings.');
  if (tokenSet.expiresAt - REFRESH_THRESHOLD_MS <= Date.now() && tokenSet.refreshToken) {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokenSet.refreshToken,
      client_id: config.clientId,
    });
    if (config.clientSecret) body.set('client_secret', config.clientSecret);
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) throw new Error('Failed to refresh Google token');
    const data = (await res.json()) as { access_token: string; expires_in: number };
    tokenSet = {
      ...tokenSet,
      accessToken: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
    await persistTokenSet(tokenSet);
  }
  return tokenSet.accessToken;
}

/**
 * Fetch calendar events that start in the next 10 minutes and have a conferencing link.
 * Requires Google Calendar to be authorized (authorizeGoogleCalendar + exchangeGoogleCalendarCode).
 */
export async function checkUpcomingMeetings(config: GoogleCalendarConfig): Promise<UpcomingMeeting[]> {
  const token = await getValidAccessToken(config);
  const now = new Date();
  const timeMin = now.toISOString();
  const tenMins = new Date(now.getTime() + 10 * 60 * 1000);
  const timeMax = tenMins.toISOString();
  const url = `${CALENDAR_API_BASE}/calendars/primary/events?` + new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: 'true',
    orderBy: 'startTime',
  }).toString();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Calendar API error: ${res.status}`);
  const data = (await res.json()) as {
    items?: Array<{
      id?: string;
      summary?: string;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
      hangoutLink?: string;
      conferenceData?: { entryPoints?: Array<{ uri?: string }> };
    }>;
  };
  const meetings: UpcomingMeeting[] = [];
  for (const item of data.items ?? []) {
    const link = item.hangoutLink ?? item.conferenceData?.entryPoints?.[0]?.uri;
    if (!link) continue;
    const start = item.start?.dateTime ?? item.start?.date ?? '';
    const end = item.end?.dateTime ?? item.end?.date ?? '';
    if (!item.id || !start) continue;
    meetings.push({
      id: item.id,
      summary: item.summary ?? 'Meeting',
      start,
      end,
      hangoutLink: item.hangoutLink,
      conferenceLink: item.conferenceData?.entryPoints?.[0]?.uri,
    });
  }
  return meetings;
}

/** Clear stored Google Calendar tokens (sign out). */
export async function clearGoogleCalendarTokens(): Promise<void> {
  try {
    await secureDelete(STORAGE_KEYS.tokenSet);
  } catch {
    // ignore
  }
}
