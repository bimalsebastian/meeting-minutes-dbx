'use client';

import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { toast } from 'sonner';
import { ExternalLink } from 'lucide-react';
import { secureStore, secureRetrieve } from '@/lib/stronghold';

export type AzureCliStatus = 'checking' | 'not_installed' | 'not_logged_in' | 'ready' | 'token_obtained';
type AuthMethod = 'azure_cli' | 'databricks_cli';

const AZURE_CLI_DOCS = 'https://learn.microsoft.com/en-us/cli/azure/install-azure-cli';

export interface AzureCliAuthProps {
  endpoint: string;
  onEndpointChange: (endpoint: string) => void;
  baseUrl?: string;
  onBaseUrlChange?: (url: string) => void;
  onTokenObtained?: () => void;
}

interface DatabricksProfile {
  name: string;
  host: string;
  auth_type: string;
  has_pat: boolean;
}

export function AzureCliAuth({
  endpoint,
  onEndpointChange,
  baseUrl = '',
  onBaseUrlChange,
  onTokenObtained,
}: AzureCliAuthProps) {
  // ── Auth method toggle ────────────────────────────────────────────────────
  const [authMethod, setAuthMethod] = useState<AuthMethod>('azure_cli');

  // ── Azure CLI state ───────────────────────────────────────────────────────
  const [status, setStatus] = useState<AzureCliStatus>('checking');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isGettingToken, setIsGettingToken] = useState(false);

  // ── Databricks CLI profile state ──────────────────────────────────────────
  const [profiles, setProfiles] = useState<DatabricksProfile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<string>('');
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [profileVerified, setProfileVerified] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);

  // Load saved auth method preference on mount
  useEffect(() => {
    (async () => {
      try {
        const saved = await secureRetrieve('databricks_cli_profile');
        if (saved?.trim()) {
          setAuthMethod('databricks_cli');
          setSelectedProfile(saved.trim());
          setProfileVerified(true);
        }
      } catch { /* first run */ }
    })();
  }, []);

  // Load profiles when switching to CLI method
  useEffect(() => {
    if (authMethod !== 'databricks_cli') return;
    setProfilesLoading(true);
    invoke<DatabricksProfile[]>('list_databricks_profiles')
      .then(p => setProfiles(p))
      .catch(() => setProfiles([]))
      .finally(() => setProfilesLoading(false));
  }, [authMethod]);

  // Auto-fill workspace URL when profile selection changes
  useEffect(() => {
    if (!selectedProfile || authMethod !== 'databricks_cli') return;
    const profile = profiles.find(p => p.name === selectedProfile);
    if (profile?.host && (!baseUrl?.trim() || profiles.some(p => p.host === baseUrl?.trim()))) {
      onBaseUrlChange?.(profile.host);
    }
  }, [selectedProfile, profiles]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAuthMethodChange = (method: AuthMethod) => {
    setAuthMethod(method);
    setProfileVerified(false);
    setProfileError(null);
    setErrorMessage(null);
  };

  // ── Databricks CLI handlers ───────────────────────────────────────────────

  const handleVerifyProfile = async () => {
    if (!selectedProfile) return;
    setIsVerifying(true);
    setProfileError(null);
    try {
      const token = await invoke<string>('get_databricks_cli_token', { profile: selectedProfile });
      if (!token?.trim()) throw new Error('Empty token returned');
      // Save profile name — getValidDatabricksToken() will use it from now on
      await secureStore('databricks_cli_profile', selectedProfile.trim());
      // Also save workspace URL
      const profile = profiles.find(p => p.name === selectedProfile);
      if (profile?.host) {
        await secureStore('databricks_base_url', profile.host.trim());
        onBaseUrlChange?.(profile.host.trim());
      }
      setProfileVerified(true);
      onTokenObtained?.();
      toast.success(`Profile "${selectedProfile}" verified`, {
        description: profile?.has_pat
          ? 'Using personal access token.'
          : 'Using Databricks CLI OAuth token.',
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setProfileError(msg);
      toast.error('Verification failed', { description: msg });
    } finally {
      setIsVerifying(false);
    }
  };

  // ── Azure CLI handlers (unchanged) ───────────────────────────────────────

  const handleBaseUrlBlur = useCallback(async () => {
    if (baseUrl?.trim()) {
      try { await secureStore('databricks_base_url', baseUrl.trim()); } catch { /* ignore */ }
    }
  }, [baseUrl]);

  const handleEndpointBlur = useCallback(async () => {
    if (endpoint?.trim()) {
      try { await secureStore('databricks_endpoint_name', endpoint.trim()); } catch { /* ignore */ }
    }
  }, [endpoint]);

  const checkStatus = useCallback(async () => {
    setStatus('checking'); setErrorMessage(null);
    try { await invoke('check_azure_cli_installed'); }
    catch (e) { setStatus('not_installed'); setErrorMessage(e instanceof Error ? e.message : String(e)); return; }
    try { await invoke('check_azure_logged_in'); setStatus('ready'); }
    catch { setStatus('not_logged_in'); setErrorMessage('Not logged in. Click "Sign in with Azure CLI".'); }
  }, []);

  useEffect(() => { if (authMethod === 'azure_cli') checkStatus(); }, [authMethod, checkStatus]);

  const handleLogin = async () => {
    setIsLoading(true); setErrorMessage(null);
    try {
      await invoke('do_azure_login');
      toast.success('Login started', { description: 'Complete sign-in in the terminal/browser.' });
      await checkStatus();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMessage(msg); toast.error('Azure login failed', { description: msg });
    } finally { setIsLoading(false); }
  };

  const handleGetToken = async () => {
    if (!baseUrl?.trim()) { toast.error('Enter and save your Workspace URL first'); return; }
    setIsGettingToken(true); setErrorMessage(null);
    try {
      const token = await invoke<string>('get_databricks_token');
      if (token?.trim()) {
        await secureStore('databricks_token', token.trim());
        setStatus('token_obtained'); onTokenObtained?.();
        toast.success('Databricks token obtained and stored.');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMessage(msg); toast.error('Failed to get token', { description: msg });
    } finally { setIsGettingToken(false); }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4 border-t pt-4">

      {/* Auth method toggle */}
      <div>
        <Label className="mb-2 block">Authentication method</Label>
        <div className="flex rounded-lg overflow-hidden" style={{ border: '1px solid var(--separator)' }}>
          {(['azure_cli', 'databricks_cli'] as AuthMethod[]).map(m => (
            <button
              key={m}
              type="button"
              onClick={() => handleAuthMethodChange(m)}
              className="flex-1 text-xs font-medium py-1.5 px-3 transition-colors"
              style={{
                background: authMethod === m ? 'var(--accent-hex)' : 'var(--panel-elevated)',
                color: authMethod === m ? '#fff' : 'var(--text-secondary)',
                border: 'none', cursor: 'pointer',
              }}
            >
              {m === 'azure_cli' ? 'Azure CLI' : 'Databricks CLI profile'}
            </button>
          ))}
        </div>
      </div>

      {/* ── Databricks CLI profile path ── */}
      {authMethod === 'databricks_cli' && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Uses a profile from <code className="rounded bg-muted px-1">~/.databrickscfg</code>.
            PAT profiles work immediately; OAuth profiles require <code className="rounded bg-muted px-1">databricks auth login --profile &lt;name&gt;</code> to have been run once.
          </p>

          {profilesLoading ? (
            <p className="text-xs text-muted-foreground">Loading profiles…</p>
          ) : profiles.length === 0 ? (
            <Alert>
              <AlertDescription>
                No profiles found in <code>~/.databrickscfg</code>.
                Configure a profile with <code className="rounded bg-muted px-1">databricks configure --profile &lt;name&gt;</code>.
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <div>
                <Label htmlFor="cli-profile">Profile</Label>
                <select
                  id="cli-profile"
                  value={selectedProfile}
                  onChange={e => { setSelectedProfile(e.target.value); setProfileVerified(false); }}
                  className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                  style={{ background: 'var(--panel-elevated)', color: 'var(--text-primary)', border: '1px solid var(--separator)' }}
                >
                  <option value="">— select a profile —</option>
                  {profiles.map(p => (
                    <option key={p.name} value={p.name}>
                      {p.name}  ·  {p.host.replace('https://', '')}  ·  {p.has_pat ? 'PAT' : p.auth_type}
                    </option>
                  ))}
                </select>
              </div>

              {selectedProfile && (
                <Button
                  type="button"
                  onClick={handleVerifyProfile}
                  disabled={isVerifying}
                  variant={profileVerified ? 'outline' : 'default'}
                >
                  {isVerifying ? 'Verifying…' : profileVerified ? '✓ Verified — re-verify' : 'Verify & save'}
                </Button>
              )}

              {profileVerified && (
                <Alert>
                  <AlertDescription>
                    Profile <strong>{selectedProfile}</strong> is active. Summaries will use this profile's token automatically.
                  </AlertDescription>
                </Alert>
              )}
              {profileError && (
                <Alert variant="destructive">
                  <AlertDescription>{profileError}</AlertDescription>
                </Alert>
              )}
            </>
          )}

          {/* Endpoint still needed regardless of auth method */}
          <div>
            <Label htmlFor="databricks-endpoint-cli">Serving endpoint name *</Label>
            <Input
              id="databricks-endpoint-cli"
              value={endpoint}
              onChange={e => onEndpointChange(e.target.value)}
              onBlur={handleEndpointBlur}
              placeholder="my-chat-endpoint"
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Name of the Model Serving chat endpoint (workspace URL is auto-filled from the selected profile)
            </p>
          </div>
        </div>
      )}

      {/* ── Azure CLI path (existing, unchanged) ── */}
      {authMethod === 'azure_cli' && (
        <>
          <div>
            <Label htmlFor="databricks-base-url">Workspace URL *</Label>
            <Input
              id="databricks-base-url"
              value={baseUrl}
              onChange={e => onBaseUrlChange?.(e.target.value)}
              onBlur={handleBaseUrlBlur}
              placeholder="https://adb-xxxx.11.azuredatabricks.net"
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Your Databricks workspace URL
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            Uses the Azure CLI. Install it, sign in once, then obtain a token.
          </p>

          {status === 'not_installed' && (
            <Alert variant="destructive">
              <AlertDescription>
                <p className="font-medium">Azure CLI is not installed</p>
                <code className="mt-2 block rounded bg-muted px-2 py-1 font-mono text-sm">brew install azure-cli</code>
                <a href={AZURE_CLI_DOCS} target="_blank" rel="noopener noreferrer"
                  className="mt-2 inline-flex items-center gap-1 text-sm text-primary hover:underline">
                  Installation docs <ExternalLink className="h-3 w-3" />
                </a>
              </AlertDescription>
            </Alert>
          )}

          {status === 'not_logged_in' && (
            <Alert>
              <AlertDescription>
                <p className="font-medium">Not logged in to Azure</p>
                <Button type="button" className="mt-2" onClick={handleLogin} disabled={isLoading}>
                  {isLoading ? 'Starting login…' : 'Sign in with Azure CLI'}
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {(status === 'ready' || status === 'token_obtained') && (
            <>
              {status === 'token_obtained' && (
                <Alert><AlertDescription>Token obtained. You can generate summaries.</AlertDescription></Alert>
              )}
              <div>
                <Label htmlFor="databricks-endpoint">Serving endpoint name *</Label>
                <Input
                  id="databricks-endpoint"
                  value={endpoint}
                  onChange={e => onEndpointChange(e.target.value)}
                  onBlur={handleEndpointBlur}
                  placeholder="my-chat-endpoint"
                  className="mt-1"
                />
              </div>
              <Button type="button" onClick={handleGetToken}
                disabled={isGettingToken || !baseUrl?.trim()}>
                {isGettingToken ? 'Getting token…' : status === 'token_obtained' ? 'Refresh token' : 'Get Databricks token'}
              </Button>
            </>
          )}

          {errorMessage && status !== 'not_installed' && (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>
          )}

          <a href={AZURE_CLI_DOCS} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary">
            Azure CLI docs <ExternalLink className="h-3 w-3" />
          </a>
        </>
      )}
    </div>
  );
}
