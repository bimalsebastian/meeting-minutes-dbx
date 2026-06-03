"use client"

import { useEffect, useState, useRef } from "react"
import { Switch } from "./ui/switch"
import { Label } from "./ui/label"
import { Input } from "./ui/input"
import { FolderOpen, Calendar } from "lucide-react"
import { invoke } from "@tauri-apps/api/core"
import Analytics from "@/lib/analytics"
import AnalyticsConsentSwitch from "./AnalyticsConsentSwitch"
import { useConfig, NotificationSettings } from "@/contexts/ConfigContext"

const CALENDAR_STORE_KEYS = {
  enabled: 'calendar_auto_start_enabled',
  refreshIntervalMinutes: 'calendar_refresh_interval_minutes',
} as const
const DEFAULT_REFRESH_INTERVAL_MINUTES = 5

export function PreferenceSettings() {
  const {
    notificationSettings,
    storageLocations,
    isLoadingPreferences,
    loadPreferences,
    updateNotificationSettings
  } = useConfig();

  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean | null>(null);
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const [previousNotificationsEnabled, setPreviousNotificationsEnabled] = useState<boolean | null>(null);
  const hasTrackedViewRef = useRef(false);

  const [calendarAutoStartEnabled, setCalendarAutoStartEnabled] = useState<boolean>(false);
  const [calendarRefreshIntervalMinutes, setCalendarRefreshIntervalMinutes] = useState<number>(DEFAULT_REFRESH_INTERVAL_MINUTES);
  const [calendarSettingsLoaded, setCalendarSettingsLoaded] = useState(false);

  const [recallEnabled, setRecallEnabled] = useState<boolean>(true);
  const [recallSettingsLoaded, setRecallSettingsLoaded] = useState(false);

  // Lazy load preferences on mount (only loads if not already cached)
  useEffect(() => {
    loadPreferences();
    // Reset tracking ref on mount (every tab visit)
    hasTrackedViewRef.current = false;
  }, [loadPreferences]);

  // Load calendar auto-start settings from store
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const { Store } = await import('@tauri-apps/plugin-store');
        const store = await Store.load('preferences.json');
        const enabled = await store.get<boolean>(CALENDAR_STORE_KEYS.enabled);
        const interval = await store.get<number>(CALENDAR_STORE_KEYS.refreshIntervalMinutes);
        if (mounted) {
          setCalendarAutoStartEnabled(enabled ?? false);
          setCalendarRefreshIntervalMinutes(interval ?? DEFAULT_REFRESH_INTERVAL_MINUTES);
          setCalendarSettingsLoaded(true);
        }
      } catch (e) {
        console.error('Failed to load calendar settings:', e);
        if (mounted) setCalendarSettingsLoaded(true);
      }
    })();
    return () => { mounted = false; };
  }, []);

  // Load recall_enabled from backend on mount
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const resp = await fetch('http://localhost:5167/api/recall/upcoming');
        if (resp.ok) {
          const data = await resp.json();
          if (mounted) {
            setRecallEnabled(data.recall_enabled ?? true);
          }
        }
      } catch (e) {
        // Backend may not be running; default to true
      } finally {
        if (mounted) setRecallSettingsLoaded(true);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const saveRecallEnabled = async (enabled: boolean) => {
    setRecallEnabled(enabled);
    try {
      await fetch('http://localhost:5167/api/recall/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recall_enabled: enabled }),
      });
    } catch (e) {
      console.error('Failed to save recall settings:', e);
    }
  };

  const saveCalendarSettings = async (enabled: boolean, intervalMinutes: number) => {
    try {
      const { Store } = await import('@tauri-apps/plugin-store');
      const store = await Store.load('preferences.json');
      await store.set(CALENDAR_STORE_KEYS.enabled, enabled);
      await store.set(CALENDAR_STORE_KEYS.refreshIntervalMinutes, Math.max(1, Math.min(60, intervalMinutes)));
      await store.save();
    } catch (e) {
      console.error('Failed to save calendar settings:', e);
    }
  };

  // Track preferences viewed analytics on every tab visit (once per mount)
  useEffect(() => {
    if (hasTrackedViewRef.current) return;

    const trackPreferencesViewed = async () => {
      // Wait for notification settings to be available (either from cache or after loading)
      if (notificationSettings) {
        await Analytics.track('preferences_viewed', {
          notifications_enabled: notificationSettings.notification_preferences.show_recording_started ? 'true' : 'false'
        });
        hasTrackedViewRef.current = true;
      } else if (!isLoadingPreferences) {
        // If not loading and no settings available, track with default value
        await Analytics.track('preferences_viewed', {
          notifications_enabled: 'false'
        });
        hasTrackedViewRef.current = true;
      }
    };

    trackPreferencesViewed();
  }, [notificationSettings, isLoadingPreferences]);

  // Update notificationsEnabled when notificationSettings are loaded from global state
  useEffect(() => {
    if (notificationSettings) {
      // Notification enabled means both started and stopped notifications are enabled
      const enabled =
        notificationSettings.notification_preferences.show_recording_started &&
        notificationSettings.notification_preferences.show_recording_stopped;
      setNotificationsEnabled(enabled);
      if (isInitialLoad) {
        setPreviousNotificationsEnabled(enabled);
        setIsInitialLoad(false);
      }
    } else if (!isLoadingPreferences) {
      // If not loading and no settings, use default
      setNotificationsEnabled(true);
      if (isInitialLoad) {
        setPreviousNotificationsEnabled(true);
        setIsInitialLoad(false);
      }
    }
  }, [notificationSettings, isLoadingPreferences, isInitialLoad])

  useEffect(() => {
    // Skip update on initial load or if value hasn't actually changed
    if (isInitialLoad || notificationsEnabled === null || notificationsEnabled === previousNotificationsEnabled) return;
    if (!notificationSettings) return;

    const handleUpdateNotificationSettings = async () => {
      console.log("Updating notification settings to:", notificationsEnabled);

      try {
        // Update the notification preferences
        const updatedSettings: NotificationSettings = {
          ...notificationSettings,
          notification_preferences: {
            ...notificationSettings.notification_preferences,
            show_recording_started: notificationsEnabled,
            show_recording_stopped: notificationsEnabled,
          }
        };

        console.log("Calling updateNotificationSettings with:", updatedSettings);
        await updateNotificationSettings(updatedSettings);
        setPreviousNotificationsEnabled(notificationsEnabled);
        console.log("Successfully updated notification settings to:", notificationsEnabled);

        // Track notification preference change - only fires when user manually toggles
        await Analytics.track('notification_settings_changed', {
          notifications_enabled: notificationsEnabled.toString()
        });
      } catch (error) {
        console.error('Failed to update notification settings:', error);
      }
    };

    handleUpdateNotificationSettings();
  }, [notificationsEnabled, notificationSettings, isInitialLoad, previousNotificationsEnabled, updateNotificationSettings])

  const handleOpenFolder = async (folderType: 'database' | 'models' | 'recordings') => {
    try {
      switch (folderType) {
        case 'database':
          await invoke('open_database_folder');
          break;
        case 'models':
          await invoke('open_models_folder');
          break;
        case 'recordings':
          await invoke('open_recordings_folder');
          break;
      }

      // Track storage folder access
      await Analytics.track('storage_folder_opened', {
        folder_type: folderType
      });
    } catch (error) {
      console.error(`Failed to open ${folderType} folder:`, error);
    }
  };

  // Show loading only if we're actually loading and don't have cached data
  if (isLoadingPreferences && !notificationSettings && !storageLocations) {
    return <div className="max-w-2xl mx-auto p-6">Loading Preferences...</div>
  }

  // Show loading if notificationsEnabled hasn't been determined yet
  if (notificationsEnabled === null && !isLoadingPreferences) {
    return <div className="max-w-2xl mx-auto p-6">Loading Preferences...</div>
  }

  // Ensure we have a boolean value for the Switch component
  const notificationsEnabledValue = notificationsEnabled ?? false;

  return (
    <div className="space-y-6">
      {/* Notifications Section */}
      <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Notifications</h3>
            <p className="text-sm text-gray-600">Enable or disable notifications of start and end of meeting</p>
          </div>
          <Switch checked={notificationsEnabledValue} onCheckedChange={setNotificationsEnabled} />
        </div>
      </div>

      {/* Calendar auto-start Section */}
      <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-2">
          <Calendar className="w-5 h-5 text-gray-600" />
          <h3 className="text-lg font-semibold text-gray-900">Calendar auto-start</h3>
        </div>
        <p className="text-sm text-gray-600 mb-4">
          When enabled, Meetily checks Google Calendar for meetings in the next 10 minutes and can start recording when Zoom, Teams, or Meet is the active window.
        </p>
        {calendarSettingsLoaded && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <Label htmlFor="calendar-auto-start" className="text-sm font-medium">Enable auto-start</Label>
              <Switch
                id="calendar-auto-start"
                checked={calendarAutoStartEnabled}
                onCheckedChange={async (checked) => {
                  setCalendarAutoStartEnabled(checked);
                  await saveCalendarSettings(checked, calendarRefreshIntervalMinutes);
                }}
              />
            </div>
            <div>
              <Label htmlFor="calendar-refresh-interval" className="text-sm font-medium">Check every (minutes)</Label>
              <Input
                id="calendar-refresh-interval"
                type="number"
                min={1}
                max={60}
                value={calendarRefreshIntervalMinutes}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (!Number.isNaN(v)) setCalendarRefreshIntervalMinutes(v);
                }}
                onBlur={async () => {
                  const v = Math.max(1, Math.min(60, calendarRefreshIntervalMinutes));
                  setCalendarRefreshIntervalMinutes(v);
                  await saveCalendarSettings(calendarAutoStartEnabled, v);
                }}
                className="mt-1 w-20"
              />
              <p className="text-xs text-muted-foreground mt-1">Poll calendar every 1–60 minutes (default 5).</p>
            </div>
          </div>
        )}
      </div>

      {/* Pre-Meeting Recall Section */}
      <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Pre-Meeting Recall</h3>
            <p className="text-sm text-gray-600">
              Show a brief of past meetings 15 minutes before calendar events start. Requires Google Calendar connection.
            </p>
          </div>
          <Switch
            id="recall-enabled"
            checked={recallEnabled}
            onCheckedChange={saveRecallEnabled}
            disabled={!recallSettingsLoaded}
          />
        </div>
      </div>

      {/* Data Storage Locations Section */}
      <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Data Storage Locations</h3>
        <p className="text-sm text-gray-600 mb-6">
          View and access where Meetily stores your data
        </p>

        <div className="space-y-4">
          {/* Database Location */}
          {/* <div className="p-4 border rounded-lg bg-gray-50">
            <div className="font-medium mb-2">Database</div>
            <div className="text-sm text-gray-600 mb-3 break-all font-mono text-xs">
              {storageLocations?.database || 'Loading...'}
            </div>
            <button
              onClick={() => handleOpenFolder('database')}
              className="flex items-center gap-2 px-3 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-100 transition-colors"
            >
              <FolderOpen className="w-4 h-4" />
              Open Folder
            </button>
          </div> */}

          {/* Models Location */}
          {/* <div className="p-4 border rounded-lg bg-gray-50">
            <div className="font-medium mb-2">Whisper Models</div>
            <div className="text-sm text-gray-600 mb-3 break-all font-mono text-xs">
              {storageLocations?.models || 'Loading...'}
            </div>
            <button
              onClick={() => handleOpenFolder('models')}
              className="flex items-center gap-2 px-3 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-100 transition-colors"
            >
              <FolderOpen className="w-4 h-4" />
              Open Folder
            </button>
          </div> */}

          {/* Recordings Location */}
          <div className="p-4 border rounded-lg bg-gray-50">
            <div className="font-medium mb-2">Meeting Recordings</div>
            <div className="text-sm text-gray-600 mb-3 break-all font-mono text-xs">
              {storageLocations?.recordings || 'Loading...'}
            </div>
            <button
              onClick={() => handleOpenFolder('recordings')}
              className="flex items-center gap-2 px-3 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-100 transition-colors"
            >
              <FolderOpen className="w-4 h-4" />
              Open Folder
            </button>
          </div>
        </div>

        <div className="mt-4 p-3 bg-blue-50 rounded-md">
          <p className="text-xs text-blue-800">
            <strong>Note:</strong> Database and models are stored together in your application data directory for unified management.
          </p>
        </div>
      </div>

      {/* Analytics Section */}
      <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
        <AnalyticsConsentSwitch />
      </div>
    </div>
  )
}
