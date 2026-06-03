'use client';

import React, { useState, useEffect } from 'react';
import { ExternalLink, CheckCircle2, XCircle, Loader2 } from 'lucide-react';

export default function CalendarSettings() {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [connected, setConnected] = useState(false);
  const [hasCredentials, setHasCredentials] = useState(false);
  const [clientIdPreview, setClientIdPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState<'success' | 'error'>('success');

  // On mount: check connection status and whether credentials are stored
  useEffect(() => {
    const loadStatus = async () => {
      try {
        const [statusRes, credsRes] = await Promise.all([
          fetch('http://localhost:5167/api/calendar/status'),
          fetch('http://localhost:5167/api/calendar/credentials'),
        ]);
        const statusData = await statusRes.json();
        const credsData = await credsRes.json();
        setConnected(statusData.connected ?? false);
        setHasCredentials(credsData.has_credentials ?? false);
        setClientIdPreview(credsData.client_id_preview ?? null);
      } catch {
        // backend may not be running; ignore
      }
    };
    loadStatus();
  }, []);

  const showMessage = (msg: string, type: 'success' | 'error' = 'success') => {
    setMessage(msg);
    setMessageType(type);
    setTimeout(() => setMessage(''), 4000);
  };

  const handleSaveCredentials = async () => {
    if (!clientId.trim() || !clientSecret.trim()) {
      showMessage('Please enter both Client ID and Client Secret.', 'error');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('http://localhost:5167/api/calendar/save-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId.trim(), client_secret: clientSecret.trim() }),
      });
      if (!res.ok) throw new Error(await res.text());
      setHasCredentials(true);
      setClientIdPreview(clientId.trim().substring(0, 8) + '...');
      setClientId('');
      setClientSecret('');
      showMessage('Credentials saved successfully.');
    } catch (err) {
      showMessage('Failed to save credentials. Please try again.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const res = await fetch('http://localhost:5167/api/calendar/auth');
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showMessage(data.detail || 'Failed to start authorization. Check credentials.', 'error');
        return;
      }
      const { auth_url } = await res.json();
      window.open(auth_url, '_blank', 'width=500,height=700');

      // Poll status every 3s for up to 60s to detect successful auth
      const poll = setInterval(async () => {
        try {
          const s = await fetch('http://localhost:5167/api/calendar/status').then(r => r.json());
          if (s.connected) {
            setConnected(true);
            clearInterval(poll);
            setConnecting(false);
            showMessage('Google Calendar connected successfully!');
          }
        } catch {
          // ignore poll errors
        }
      }, 3000);
      setTimeout(() => {
        clearInterval(poll);
        setConnecting(false);
      }, 60000);
    } catch {
      showMessage('Failed to initiate Google authorization.', 'error');
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await fetch('http://localhost:5167/api/calendar/disconnect', { method: 'POST' });
      setConnected(false);
      showMessage('Disconnected from Google Calendar.');
    } catch {
      showMessage('Failed to disconnect. Please try again.', 'error');
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <div className="space-y-6 p-4 max-w-xl">
      {/* Header */}
      <div>
        <h3 className="text-sm font-semibold mb-1">Google Calendar Integration</h3>
        <p className="text-xs text-gray-500 mb-4">
          Auto-split recordings when calendar events end and name meetings from event titles.
        </p>
      </div>

      {/* Credential helper */}
      <div className="p-3 bg-blue-50 rounded-lg text-xs text-blue-700 space-y-1">
        <p>
          You&apos;ll need your own Google OAuth 2.0 credentials.{' '}
          <a
            href="https://console.cloud.google.com/apis/credentials"
            target="_blank"
            rel="noopener noreferrer"
            className="underline font-medium inline-flex items-center gap-1"
          >
            Create credentials <ExternalLink className="w-3 h-3" />
          </a>
        </p>
        <p>
          Set the OAuth redirect URI to:{' '}
          <code className="bg-blue-100 px-1 rounded">http://localhost:5167/api/calendar/callback</code>
        </p>
        <p>Enable the <strong>Google Calendar API</strong> in your Google Cloud project.</p>
      </div>

      {/* Credentials form */}
      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Client ID
            {hasCredentials && clientIdPreview && (
              <span className="ml-2 text-gray-400 font-normal">
                (current: <code>{clientIdPreview}</code>)
              </span>
            )}
          </label>
          <input
            type="text"
            value={clientId}
            onChange={e => setClientId(e.target.value)}
            placeholder="xxxxxxxxxxxx-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.apps.googleusercontent.com"
            className="w-full px-3 py-2 text-xs border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Client Secret</label>
          <input
            type="password"
            value={clientSecret}
            onChange={e => setClientSecret(e.target.value)}
            placeholder="GOCSPX-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            className="w-full px-3 py-2 text-xs border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>
        <button
          onClick={handleSaveCredentials}
          disabled={saving}
          className="px-4 py-2 text-xs bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
        >
          {saving && <Loader2 className="w-3 h-3 animate-spin" />}
          {saving ? 'Saving...' : 'Save Credentials'}
        </button>
      </div>

      {/* Connection status */}
      <div className="border-t border-gray-100 pt-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {connected ? (
              <CheckCircle2 className="w-4 h-4 text-green-500" />
            ) : (
              <XCircle className="w-4 h-4 text-gray-300" />
            )}
            <span className="text-sm font-medium">
              {connected ? 'Connected to Google Calendar' : 'Not connected'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {!connected && (
              <button
                onClick={handleConnect}
                disabled={connecting || !hasCredentials}
                title={!hasCredentials ? 'Save credentials first' : undefined}
                className="px-3 py-1.5 text-xs bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 flex items-center gap-1"
              >
                {connecting && <Loader2 className="w-3 h-3 animate-spin" />}
                {connecting ? 'Opening browser...' : 'Connect'}
              </button>
            )}
            {connected && (
              <button
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="px-3 py-1.5 text-xs border border-red-300 text-red-600 rounded-md hover:bg-red-50 disabled:opacity-50 flex items-center gap-1"
              >
                {disconnecting && <Loader2 className="w-3 h-3 animate-spin" />}
                {disconnecting ? 'Disconnecting...' : 'Disconnect'}
              </button>
            )}
          </div>
        </div>
        {connecting && (
          <p className="text-xs text-blue-600 mt-2">
            A browser window has opened. Complete the sign-in and return here.
          </p>
        )}
      </div>

      {/* Status message */}
      {message && (
        <p className={`text-xs ${messageType === 'error' ? 'text-red-600' : 'text-green-600'}`}>
          {message}
        </p>
      )}
    </div>
  );
}
