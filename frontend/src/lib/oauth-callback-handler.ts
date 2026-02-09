/**
 * OAuth callback handler for the meetily:// deep link scheme.
 * Listens for incoming URLs, extracts code/state, validates state, exchanges the code,
 * and emits 'auth-complete'.
 */

import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { emit } from '@tauri-apps/api/event';
import type { DatabricksOAuthClient } from './databricks-oauth';
import type { TokenSet } from './databricks-oauth';

/** Payload emitted on auth-complete (success). */
export interface AuthCompleteSuccess {
  success: true;
  tokenSet: TokenSet;
}

/** Payload emitted on auth-complete (failure). */
export interface AuthCompleteError {
  success: false;
  error: string;
}

export type AuthCompletePayload = AuthCompleteSuccess | AuthCompleteError;

const MEETILY_SCHEME = 'meetily';

/**
 * Parse a meetily:// URL and return code and state from query string.
 * Supports URLs like meetily://oauth/callback?code=...&state=... or meetily://?code=...&state=...
 * Exported for tests.
 */
export function parseOAuthCallbackUrl(url: string): { code: string; state: string } | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== `${MEETILY_SCHEME}:`) {
      return null;
    }
    const code = parsed.searchParams.get('code');
    const state = parsed.searchParams.get('state');
    if (!code || !state) {
      return null;
    }
    return { code, state };
  } catch {
    return null;
  }
}

/**
 * Process a single URL: if it looks like an OAuth callback, exchange the code and emit auth-complete.
 */
async function handleUrl(
  url: string,
  client: DatabricksOAuthClient
): Promise<boolean> {
  const params = parseOAuthCallbackUrl(url);
  if (!params) {
    return false;
  }

  try {
    const tokenSet = await client.exchangeCode(params.code, params.state);
    await emit<AuthCompleteSuccess>('auth-complete', {
      success: true,
      tokenSet,
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await emit<AuthCompleteError>('auth-complete', {
      success: false,
      error: message,
    });
    return true; // We handled it (as error)
  }
}

/**
 * Initialize OAuth callback handling for the given Databricks OAuth client.
 * - Listens for deep link events (onOpenUrl).
 * - Processes any app-start URLs (getCurrent) that look like OAuth callbacks.
 *
 * Call once at app startup (e.g. in root layout). Uses the same client instance
 * that will be used for authorize() so redirect_uri and storage keys match.
 *
 * @param client - DatabricksOAuthClient instance (same config as used for authorize())
 * @returns Unlisten function to stop handling deep links
 */
export async function initOAuthCallbackHandler(
  client: DatabricksOAuthClient
): Promise<() => void> {
  // Handle app opened via deep link (startup URLs)
  const startUrls = await getCurrent();
  if (startUrls?.length) {
    for (const url of startUrls) {
      const handled = await handleUrl(url, client);
      if (handled) break;
    }
  }

  // Listen for deep links while app is running
  const unlisten = await onOpenUrl((urls) => {
    for (const url of urls) {
      handleUrl(url, client).catch((err) => {
        console.error('[OAuth callback] Error handling URL:', err);
        emit<AuthCompleteError>('auth-complete', {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  });

  return unlisten;
}
