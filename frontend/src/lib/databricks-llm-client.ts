/**
 * Databricks Model Serving LLM client for summary generation.
 * Uses OAuth for auth and POST /serving-endpoints/{endpoint}/invocations.
 */

import type { DatabricksOAuthClient } from './databricks-oauth';

/** Thrown when the API returns 401; caller should prompt re-authentication. */
export class DatabricksAuthError extends Error {
  readonly status = 401;

  constructor(message: string = 'Databricks authentication expired or invalid. Please sign in again.') {
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
 * LLM client for Databricks Model Serving (chat endpoint).
 * Uses the OAuth client to obtain a valid token before each request.
 */
export class DatabricksLLMClient {
  private readonly oauthClient: DatabricksOAuthClient;
  private readonly endpoint: string;
  private readonly baseUrl: string;

  constructor(oauthClient: DatabricksOAuthClient, endpoint: string) {
    this.oauthClient = oauthClient;
    this.endpoint = endpoint;
    this.baseUrl = oauthClient.getBaseUrl().replace(/\/$/, '');
  }

  /**
   * Generate a summary from a meeting transcript using the configured serving endpoint.
   * Calls getValidAccessToken() before the request. On 401 throws DatabricksAuthError for re-auth.
   */
  async generateSummary(transcript: string): Promise<string> {
    const token = await this.oauthClient.getValidAccessToken();
    const url = `${this.baseUrl}/serving-endpoints/${encodeURIComponent(this.endpoint)}/invocations`;

    const body = {
      messages: [
        { role: 'system' as const, content: DEFAULT_SYSTEM_PROMPT },
        { role: 'user' as const, content: transcript },
      ],
      max_tokens: 2000,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    if (response.status === 401) {
      throw new DatabricksAuthError(
        'Databricks authentication expired or invalid. Please sign in again.'
      );
    }

    const text = await response.text();
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

    return this.extractSummaryFromResponse(data);
  }

  /**
   * Extract summary text from Databricks chat completion response.
   * Supports choices[].message.content (chat) and choices[].text (completions).
   */
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

    // Chat: message.content
    const message = first.message as { content?: string } | undefined;
    if (message && typeof message.content === 'string') {
      return message.content.trim();
    }

    // Completions: text
    if (typeof first.text === 'string') {
      return first.text.trim();
    }

    throw new DatabricksApiError('Response missing summary content', 200);
  }
}
