/**
 * Databricks Model Serving client using Azure CLI authentication.
 * Token is obtained via invoke('get_databricks_token') and stored in keychain.
 * Auto-refreshes on 401 by calling get_databricks_token again.
 */

import { invoke } from '@tauri-apps/api/core';
import {
  secureRetrieve,
  secureStoreWithExpiry,
  getTokenExpiry,
} from '@/lib/stronghold';

const STORAGE_KEY_TOKEN = 'databricks_token';

/** Thrown when the API returns 401; caller should prompt re-authentication. */
export class DatabricksAuthError extends Error {
  readonly status = 401;

  constructor(message: string = 'Databricks authentication expired or invalid. Sign in again via Azure CLI.') {
    super(message);
    this.name = 'DatabricksAuthError';
    Object.setPrototypeOf(this, DatabricksAuthError.prototype);
  }
}

/** Thrown when the serving endpoint returns an error (4xx/5xx or error payload). */
export class DatabricksApiError extends Error {
  readonly status: number;
  readonly errorCode?: string;

  constructor(message: string, status: number, errorCode?: string) {
    super(message);
    this.name = 'DatabricksApiError';
    this.status = status;
    this.errorCode = errorCode;
    Object.setPrototypeOf(this, DatabricksApiError.prototype);
  }
}

const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant that summarizes meeting transcripts. Produce a clear, concise summary with key points and action items when relevant.';

/** Buffer before expiry to trigger refresh (5 minutes). */
const EXPIRY_BUFFER_SECONDS = 300;
/** Default token lifetime when storing (1 hour). */
const DEFAULT_TOKEN_EXPIRY_SECONDS = 3600;
/** Background refresh interval (30 minutes). */
const BACKGROUND_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Get a valid Databricks token.
 *
 * Auth method priority:
 * 1. If a Databricks CLI profile is stored (`databricks_cli_profile`), call
 *    `get_databricks_cli_token(profile)` — works for both PAT and OAuth profiles,
 *    no Azure CLI dependency.
 * 2. Otherwise fall back to the existing Azure CLI flow (`az account get-access-token`).
 *
 * For PAT profiles the token never expires so it is returned as-is (no Stronghold needed).
 * For OAuth CLI profiles the Databricks CLI handles its own refresh silently.
 */
export async function getValidDatabricksToken(): Promise<string> {
  try {
    // ── Path 1: Databricks CLI profile ──────────────────────────────────────
    const cliProfile = await secureRetrieve('databricks_cli_profile');
    if (cliProfile?.trim()) {
      try {
        const token = await invoke<string>('get_databricks_cli_token', {
          profile: cliProfile.trim(),
        });
        if (token?.trim()) return token.trim();
      } catch (cliErr) {
        // CLI token failed — fall through to Azure CLI path
        console.warn('[Databricks] CLI profile token failed, trying Azure CLI:', cliErr);
      }
    }

    // ── Path 2: Azure CLI (existing flow) ────────────────────────────────────
    const stored = await secureRetrieve(STORAGE_KEY_TOKEN);
    if (stored?.trim()) {
      const tokenExpiry = await getTokenExpiry(STORAGE_KEY_TOKEN);
      const now = Date.now() / 1000;
      if (tokenExpiry > now + EXPIRY_BUFFER_SECONDS) return stored.trim();
      if (tokenExpiry === 0) return stored.trim();
    }
    const token = await invoke<string>('get_databricks_token');
    if (!token?.trim()) {
      throw new DatabricksAuthError('Failed to obtain token from Azure CLI');
    }
    await secureStoreWithExpiry(STORAGE_KEY_TOKEN, token.trim(), DEFAULT_TOKEN_EXPIRY_SECONDS);
    return token.trim();
  } catch (error) {
    if (error instanceof DatabricksAuthError) throw error;
    throw new DatabricksAuthError(
      'Failed to obtain Databricks token. Sign in via Azure CLI (az login) or select a Databricks CLI profile in Settings.'
    );
  }
}

/**
 * Start a background task that refreshes the Databricks token every 30 minutes if it is expiring within 1 hour.
 * Shows a notification if refresh fails. Call the returned function to stop.
 */
export function startDatabricksTokenRefreshBackground(baseUrl: string, endpoint: string): () => void {
  const client = new DatabricksAzureClient(baseUrl, endpoint);
  const intervalId = setInterval(async () => {
    try {
      await client.getValidAccessToken();
    } catch (e) {
      console.error('[Databricks] Background token refresh failed:', e);
      try {
        await invoke('show_notification', {
          notification: {
            title: 'Databricks token refresh failed',
            body: 'Please run "az login" in Settings to re-authenticate.',
            notification_type: { SystemError: 'Databricks token refresh failed' },
            priority: 'Normal',
            timeout: 'Default',
            icon: null,
            sound: true,
            actions: [],
          },
        });
      } catch (_) {
        // ignore notification errors
      }
    }
  }, BACKGROUND_REFRESH_INTERVAL_MS);

  return () => clearInterval(intervalId);
}

