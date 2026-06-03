'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';

interface CopilotSettingsState {
  copilotEnabled: boolean;
  databricksWorkspaceHost: string;
  databricksCliProfile: string;
  copilotIntervalMinutes: number;
}

const DEFAULT_SETTINGS: CopilotSettingsState = {
  copilotEnabled: false,
  databricksWorkspaceHost: '',
  databricksCliProfile: 'DEFAULT',
  copilotIntervalMinutes: 5,
};

export function CopilotSettings() {
  const [settings, setSettings] = useState<CopilotSettingsState>(DEFAULT_SETTINGS);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  // Load settings on mount
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const r = await fetch('http://localhost:5167/api/copilot/settings');
        if (r.ok) {
          const data = await r.json();
          setSettings({
            copilotEnabled: !!data.copilotEnabled,
            databricksWorkspaceHost: data.databricksWorkspaceHost || '',
            databricksCliProfile: data.databricksCliProfile || 'DEFAULT',
            copilotIntervalMinutes: data.copilotIntervalMinutes ?? 5,
          });
        }
      } catch (e) {
        console.error('Failed to load copilot settings:', e);
      }
    };
    loadSettings();
  }, []);

  const handleSave = async () => {
    setIsSaving(true);
    setSaveMessage(null);
    try {
      const r = await fetch('http://localhost:5167/api/copilot/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          copilotEnabled: settings.copilotEnabled,
          databricksWorkspaceHost: settings.databricksWorkspaceHost || null,
          databricksCliProfile: settings.databricksCliProfile || 'DEFAULT',
          copilotIntervalMinutes: settings.copilotIntervalMinutes,
        }),
      });
      if (r.ok) {
        setSaveMessage('Settings saved successfully.');
      } else {
        setSaveMessage('Failed to save settings.');
      }
    } catch (e) {
      setSaveMessage('Error saving settings. Is the backend running?');
    } finally {
      setIsSaving(false);
      setTimeout(() => setSaveMessage(null), 3000);
    }
  };

  return (
    <div className="space-y-6 py-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-900 mb-1">Co-pilot Settings</h2>
        <p className="text-sm text-gray-500">
          The SA Co-pilot analyses the last 5 minutes of transcript at regular intervals and surfaces
          relevant Databricks talking points during your meeting.
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
            <div
              className={`w-11 h-6 rounded-full transition-colors ${settings.copilotEnabled ? 'bg-blue-600' : 'bg-gray-300'}`}
              onClick={() => setSettings(s => ({ ...s, copilotEnabled: !s.copilotEnabled }))}
            >
              <div
                className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${settings.copilotEnabled ? 'translate-x-5' : 'translate-x-0'}`}
              />
            </div>
          </div>
          <span className="text-sm font-medium text-gray-700">
            {settings.copilotEnabled ? 'Co-pilot enabled' : 'Co-pilot disabled'}
          </span>
        </label>
      </div>

      {/* Conditional fields shown when enabled */}
      {settings.copilotEnabled && (
        <div className="space-y-4 pl-2 border-l-2 border-blue-200">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Databricks Workspace Host
              <span className="text-gray-400 font-normal ml-1">(optional — required for Genie grounding)</span>
            </label>
            <input
              type="text"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="https://adb-1234567890.azuredatabricks.net"
              value={settings.databricksWorkspaceHost}
              onChange={e => setSettings(s => ({ ...s, databricksWorkspaceHost: e.target.value }))}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Databricks CLI Profile
            </label>
            <input
              type="text"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="DEFAULT"
              value={settings.databricksCliProfile}
              onChange={e => setSettings(s => ({ ...s, databricksCliProfile: e.target.value }))}
            />
            <p className="text-xs text-gray-400 mt-1">
              Profile name from your ~/.databrickscfg file.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Analysis interval (minutes)
            </label>
            <input
              type="number"
              min={1}
              max={30}
              className="w-32 px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={settings.copilotIntervalMinutes}
              onChange={e => setSettings(s => ({ ...s, copilotIntervalMinutes: Math.max(1, Math.min(30, parseInt(e.target.value) || 5)) }))}
            />
            <p className="text-xs text-gray-400 mt-1">
              How often the co-pilot analyses the transcript (1&ndash;30 minutes).
            </p>
          </div>

          <div className="bg-blue-50 border border-blue-200 rounded-md p-3">
            <p className="text-xs text-blue-700">
              <strong>Note:</strong> The co-pilot uses your configured Summary Model provider and
              model. Configure the provider in the Summary tab.
            </p>
          </div>
        </div>
      )}

      <div className="flex items-center gap-4">
        <Button onClick={handleSave} disabled={isSaving}>
          {isSaving ? 'Saving...' : 'Save Settings'}
        </Button>
        {saveMessage && (
          <span className={`text-sm ${saveMessage.includes('successfully') ? 'text-green-600' : 'text-red-600'}`}>
            {saveMessage}
          </span>
        )}
      </div>
    </div>
  );
}
