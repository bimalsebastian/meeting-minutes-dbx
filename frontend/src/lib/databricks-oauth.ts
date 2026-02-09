/**
 * Databricks OAuth 2.0 client using Authorization Code flow with PKCE (SHA-256).
 * Uses Tauri secure storage (Keychain/Credential Manager) for tokens and PKCE state.
 */

import { invoke } from '@tauri-apps/api/core';

// --- Storage keys (values stored via secure_store/secure_retrieve)
const STORAGE_KEY_TOKEN_SET = 'databricks_token_set';
const STORAGE_KEY_PKCE_VERIFIER = 'databricks_pkce_verifier';
const STORAGE_KEY_PKCE_STATE = 'databricks_pkce_state';

/** Token set persisted in secure storage. */
export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp in milliseconds
}

/** Config for the Databricks OAuth client. */
export interface DatabricksOAuthConfig {
  /** Databricks workspace base URL (e.g. https://my-workspace.cloud.databricks.com) */
  baseUrl: string;
  /** OAuth client ID. */
  clientId: string;
  /** Redirect URI registered with the OAuth app. */
  redirectUri: string;
  /** Scopes (space-separated). Default: "all-apis" */
  scope?: string;
}

/** Minimum time before expiry (ms) to trigger auto-refresh. */
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// --- Secure storage helpers (Tauri invoke)
async function secureStore(key: string, value: string): Promise<void> {
  await invoke('secure_store', { key, value });
}

async function secureRetrieve(key: string): Promise<string> {
  return await invoke<string>('secure_retrieve', { key });
}

async function secureDelete(key: string): Promise<void> {
  await invoke('secure_delete', { key });
}

// --- PKCE helpers
function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Generate a cryptographically random string suitable for code_verifier (43–128 chars). */
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

/** Compute SHA-256 and return code_challenge (base64url). */
async function sha256Base64Url(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hash = await globalThis.crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(hash);
}

// --- API URL helpers
function authUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/$/, '');
  return `${base}/oidc/v1/authorize`;
}

function tokenUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/$/, '');
  return `${base}/oidc/v1/token`;
}

/**
 * Databricks OAuth 2.0 client (Authorization Code + PKCE).
 * Use authorize() to start the flow, then exchangeCode() with the code from the redirect.
 */
export class DatabricksOAuthClient {
  private readonly config: Required<Pick<DatabricksOAuthConfig, 'baseUrl' | 'clientId' | 'redirectUri'>> & {
    scope: string;
  };

  constructor(config: DatabricksOAuthConfig) {
    this.config = {
      baseUrl: config.baseUrl.replace(/\/$/, ''),
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      scope: config.scope ?? 'all-apis',
    };
  }

  /** Workspace base URL (e.g. for Model Serving API). */
  getBaseUrl(): string {
    return this.config.baseUrl;
  }

  /**
   * Start the authorization flow: build authorize URL with PKCE, store verifier and state,
   * and open the browser. Call exchangeCode() with the `code` from the redirect.
   */
  async authorize(): Promise<void> {
    const codeVerifier = generateRandomString(43);
    const codeChallenge = await sha256Base64Url(codeVerifier);
    const state = generateRandomString(32);

    await secureStore(STORAGE_KEY_PKCE_VERIFIER, codeVerifier);
    await secureStore(STORAGE_KEY_PKCE_STATE, state);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: this.config.scope,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    const url = `${authUrl(this.config.baseUrl)}?${params.toString()}`;

    await invoke('open_external_url', { url });
  }

  /**
   * Exchange the authorization code for tokens. Call this with the `code` from the redirect.
   * Optionally pass the redirect `state` to verify it matches the stored state.
   */
  async exchangeCode(code: string, stateFromRedirect?: string): Promise<TokenSet> {
    const [storedVerifier, storedState] = await Promise.all([
      secureRetrieve(STORAGE_KEY_PKCE_VERIFIER),
      secureRetrieve(STORAGE_KEY_PKCE_STATE),
    ]).catch(() => ['', '']);

    if (!storedVerifier || !storedState) {
      throw new Error('No PKCE state found. Call authorize() first.');
    }
    if (stateFromRedirect !== undefined && stateFromRedirect !== storedState) {
      throw new Error('State mismatch. Possible CSRF.');
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      code_verifier: storedVerifier,
    });

    const tokenSet = await this.requestToken(body);

    await secureDelete(STORAGE_KEY_PKCE_VERIFIER);
    await secureDelete(STORAGE_KEY_PKCE_STATE);
    await this.persistTokenSet(tokenSet);

    return tokenSet;
  }

  /**
   * Return a valid access token, refreshing if it expires within 5 minutes.
   * Throws if no tokens are stored or refresh fails.
   */
  async getValidAccessToken(): Promise<string> {
    const tokenSet = await this.getStoredTokenSet();
    if (!tokenSet) {
      throw new Error('Not authenticated. Call authorize() and exchangeCode() first.');
    }

    const now = Date.now();
    if (tokenSet.expiresAt - REFRESH_THRESHOLD_MS <= now) {
      const refreshed = await this.refreshAccessToken();
      return refreshed.accessToken;
    }
    return tokenSet.accessToken;
  }

  /**
   * Refresh the access token using the stored refresh token and persist the new TokenSet.
   */
  async refreshAccessToken(): Promise<TokenSet> {
    const tokenSet = await this.getStoredTokenSet();
    if (!tokenSet?.refreshToken) {
      throw new Error('No refresh token. Re-authenticate with authorize() and exchangeCode().');
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokenSet.refreshToken,
      client_id: this.config.clientId,
    });

    const newSet = await this.requestToken(body);
    await this.persistTokenSet(newSet);
    return newSet;
  }

  /** Clear stored tokens (e.g. on logout). */
  async clearTokens(): Promise<void> {
    try {
      await secureDelete(STORAGE_KEY_TOKEN_SET);
    } catch {
      // Ignore if key did not exist
    }
  }

  /** Read the current TokenSet from secure storage. */
  async getStoredTokenSet(): Promise<TokenSet | null> {
    try {
      const raw = await secureRetrieve(STORAGE_KEY_TOKEN_SET);
      const data = JSON.parse(raw) as TokenSet;
      if (data?.accessToken && data?.refreshToken && typeof data?.expiresAt === 'number') {
        return data;
      }
    } catch {
      // Not found or invalid
    }
    return null;
  }

  private async persistTokenSet(tokenSet: TokenSet): Promise<void> {
    await secureStore(STORAGE_KEY_TOKEN_SET, JSON.stringify(tokenSet));
  }

  private async requestToken(body: URLSearchParams): Promise<TokenSet> {
    const url = tokenUrl(this.config.baseUrl);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      let message = `Token request failed: ${response.status}`;
      try {
        const json = JSON.parse(text) as { error?: string; error_description?: string };
        if (json.error_description) message = json.error_description;
        else if (json.error) message = json.error;
      } catch {
        if (text) message += ` ${text}`;
      }
      throw new Error(message);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number; // seconds
    };

    const expiresInMs = (data.expires_in ?? 3600) * 1000;
    const tokenSet: TokenSet = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? (await this.getStoredTokenSet())?.refreshToken ?? '',
      expiresAt: Date.now() + expiresInMs,
    };

    if (!tokenSet.refreshToken) {
      throw new Error('Token response did not include refresh_token.');
    }

    return tokenSet;
  }
}
