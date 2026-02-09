/**
 * OAuth integration tests: Databricks OAuth flow, callback parsing, keychain, token refresh,
 * and Databricks LLM summarization. All Tauri and network calls are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseOAuthCallbackUrl,
  initOAuthCallbackHandler,
} from '../lib/oauth-callback-handler';
import { DatabricksOAuthClient, type TokenSet } from '../lib/databricks-oauth';
import {
  DatabricksLLMClient,
  DatabricksAuthError,
  DatabricksApiError,
} from '../lib/databricks-llm-client';

// --- Mocks
const mockInvoke = vi.fn();
const mockEmit = vi.fn();
const mockGetCurrent = vi.fn();
const mockOnOpenUrl = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  emit: (...args: unknown[]) => mockEmit(...args),
}));

vi.mock('@tauri-apps/plugin-deep-link', () => ({
  getCurrent: () => mockGetCurrent(),
  onOpenUrl: (cb: (urls: string[]) => void) => {
    mockOnOpenUrl(cb);
    return Promise.resolve(() => {});
  },
}));

const BASE_URL = 'https://example.cloud.databricks.com';
const CLIENT_ID = 'test-client-id';
const REDIRECT_URI = 'meetily://oauth/callback';

function createTokenSet(overrides?: Partial<TokenSet>): TokenSet {
  return {
    accessToken: 'access-123',
    refreshToken: 'refresh-456',
    expiresAt: Date.now() + 3600_000,
    ...overrides,
  };
}

describe('OAuth integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. OAuth flow success (mock all API calls)', () => {
    it('authorize() stores PKCE verifier and state and opens browser', async () => {
      mockInvoke.mockResolvedValue(undefined);
      const client = new DatabricksOAuthClient({
        baseUrl: BASE_URL,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
      });

      await client.authorize();

      expect(mockInvoke).toHaveBeenCalledWith('secure_store', {
        key: 'databricks_pkce_verifier',
        value: expect.any(String),
      });
      expect(mockInvoke).toHaveBeenCalledWith('secure_store', {
        key: 'databricks_pkce_state',
        value: expect.any(String),
      });
      expect(mockInvoke).toHaveBeenCalledWith('open_external_url', {
        url: expect.stringContaining(BASE_URL),
      });
      expect(mockInvoke.mock.calls.find((c: unknown[]) => (c as string[])[0] === 'open_external_url')?.[1]?.url).toMatch(
        /response_type=code&client_id=test-client-id&redirect_uri=meetily/
      );
    });

    it('exchangeCode() exchanges code for tokens and persists TokenSet', async () => {
      const verifier = 'pkce-verifier';
      const state = 'stored-state';
      mockInvoke
        .mockImplementation(async (cmd: string, args: { key: string; value?: string }) => {
          if (cmd === 'secure_retrieve') {
            if (args.key === 'databricks_pkce_verifier') return verifier;
            if (args.key === 'databricks_pkce_state') return state;
            if (args.key === 'databricks_token_set') return null;
          }
          if (cmd === 'secure_store' || cmd === 'secure_delete') return undefined;
          return undefined;
        });

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        }),
      });

      const client = new DatabricksOAuthClient({
        baseUrl: BASE_URL,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
      });

      const tokenSet = await client.exchangeCode('auth-code-123', state);

      expect(tokenSet.accessToken).toBe('new-access');
      expect(tokenSet.refreshToken).toBe('new-refresh');
      expect(mockInvoke).toHaveBeenCalledWith('secure_store', {
        key: 'databricks_token_set',
        value: expect.stringContaining('new-access'),
      });
      expect(mockInvoke).toHaveBeenCalledWith('secure_delete', { key: 'databricks_pkce_verifier' });
      expect(mockInvoke).toHaveBeenCalledWith('secure_delete', { key: 'databricks_pkce_state' });
    });
  });

  describe('2. Token refresh on expiry', () => {
    it('getValidAccessToken() refreshes when token expires within 5 minutes', async () => {
      const now = Date.now();
      const expiresSoon = now + 2 * 60 * 1000; // 2 minutes from now
      const storedSet = createTokenSet({ expiresAt: expiresSoon });

      mockInvoke.mockImplementation(async (_cmd: string, args: { key: string }) => {
        if (args.key === 'databricks_token_set') return JSON.stringify(storedSet);
        return undefined;
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'refreshed-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        }),
      });

      const client = new DatabricksOAuthClient({
        baseUrl: BASE_URL,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
      });

      const token = await client.getValidAccessToken();

      expect(token).toBe('refreshed-access');
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/oidc/v1/token'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('grant_type=refresh_token'),
        })
      );
    });

    it('getValidAccessToken() returns existing token when not expired', async () => {
      const set = createTokenSet({ expiresAt: Date.now() + 10 * 60 * 1000 });
      mockInvoke.mockResolvedValue(JSON.stringify(set));

      const client = new DatabricksOAuthClient({
        baseUrl: BASE_URL,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
      });

      const token = await client.getValidAccessToken();

      expect(token).toBe('access-123');
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('3. Token refresh failure (trigger re-auth)', () => {
    it('getValidAccessToken() throws when refresh fails', async () => {
      const now = Date.now();
      const expiresSoon = now + 2 * 60 * 1000;
      mockInvoke.mockResolvedValue(
        JSON.stringify(createTokenSet({ expiresAt: expiresSoon }))
      );

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => '{"error":"invalid_grant"}',
      });

      const client = new DatabricksOAuthClient({
        baseUrl: BASE_URL,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
      });

      await expect(client.getValidAccessToken()).rejects.toThrow();
    });

    it('getValidAccessToken() throws when no tokens stored', async () => {
      mockInvoke.mockResolvedValue(null); // or reject - getStoredTokenSet returns null

      const client = new DatabricksOAuthClient({
        baseUrl: BASE_URL,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
      });

      await expect(client.getValidAccessToken()).rejects.toThrow(
        /Not authenticated|authorize|exchangeCode/
      );
    });
  });

  describe('4. Callback URL parsing and validation', () => {
    it('parseOAuthCallbackUrl returns code and state for valid meetily URL', () => {
      const url = 'meetily://oauth/callback?code=abc123&state=xyz789';
      const result = parseOAuthCallbackUrl(url);
      expect(result).toEqual({ code: 'abc123', state: 'xyz789' });
    });

    it('parseOAuthCallbackUrl returns null for wrong scheme', () => {
      expect(parseOAuthCallbackUrl('https://app.com/callback?code=a&state=b')).toBeNull();
      expect(parseOAuthCallbackUrl('other://callback?code=a&state=b')).toBeNull();
    });

    it('parseOAuthCallbackUrl returns null when code or state missing', () => {
      expect(parseOAuthCallbackUrl('meetily://?code=only')).toBeNull();
      expect(parseOAuthCallbackUrl('meetily://?state=only')).toBeNull();
      expect(parseOAuthCallbackUrl('meetily://')).toBeNull();
    });

    it('parseOAuthCallbackUrl handles path in URL', () => {
      const result = parseOAuthCallbackUrl('meetily://oauth/callback?code=c&state=s');
      expect(result).toEqual({ code: 'c', state: 's' });
    });
  });

  describe('5. State parameter CSRF protection', () => {
    it('exchangeCode() throws when state from redirect does not match stored state', async () => {
      mockInvoke.mockImplementation(async (_cmd: string, args: { key: string }) => {
        if (args.key === 'databricks_pkce_verifier') return 'verifier';
        if (args.key === 'databricks_pkce_state') return 'stored-state';
        return undefined;
      });

      const client = new DatabricksOAuthClient({
        baseUrl: BASE_URL,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
      });

      await expect(
        client.exchangeCode('code-123', 'wrong-state-from-redirect')
      ).rejects.toThrow(/State mismatch|CSRF/);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('exchangeCode() succeeds when state matches', async () => {
      const state = 'correct-state';
      mockInvoke.mockImplementation(async (cmd: string, args: { key: string }) => {
        if (cmd === 'secure_retrieve') {
          if (args.key === 'databricks_pkce_verifier') return 'v';
          if (args.key === 'databricks_pkce_state') return state;
          return null;
        }
        return undefined;
      });
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'at',
          refresh_token: 'rt',
          expires_in: 3600,
        }),
      });

      const client = new DatabricksOAuthClient({
        baseUrl: BASE_URL,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
      });

      const tokenSet = await client.exchangeCode('code', state);
      expect(tokenSet.accessToken).toBe('at');
    });
  });

  describe('6. Keychain storage/retrieval', () => {
    it('TokenSet is stored via secure_store and read via secure_retrieve', async () => {
      let stored: string | null = null;
      mockInvoke.mockImplementation(async (cmd: string, args: { key: string; value?: string }) => {
        if (cmd === 'secure_store' && args.key === 'databricks_token_set') {
          stored = args.value ?? null;
        }
        if (cmd === 'secure_retrieve') {
          if (args.key === 'databricks_pkce_verifier') return 'v';
          if (args.key === 'databricks_pkce_state') return 's';
          if (args.key === 'databricks_token_set') return stored;
        }
        if (cmd === 'secure_delete') return undefined;
        return undefined;
      });
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'stored-access',
          refresh_token: 'stored-refresh',
          expires_in: 3600,
        }),
      });

      const client = new DatabricksOAuthClient({
        baseUrl: BASE_URL,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
      });

      await client.exchangeCode('code', 's');
      expect(stored).toBeTruthy();
      expect(JSON.parse(stored!).accessToken).toBe('stored-access');

      const retrieved = await client.getStoredTokenSet();
      expect(retrieved?.accessToken).toBe('stored-access');
    });

    it('clearTokens() deletes token set from keychain', async () => {
      mockInvoke.mockResolvedValue(undefined);
      const client = new DatabricksOAuthClient({
        baseUrl: BASE_URL,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
      });
      await client.clearTokens();
      expect(mockInvoke).toHaveBeenCalledWith('secure_delete', {
        key: 'databricks_token_set',
      });
    });
  });

  describe('7. Meeting summarization with Databricks client', () => {
    it('generateSummary() returns summary text from chat completion response', async () => {
      const mockOAuthClient = {
        getValidAccessToken: vi.fn().mockResolvedValue('bearer-token'),
        getBaseUrl: () => BASE_URL,
      } as unknown as DatabricksOAuthClient;

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [
              {
                message: { content: '  Summary: Key points and action items.  ' },
              },
            ],
          }),
      });

      const llmClient = new DatabricksLLMClient(mockOAuthClient, 'my-endpoint');
      const summary = await llmClient.generateSummary('Transcript text here.');

      expect(summary).toBe('Summary: Key points and action items.');
      expect(mockOAuthClient.getValidAccessToken).toHaveBeenCalled();
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/serving-endpoints/my-endpoint/invocations'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer bearer-token',
            'Content-Type': 'application/json',
          }),
          body: expect.stringContaining('Transcript text here.'),
        })
      );
    });

    it('generateSummary() throws DatabricksAuthError on 401', async () => {
      const mockOAuthClient = {
        getValidAccessToken: vi.fn().mockResolvedValue('token'),
        getBaseUrl: () => BASE_URL,
      } as unknown as DatabricksOAuthClient;

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      const llmClient = new DatabricksLLMClient(mockOAuthClient, 'ep');

      let err: unknown;
      try {
        await llmClient.generateSummary('text');
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(DatabricksAuthError);
      expect((err as DatabricksAuthError).status).toBe(401);
    });

    it('generateSummary() throws DatabricksApiError on API error response', async () => {
      const mockOAuthClient = {
        getValidAccessToken: vi.fn().mockResolvedValue('token'),
        getBaseUrl: () => BASE_URL,
      } as unknown as DatabricksOAuthClient;

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 500,
        text: async () =>
          JSON.stringify({ error_code: 'INTERNAL_ERROR', message: 'Server error' }),
      });

      const llmClient = new DatabricksLLMClient(mockOAuthClient, 'ep');

      await expect(llmClient.generateSummary('text')).rejects.toThrow(DatabricksApiError);
      const err = await llmClient.generateSummary('text').catch((e) => e);
      expect(err).toBeInstanceOf(DatabricksApiError);
      expect((err as DatabricksApiError).status).toBe(500);
      expect((err as DatabricksApiError).errorCode).toBe('INTERNAL_ERROR');
    });

    it('generateSummary() supports completions format (text field)', async () => {
      const mockOAuthClient = {
        getValidAccessToken: vi.fn().mockResolvedValue('t'),
        getBaseUrl: () => BASE_URL,
      } as unknown as DatabricksOAuthClient;

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            choices: [{ text: ' Completions summary. ' }],
          }),
      });

      const llmClient = new DatabricksLLMClient(mockOAuthClient, 'ep');
      const summary = await llmClient.generateSummary('prompt');
      expect(summary).toBe('Completions summary.');
    });
  });

  describe('Callback handler integration', () => {
    it('initOAuthCallbackHandler processes startup URL and emits auth-complete on success', async () => {
      const tokenSet = createTokenSet();
      mockGetCurrent.mockResolvedValue([
        'meetily://oauth/callback?code=startup-code&state=stored-state',
      ]);
      mockOnOpenUrl.mockImplementation(() => Promise.resolve(() => {}));

      mockInvoke.mockImplementation(async (cmd: string, args: { key: string }) => {
        if (cmd === 'secure_retrieve') {
          if (args.key === 'databricks_pkce_verifier') return 'verifier';
          if (args.key === 'databricks_pkce_state') return 'stored-state';
          return null;
        }
        return undefined;
      });
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: tokenSet.accessToken,
          refresh_token: tokenSet.refreshToken,
          expires_in: 3600,
        }),
      });

      const client = new DatabricksOAuthClient({
        baseUrl: BASE_URL,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
      });

      const unlisten = await initOAuthCallbackHandler(client);

      expect(mockEmit).toHaveBeenCalledWith(
        'auth-complete',
        expect.objectContaining({
          success: true,
          tokenSet: expect.objectContaining({
            accessToken: tokenSet.accessToken,
            refreshToken: tokenSet.refreshToken,
          }),
        })
      );
      expect(typeof unlisten).toBe('function');
    });

    it('initOAuthCallbackHandler emits auth-complete with success false on exchange error', async () => {
      mockGetCurrent.mockResolvedValue([
        'meetily://oauth/callback?code=bad&state=stored',
      ]);
      mockInvoke.mockImplementation(async (_cmd: string, args: { key: string }) => {
        if (args.key === 'databricks_pkce_verifier') return 'v';
        if (args.key === 'databricks_pkce_state') return 'stored';
        return null;
      });
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => '{"error":"invalid_grant"}',
      });

      const client = new DatabricksOAuthClient({
        baseUrl: BASE_URL,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
      });

      await initOAuthCallbackHandler(client);

      await new Promise((r) => setTimeout(r, 50));

      expect(mockEmit).toHaveBeenCalledWith(
        'auth-complete',
        expect.objectContaining({
          success: false,
          error: expect.any(String),
        })
      );
    });
  });
});
