'use client';

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';

interface GenieLiveSettingsState {
  copilotEnabled: boolean;
  databricksWorkspaceHost: string;
  databricksCliProfile: string;
  copilotIntervalMinutes: number;
  genieSearchScope: string;
  knowledgeStorePath: string;
}

interface GenieStatus {
  available: boolean;
  reason: 'connected' | 'not_configured' | 'connection_failed';
  tools: string[];
  workspace_host: string;
}

const DEFAULT: GenieLiveSettingsState = {
  copilotEnabled: false,
  databricksWorkspaceHost: '',
  databricksCliProfile: 'DEFAULT',
  copilotIntervalMinutes: 5,
  genieSearchScope: 'all',
  knowledgeStorePath: '',
};

export function GenieLiveSettings() {
  const [settings, setSettings] = useState<GenieLiveSettingsState>(DEFAULT);
  const [isSaving, setIsSaving] = useState(false);
  const [genieStatus, setGenieStatus] = useState<GenieStatus | null>(null);
  const [isTestingGenie, setIsTestingGenie] = useState(false);

  // Load settings on mount
  useEffect(() => {
    const load = async () => {
      try {
        const r = await fetch('http://localhost:5167/api/copilot/settings');
        if (r.ok) {
          const d = await r.json();
          setSettings({
            copilotEnabled: !!d.copilotEnabled,
            databricksWorkspaceHost: d.databricksWorkspaceHost || '',
            databricksCliProfile: d.databricksCliProfile || 'DEFAULT',
            copilotIntervalMinutes: d.copilotIntervalMinutes ?? 5,
            genieSearchScope: d.genieSearchScope || 'all',
            knowledgeStorePath: d.knowledgeStorePath || '',
          });
        }
      } catch {}
    };
    load();
  }, []);

  // Check Genie status on mount
  const checkGenieStatus = useCallback(async () => {
    setIsTestingGenie(true);
    try {
      const r = await fetch('http://localhost:5167/api/copilot/genie-status');
      if (r.ok) setGenieStatus(await r.json());
      else setGenieStatus({ available: false, reason: 'connection_failed', tools: [], workspace_host: '' });
    } catch {
      setGenieStatus({ available: false, reason: 'connection_failed', tools: [], workspace_host: '' });
    } finally {
      setIsTestingGenie(false);
    }
  }, []);

  useEffect(() => { checkGenieStatus(); }, [checkGenieStatus]);

  const isInvalid = settings.copilotEnabled && !settings.databricksWorkspaceHost.trim();
  const intervalTooShort = settings.copilotIntervalMinutes < 3;

  const handleSave = async () => {
    if (isInvalid) return;
    setIsSaving(true);
    try {
      const r = await fetch('http://localhost:5167/api/copilot/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          databricksWorkspaceHost: settings.databricksWorkspaceHost || null,
          databricksCliProfile: settings.databricksCliProfile || 'DEFAULT',
          copilotEnabled: settings.copilotEnabled,
          copilotIntervalMinutes: settings.copilotIntervalMinutes,
          genieSearchScope: settings.genieSearchScope,
          knowledgeStorePath: settings.knowledgeStorePath || '',
        }),
      });
      if (r.ok) {
        if (settings.copilotEnabled && genieStatus?.available) {
          toast.success(`Co-pilot saved — first hint in ${settings.copilotIntervalMinutes} minutes`);
        } else if (settings.copilotEnabled && !genieStatus?.available) {
          toast.success('Genie Live active in LLM fallback mode — Genie unreachable');
        } else {
          toast.success('Genie Live settings saved');
        }
        // Refresh Genie status after save (workspace host may have changed)
        checkGenieStatus();
      } else {
        toast.error('Failed to save settings');
      }
    } catch {
      toast.error('Error saving settings. Is the backend running?');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6 py-6">
      <div>
        <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-1">Genie Live Settings</h2>
        <p className="text-sm text-[var(--text-secondary)]">
          Analyses the meeting transcript every few minutes and surfaces Databricks talking points
          grounded by Genie, connected to your enterprise knowledge base and internal resources.
        </p>
      </div>

      {/* Enable toggle */}
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-3 cursor-pointer select-none">
          <div className="relative">
            <input
              type="checkbox"
              className="sr-only"
              checked={settings.copilotEnabled}
              onChange={e => setSettings(s => ({ ...s, copilotEnabled: e.target.checked }))}
            />
            <div className={`w-11 h-6 rounded-full transition-colors ${settings.copilotEnabled ? 'bg-blue-600' : 'bg-gray-300'}`}>
              <div className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${settings.copilotEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
            </div>
          </div>
          <span className="text-sm font-medium text-[var(--text-primary)]">
            {settings.copilotEnabled ? 'Genie Live enabled' : 'Genie Live disabled'}
          </span>
        </label>
      </div>

      {isInvalid && (
        <p className="text-xs text-red-600">Workspace host required to enable Genie Live</p>
      )}

      {/* Genie connection status */}
      <GenieStatusBadge status={genieStatus} isTesting={isTestingGenie} onTest={checkGenieStatus} />

      {/* Configuration fields */}
      <div className="space-y-4">
        {/* Workspace host */}
        <div>
          <label className="block text-sm font-medium text-[var(--text-primary)] mb-1">
            Databricks Workspace Host
            <span className="text-[var(--text-secondary)] font-normal ml-1">(required)</span>
          </label>
          <input
            type="url"
            className="w-full px-3 py-2 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            style={{ border: '1px solid var(--separator)', background: 'var(--panel-elevated)', color: 'var(--text-primary)' }}
            placeholder="https://adb-xxxx.azuredatabricks.net"
            value={settings.databricksWorkspaceHost}
            onChange={e => setSettings(s => ({ ...s, databricksWorkspaceHost: e.target.value }))}
          />
        </div>

        {/* CLI Profile */}
        <div>
          <label className="block text-sm font-medium text-[var(--text-primary)] mb-1">Databricks CLI Profile</label>
          <input
            type="text"
            className="w-full px-3 py-2 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            style={{ border: '1px solid var(--separator)', background: 'var(--panel-elevated)', color: 'var(--text-primary)' }}
            placeholder="DEFAULT"
            value={settings.databricksCliProfile}
            onChange={e => setSettings(s => ({ ...s, databricksCliProfile: e.target.value }))}
          />
          <p className="text-xs text-[var(--text-secondary)] mt-1">Profile name from your ~/.databrickscfg file.</p>
        </div>

        {/* Interval */}
        <div>
          <label className="block text-sm font-medium text-[var(--text-primary)] mb-1">Analyse every (minutes)</label>
          <input
            type="number"
            min={3}
            max={30}
            className={`w-32 px-3 py-2 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${intervalTooShort ? 'border-amber-400 border' : ''}`}
            style={!intervalTooShort ? { border: '1px solid var(--separator)', background: 'var(--panel-elevated)', color: 'var(--text-primary)' } : { background: 'var(--panel-elevated)', color: 'var(--text-primary)' }}
            value={settings.copilotIntervalMinutes}
            onChange={e =>
              setSettings(s => ({
                ...s,
                copilotIntervalMinutes: Math.max(1, Math.min(30, parseInt(e.target.value) || 5)),
              }))
            }
          />
          {intervalTooShort && (
            <p className="text-xs text-amber-600 mt-1">
              Intervals below 3 minutes may result in overlapping Genie calls.
            </p>
          )}
          {!intervalTooShort && (
            <p className="text-xs text-[var(--text-secondary)] mt-1">Minimum 3 minutes recommended (1–30).</p>
          )}
        </div>

        {/* Search scope */}
        <div>
          <label className="block text-sm font-medium text-[var(--text-primary)] mb-1">Genie Search Scope</label>
          <select
            className="w-full px-3 py-2 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            style={{ border: '1px solid var(--separator)', background: 'var(--panel-elevated)', color: 'var(--text-primary)' }}
            value={settings.genieSearchScope}
            onChange={e => setSettings(s => ({ ...s, genieSearchScope: e.target.value }))}
          >
            <option value="all">All connected sources</option>
            <option value="internal">Databricks internal only</option>
          </select>
          <p className="text-xs text-[var(--text-secondary)] mt-1">
            Controls which Genie knowledge base sources are searched.
          </p>
        </div>

        {/* Knowledge store path */}
        <div>
          <label className="block text-sm font-medium text-[var(--text-primary)] mb-1">
            Knowledge Store Path
          </label>
          <input
            type="text"
            className="w-full px-3 py-2 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
            style={{ border: '1px solid var(--separator)', background: 'var(--panel-elevated)', color: 'var(--text-primary)' }}
            placeholder="~/path/to/genie-live-knowledge"
            value={settings.knowledgeStorePath}
            onChange={e => setSettings(s => ({ ...s, knowledgeStorePath: e.target.value }))}
          />
          <p className="text-xs text-[var(--text-secondary)] mt-1">
            Folder containing <code>products/</code>, <code>customers/</code>, and <code>competitive/</code> markdown files
            used as context for Genie suggestions. Leave blank to use the auto-detected Google Drive location.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={isSaving || isInvalid}>
          {isSaving ? (
            <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</>
          ) : 'Save Settings'}
        </Button>
      </div>
    </div>
  );
}

