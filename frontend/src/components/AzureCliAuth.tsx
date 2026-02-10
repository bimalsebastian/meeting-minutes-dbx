'use client';

import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { toast } from 'sonner';
import { ExternalLink } from 'lucide-react';

export type AzureCliStatus = 'checking' | 'not_installed' | 'not_logged_in' | 'ready' | 'token_obtained';

const AZURE_CLI_DOCS = 'https://learn.microsoft.com/en-us/cli/azure/install-azure-cli';

export interface AzureCliAuthProps {
  endpoint: string;
  onEndpointChange: (endpoint: string) => void;
  baseUrl?: string;
  onBaseUrlChange?: (url: string) => void;
  onTokenObtained?: () => void;
}

export function AzureCliAuth({
  endpoint,
  onEndpointChange,
  baseUrl = '',
  onBaseUrlChange,
  onTokenObtained,
}: AzureCliAuthProps) {
  const [status, setStatus] = useState<AzureCliStatus>('checking');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isGettingToken, setIsGettingToken] = useState(false);

  const checkStatus = useCallback(async () => {
    setStatus('checking');
    setErrorMessage(null);
    try {
      await invoke('check_azure_cli_installed');
    } catch (e) {
      setStatus('not_installed');
      setErrorMessage(e instanceof Error ? e.message : String(e));
      return;
    }
    try {
      await invoke('check_azure_logged_in');
      setStatus('ready');
    } catch {
      setStatus('not_logged_in');
      setErrorMessage('You are not logged in to Azure. Click "Sign in with Azure CLI" to open the login flow.');
    }
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  const handleLogin = async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      await invoke('do_azure_login');
      toast.success('Login started', {
        description: 'Complete sign-in in the terminal or browser window that opened.',
      });
      await checkStatus();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMessage(msg);
      toast.error('Azure login failed', { description: msg });
    } finally {
      setIsLoading(false);
    }
  };

  const handleGetToken = async () => {
    if (!baseUrl?.trim()) {
      toast.error('Enter and save your Workspace URL first');
      return;
    }
    setIsGettingToken(true);
    setErrorMessage(null);
    try {
      const token = await invoke<string>('get_databricks_token');
      if (token?.trim()) {
        await invoke('secure_store', { key: 'databricks_token', value: token.trim() });
        setStatus('token_obtained');
        onTokenObtained?.();
        toast.success('Databricks token obtained and stored.');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMessage(msg);
      toast.error('Failed to get token', { description: msg });
    } finally {
      setIsGettingToken(false);
    }
  };

  if (status === 'checking') {
    return (
      <div className="text-sm text-muted-foreground">Checking Azure CLI…</div>
    );
  }

  return (
    <div className="space-y-4 border-t pt-4">
      <div>
        <Label htmlFor="databricks-base-url">Workspace URL *</Label>
        <Input
          id="databricks-base-url"
          value={baseUrl}
          onChange={(e) => onBaseUrlChange?.(e.target.value)}
          placeholder="https://adb-xxxx.11.azuredatabricks.net"
          className="mt-1"
        />
        <p className="text-xs text-muted-foreground mt-1">
          Your Databricks workspace URL (Azure: e.g. https://adb-xxxx.11.azuredatabricks.net)
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        Databricks authentication uses the Azure CLI. No app registration or redirect URIs are needed.
        Install the Azure CLI, sign in once, then obtain a token for this app.
      </p>

      {status === 'not_installed' && (
        <Alert variant="destructive">
          <AlertDescription>
            <p className="font-medium">Azure CLI is not installed</p>
            <p className="mt-1 text-sm">Install with:</p>
            <code className="mt-2 block rounded bg-muted px-2 py-1 font-mono text-sm">
              brew install azure-cli
            </code>
            <a
              href={AZURE_CLI_DOCS}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-sm text-primary hover:underline"
            >
              Installation docs <ExternalLink className="h-3 w-3" />
            </a>
          </AlertDescription>
        </Alert>
      )}

      {status === 'not_logged_in' && (
        <Alert>
          <AlertDescription>
            <p className="font-medium">Not logged in to Azure</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Click the button below to run <code className="rounded bg-muted px-1">az login --use-device-code</code>.
              Complete sign-in in the browser or terminal.
            </p>
            <Button
              type="button"
              className="mt-2"
              onClick={handleLogin}
              disabled={isLoading}
            >
              {isLoading ? 'Starting login…' : 'Sign in with Azure CLI'}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {(status === 'ready' || status === 'token_obtained') && (
        <>
          {status === 'token_obtained' && (
            <Alert>
              <AlertDescription>
                Databricks token has been obtained and stored. You can generate summaries using the Databricks model.
              </AlertDescription>
            </Alert>
          )}
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
          <Button
            type="button"
            onClick={handleGetToken}
            disabled={isGettingToken || !baseUrl?.trim()}
          >
            {isGettingToken ? 'Getting token…' : status === 'token_obtained' ? 'Refresh Databricks token' : 'Get Databricks token'}
          </Button>
        </>
      )}

      {errorMessage && status !== 'not_installed' && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}

      <a
        href={AZURE_CLI_DOCS}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
      >
        Azure CLI installation docs <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}
