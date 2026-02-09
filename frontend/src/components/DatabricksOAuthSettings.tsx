'use client';

import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { toast } from 'sonner';
import { DatabricksOAuthClient } from '@/lib/databricks-oauth';
import type { TokenSet } from '@/lib/databricks-oauth';

const STORAGE_KEYS = {
  baseUrl: 'databricks_base_url',
  clientId: 'databricks_client_id',
  redirectUri: 'databricks_redirect_uri',
} as const;

const DEFAULT_REDIRECT_URI = 'meetily://oauth/callback';

export interface DatabricksOAuthSettingsProps {
  /** Current endpoint name (serving endpoint); synced with modelConfig.model */
  endpoint: string;
  onEndpointChange: (endpoint: string) => void;
  onAuthComplete?: (tokenSet: TokenSet) => void;
  onAuthError?: (error: string) => void;
}

export function DatabricksOAuthSettings({
  endpoint,
  onEndpointChange,
  onAuthComplete,
  onAuthError,
}: DatabricksOAuthSettingsProps) {
  const [baseUrl, setBaseUrl] = useState('');
  const [clientId, setClientId] = useState('');
  const [redirectUri, setRedirectUri] = useState(DEFAULT_REDIRECT_URI);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [hasTokens, setHasTokens] = useState(false);

  const loadFromStorage = useCallback(async () => {
    try {
      const [url, cid, uri] = await Promise.all([
        invoke<string>('secure_retrieve', { key: STORAGE_KEYS.baseUrl }).catch(() => ''),
        invoke<string>('secure_retrieve', { key: STORAGE_KEYS.clientId }).catch(() => ''),
        invoke<string>('secure_retrieve', { key: STORAGE_KEYS.redirectUri }).catch(() => ''),
      ]);
      setBaseUrl(url || '');
      setClientId(cid || '');
      setRedirectUri(uri || DEFAULT_REDIRECT_URI);
      const tokenRaw = await invoke<string>('secure_retrieve', { key: 'databricks_token_set' }).catch(() => '');
      setHasTokens(!!tokenRaw);
    } catch (e) {
      console.error('Failed to load Databricks settings:', e);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFromStorage();
  }, [loadFromStorage]);

  useEffect(() => {
    const unlisten = listen<{ success: boolean; tokenSet?: TokenSet; error?: string }>('auth-complete', (event) => {
      setIsConnecting(false);
      const payload = event.payload;
      if (payload.success && payload.tokenSet) {
        setHasTokens(true);
        onAuthComplete?.(payload.tokenSet);
        toast.success('Connected to Databricks');
      } else if (!payload.success && payload.error) {
        onAuthError?.(payload.error);
        toast.error('Databricks sign-in failed', { description: payload.error });
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [onAuthComplete, onAuthError]);

  const handleSave = async () => {
    if (!baseUrl.trim() || !clientId.trim()) {
      toast.error('Base URL and Client ID are required');
      return;
    }
    setIsSaving(true);
    try {
      await invoke('secure_store', { key: STORAGE_KEYS.baseUrl, value: baseUrl.trim() });
      await invoke('secure_store', { key: STORAGE_KEYS.clientId, value: clientId.trim() });
      await invoke('secure_store', { key: STORAGE_KEYS.redirectUri, value: redirectUri.trim() || DEFAULT_REDIRECT_URI });
      toast.success('Databricks settings saved');
    } catch (e) {
      console.error('Failed to save Databricks settings:', e);
      toast.error('Failed to save settings');
    } finally {
      setIsSaving(false);
    }
  };

  const handleConnect = async () => {
    if (!baseUrl.trim() || !clientId.trim()) {
      toast.error('Save Base URL and Client ID first');
      return;
    }
    setIsConnecting(true);
    try {
      const client = new DatabricksOAuthClient({
        baseUrl: baseUrl.trim(),
        clientId: clientId.trim(),
        redirectUri: redirectUri.trim() || DEFAULT_REDIRECT_URI,
      });
      await client.authorize();
      toast.info('Complete sign-in in the browser');
    } catch (e) {
      setIsConnecting(false);
      const msg = e instanceof Error ? e.message : String(e);
      toast.error('Failed to start sign-in', { description: msg });
    }
  };

  if (isLoading) {
    return (
      <div className="text-sm text-muted-foreground">Loading Databricks settings…</div>
    );
  }

  return (
    <div className="space-y-4 border-t pt-4">
      <div>
        <Label htmlFor="databricks-base-url">Workspace URL *</Label>
        <Input
          id="databricks-base-url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://your-workspace.cloud.databricks.com"
          className="mt-1"
        />
        <p className="text-xs text-muted-foreground mt-1">
          Databricks workspace base URL
        </p>
      </div>

      <div>
        <Label htmlFor="databricks-client-id">OAuth Client ID *</Label>
        <Input
          id="databricks-client-id"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="Client ID from your OAuth app"
          className="mt-1"
        />
      </div>

      <div>
        <Label htmlFor="databricks-redirect-uri">Redirect URI</Label>
        <Input
          id="databricks-redirect-uri"
          value={redirectUri}
          onChange={(e) => setRedirectUri(e.target.value)}
          placeholder={DEFAULT_REDIRECT_URI}
          className="mt-1"
        />
        <p className="text-xs text-muted-foreground mt-1">
          Must match the redirect URI registered in your Databricks OAuth app (e.g. meetily://oauth/callback)
        </p>
      </div>

      <div>
        <Label htmlFor="databricks-endpoint">Serving endpoint name *</Label>
        <Input
          id="databricks-endpoint"
          value={endpoint}
          onChange={(e) => onEndpointChange(e.target.value)}
          placeholder="my-chat-endpoint"
          className="mt-1"
        />
        <p className="text-xs text-muted-foreground mt-1">
          Name of the Model Serving chat endpoint to use for summaries
        </p>
      </div>

      {hasTokens && (
        <Alert>
          <AlertDescription>Signed in to Databricks. Use &quot;Sign in again&quot; if you need to re-authenticate.</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" onClick={handleSave} disabled={isSaving}>
          {isSaving ? 'Saving…' : 'Save settings'}
        </Button>
        <Button type="button" onClick={handleConnect} disabled={isConnecting}>
          {isConnecting ? 'Opening browser…' : hasTokens ? 'Sign in again' : 'Sign in to Databricks'}
        </Button>
      </div>
    </div>
  );
}
