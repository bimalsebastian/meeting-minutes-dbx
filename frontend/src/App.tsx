'use client'

import { useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'

/**
 * Databricks now uses the device code flow (no redirect/callback).
 * OAuth deep-link callback (meetily://) is no longer used for Databricks.
 * This hook is kept for potential future use (e.g. other OAuth providers).
 */
export function useOAuthCallbackInit() {
  // No-op: Databricks uses device code flow; no callback handler needed.
}

const CALENDAR_STORE_KEYS = {
  enabled: 'calendar_auto_start_enabled',
  refreshIntervalMinutes: 'calendar_refresh_interval_minutes',
} as const
const DEFAULT_REFRESH_MINUTES = 5
const MEETING_DETECTOR_POLL_MS = 30_000 // 30s

/**
 * Background service: when calendar auto-start is enabled, polls Google Calendar for upcoming
 * meetings (next 10 mins) and runs meeting-detector; triggers recording when a meeting app
 * is active and there is an upcoming meeting with a conferencing link.
 */
export function useCalendarAutoStart() {
  const triggeredForSessionRef = useRef(false)
  const calendarIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const detectorStopRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined' || !(window as unknown as { __TAURI__?: unknown }).__TAURI__) return

    let mounted = true

    const run = async () => {
      try {
        const { Store } = await import('@tauri-apps/plugin-store')
        const store = await Store.load('preferences.json')
        const enabled = await store.get<boolean>(CALENDAR_STORE_KEYS.enabled)
        const refreshMinutes = await store.get<number>(CALENDAR_STORE_KEYS.refreshIntervalMinutes) ?? DEFAULT_REFRESH_MINUTES

        if (!mounted || !enabled) return

        const clientId = process.env.NEXT_PUBLIC_GOOGLE_CALENDAR_CLIENT_ID ?? (await invoke<string>('secure_retrieve', { key: 'google_calendar_client_id' }).catch(() => ''))
        const redirectUri = process.env.NEXT_PUBLIC_GOOGLE_CALENDAR_REDIRECT_URI ?? (await invoke<string>('secure_retrieve', { key: 'google_calendar_redirect_uri' }).catch(() => 'meetily://oauth/google/callback'))
        const config = { clientId: clientId?.trim() ?? '', redirectUri: redirectUri?.trim() || 'meetily://oauth/google/callback' }
        if (!config.clientId) return

        const { checkUpcomingMeetings } = await import('@/lib/google-calendar')
        const { startMeetingDetector } = await import('@/lib/meeting-detector')

        let upcomingMeetings: Awaited<ReturnType<typeof checkUpcomingMeetings>> = []

        const pollCalendar = async () => {
          if (!mounted) return
          try {
            upcomingMeetings = await checkUpcomingMeetings(config)
            if (upcomingMeetings.length === 0) triggeredForSessionRef.current = false
          } catch (e) {
            console.debug('[Calendar auto-start] Poll failed:', e)
            upcomingMeetings = []
          }
        }

        await pollCalendar()
        const intervalMs = Math.max(60_000, refreshMinutes * 60 * 1000)
        calendarIntervalRef.current = setInterval(pollCalendar, intervalMs)

        detectorStopRef.current = startMeetingDetector(() => {
          if (!mounted || upcomingMeetings.length === 0 || triggeredForSessionRef.current) return
          triggeredForSessionRef.current = true
          window.dispatchEvent(new CustomEvent('start-recording-from-sidebar'))
        }, MEETING_DETECTOR_POLL_MS)
      } catch (e) {
        console.debug('[Calendar auto-start] Init failed:', e)
      }
    }

    run()

    return () => {
      mounted = false
      triggeredForSessionRef.current = false
      if (calendarIntervalRef.current) {
        clearInterval(calendarIntervalRef.current)
        calendarIntervalRef.current = null
      }
      detectorStopRef.current?.()
      detectorStopRef.current = null
    }
  }, [])
}