function GenieStatusBadge({
  status,
  isTesting,
  onTest,
}: {
  status: GenieStatus | null;
  isTesting: boolean;
  onTest: () => void;
}) {
  if (isTesting) {
    return (
      <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
        <Loader2 className="w-3 h-3 animate-spin" />
        Checking Genie connection…
      </div>
    );
  }

  if (!status) return null;

  const dot =
    status.reason === 'connected'
      ? 'bg-green-500'
      : status.reason === 'not_configured'
        ? 'bg-gray-400'
        : 'bg-red-500';

  const label =
    status.reason === 'connected'
      ? `Genie connected — ${status.tools.length} tool${status.tools.length !== 1 ? 's' : ''} available`
      : status.reason === 'not_configured'
        ? 'Not configured'
        : status.reason.includes('write tool')
          ? 'Genie write tools blocked — workspace admin must enable MCP write access'
          : status.reason === 'connection_failed'
            ? 'Genie unavailable — check workspace host and CLI profile'
            : `Genie unavailable — ${status.reason}`;

  const labelColor =
    status.reason === 'connected'
      ? 'text-green-700'
      : status.reason === 'not_configured'
        ? 'text-[var(--text-secondary)]'
        : 'text-red-700';

  return (
    <div className="flex items-center gap-3 p-3" style={{ background: 'var(--panel-elevated)', border: '1px solid var(--separator)', borderRadius: '0.5rem' }}>
      <div className="flex items-center gap-2 flex-1">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
        <span className={`text-xs font-medium ${labelColor}`}>{label}</span>
      </div>
      <button
        onClick={onTest}
        className="text-xs text-blue-600 hover:text-blue-800 hover:underline flex-shrink-0"
      >
        Test Connection
      </button>
    </div>
  );
}
