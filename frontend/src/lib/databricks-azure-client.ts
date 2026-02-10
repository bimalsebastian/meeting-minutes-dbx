/**
 * Databricks Model Serving client using Azure CLI authentication.
 * Token is obtained via invoke('get_databricks_token') and stored in keychain.
 * Auto-refreshes on 401 by calling get_databricks_token again.
 */

import { invoke } from '@tauri-apps/api/core';

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

  /** Get a valid access token (from keychain if stored, otherwise via get_databricks_token). */
  async getValidAccessToken(): Promise<string> {
    console.log('[Databricks] Loading token from keychain (key: databricks_token)...');
    const stored = await invoke<string>('secure_retrieve', { key: STORAGE_KEY_TOKEN }).catch((e) => {
      console.log('[Databricks] Keychain retrieve failed (will fetch via Azure CLI):', e);
      return '';
    });
    if (stored?.trim()) {
      console.log('[Databricks] Using stored token, length:', stored.trim().length);
      return stored.trim();
    }
    console.log('[Databricks] No stored token, calling get_databricks_token (Azure CLI)...');
    const token = await invoke<string>('get_databricks_token').catch((e) => {
      console.error('[Databricks] get_databricks_token failed:', e);
      throw new DatabricksAuthError(String(e));
    });
    if (!token?.trim()) {
      console.error('[Databricks] get_databricks_token returned empty token');
      throw new DatabricksAuthError('No token. Sign in via Azure CLI in Settings.');
    }
    console.log('[Databricks] Token obtained, length:', token.trim().length, '- storing in keychain');
    await invoke('secure_store', { key: STORAGE_KEY_TOKEN, value: token.trim() });
    return token.trim();
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
      console.log('[Databricks] 401 received, refreshing token and retrying...');
      const freshToken = await invoke<string>('get_databricks_token').catch((e) => {
        throw new DatabricksAuthError(String(e));
      });
      if (freshToken?.trim()) {
        await invoke('secure_store', { key: STORAGE_KEY_TOKEN, value: freshToken.trim() });
        token = freshToken.trim();
      }
      response = await doRequest(token);
      console.log('[Databricks] Retry response:', { status: response.status, ok: response.ok });
      if (response.status === 401) {
        throw new DatabricksAuthError(
          'Databricks authentication expired or invalid. Sign in again via Azure CLI.'
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