/**
 * LLM client for Databricks Model Serving (chat endpoint) using Azure CLI token.
 */
export class DatabricksAzureClient {
  private readonly baseUrl: string;
  private readonly endpoint: string;

  constructor(baseUrl: string, endpoint: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.endpoint = endpoint;
  }

  /** Get a valid access token (from keychain if stored and not expiring soon, otherwise via get_databricks_token). */
  async getValidAccessToken(): Promise<string> {
    console.log('[Databricks] Getting valid access token...');

    const stored = await secureRetrieve(STORAGE_KEY_TOKEN);

    if (stored?.trim()) {
      const tokenExpiry = await getTokenExpiry(STORAGE_KEY_TOKEN);
      const now = Date.now() / 1000;

      if (tokenExpiry > now + EXPIRY_BUFFER_SECONDS) {
        console.log('[Databricks] Using valid stored token');
        return stored.trim();
      }
      if (tokenExpiry === 0) {
        console.log('[Databricks] Using stored token (no expiry – legacy or first run)');
        return stored.trim();
      }

      console.log('[Databricks] Token expired or expiring soon, refreshing...');
    }

    console.log('[Databricks] Fetching new token via Azure CLI...');
    try {
      const token = await invoke<string>('get_databricks_token');
      if (!token?.trim()) {
        throw new DatabricksAuthError('Failed to obtain token from Azure CLI');
      }

      await secureStoreWithExpiry(STORAGE_KEY_TOKEN, token.trim(), DEFAULT_TOKEN_EXPIRY_SECONDS);

      console.log('[Databricks] New token obtained and stored');
      return token.trim();
    } catch (error) {
      console.error('[Databricks] Failed to get token:', error);
      throw new DatabricksAuthError(
        'Failed to obtain Databricks token. Please ensure Azure CLI is authenticated: az login'
      );
    }
  }

  /**
   * Generate a summary from a meeting transcript.
   * On 401, re-fetches token via get_databricks_token and retries once.
   */
  async generateSummary(transcript: string): Promise<string> {
    console.log('[Databricks] generateSummary: building request', {
      baseUrl: this.baseUrl,
      endpoint: this.endpoint,
      transcriptLength: transcript.length,
    });

    let token = await this.getValidAccessToken();
    const url = `${this.baseUrl}/serving-endpoints/${encodeURIComponent(this.endpoint)}/invocations`;
    console.log('[Databricks] Request URL:', url);

    const body = {
      messages: [
        { role: 'system' as const, content: DEFAULT_SYSTEM_PROMPT },
        { role: 'user' as const, content: transcript },
      ],
      max_tokens: 2000,
    };

    const doRequest = (t: string) =>
      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${t}`,
        },
        body: JSON.stringify(body),
      });

    console.log('[Databricks] Making API request to Databricks Model Serving...');
    let response = await doRequest(token);

    console.log('[Databricks] Response received:', {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
    });

    if (response.status === 401) {
      console.log('[Databricks] 401 received, refreshing token and retrying once...');
      try {
        token = await this.getValidAccessToken();
        response = await doRequest(token);
        console.log('[Databricks] Retry response:', { status: response.status, ok: response.ok });
      } catch (refreshError) {
        throw new DatabricksAuthError(
          'Databricks authentication expired or invalid. Please run: az login'
        );
      }
      if (response.status === 401) {
        throw new DatabricksAuthError(
          'Databricks authentication expired or invalid. Please run: az login'
        );
      }
    }

    const text = await response.text();
    if (!response.ok) {
      console.error('[Databricks] API error response:', {
        status: response.status,
        statusText: response.statusText,
        bodyPreview: text.substring(0, 500),
      });
    }

    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new DatabricksApiError(
        response.ok ? 'Invalid JSON response' : `Request failed: ${response.status} ${response.statusText}`,
        response.status
      );
    }

    if (!response.ok) {
      const err = data as { error_code?: string; message?: string };
      const message = err?.message ?? `Request failed: ${response.status}`;
      throw new DatabricksApiError(message, response.status, err?.error_code);
    }

    console.log('[Databricks] API success, parsing response. Keys:', data && typeof data === 'object' ? Object.keys(data as object) : []);
    return this.extractSummaryFromResponse(data);
  }

  private extractSummaryFromResponse(data: unknown): string {
    if (data === null || typeof data !== 'object') {
      throw new DatabricksApiError('Empty or invalid response from model', 200);
    }
    const obj = data as Record<string, unknown>;
    const choices = obj?.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new DatabricksApiError('Response missing choices', 200);
    }
    const first = choices[0] as Record<string, unknown> | undefined;
    if (!first) {
      throw new DatabricksApiError('Invalid choices in response', 200);
    }
    const message = first.message as { content?: string } | undefined;
    if (message && typeof message.content === 'string') {
      return message.content.trim();
    }
    if (typeof first.text === 'string') {
      return first.text.trim();
    }
    throw new DatabricksApiError('Response missing summary content', 200);
  }
}
