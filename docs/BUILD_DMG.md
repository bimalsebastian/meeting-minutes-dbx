# DMG Build and Distribution (macOS)

This document describes how to build the Meetily macOS DMG for distribution and the required permissions and signing setup.

## Build configuration summary

- **Bundle identifier:** `com.meetily.ai` (set in `frontend/src-tauri/tauri.conf.json` → `identifier`).
- **URL scheme:** `meetily` is registered via the deep-link plugin (`plugins.deep-link.desktop.schemes`) for OAuth and deep links (e.g. `meetily://oauth/callback`).
- **DMG settings:** Configured under `bundle.macOS.dmg` in `tauri.conf.json` (window size, icon positions).
- **App category:** `public.app-category.productivity`.

## Required permissions (macOS)

Meetily needs the following macOS capabilities. They are declared in **`frontend/src-tauri/entitlements.plist`** and usage descriptions in **`frontend/src-tauri/Info.plist`**:

| Permission           | Entitlement / usage description              | Purpose                                      |
|----------------------|---------------------------------------------|----------------------------------------------|
| **Microphone**       | `com.apple.security.device.microphone`      | Recording meeting audio                       |
| **Audio input**      | `com.apple.security.device.audio-input`     | Audio capture for transcription              |
| **Audio output**     | `com.apple.security.device.audio-output`    | Playback / system audio capture               |
| **Screen recording**| `com.apple.security.device.screen-capture` | System audio capture during meetings         |

- **Calendar:** Google Calendar integration uses OAuth and the Google Calendar API. No system calendar entitlement is required; access is user-authorized via the browser OAuth flow.

Ensure `tauri.conf.json` → `bundle.macOS.entitlements` points to `entitlements.plist` (e.g. `"entitlements": "entitlements.plist"`).

## Pre-build validation

Before building, run:

```bash
cd frontend
pnpm run prebuild:validate
```

This checks:

- `tauri.conf.json` exists and has identifier `com.meetily.ai`
- URL scheme `meetily` is registered
- DMG is in bundle targets
- `entitlements.plist` exists and includes microphone and screen-capture

## Build scripts (package.json)

From the **frontend** directory:

| Script                | Command                          | Description                                      |
|-----------------------|-----------------------------------|--------------------------------------------------|
| **prebuild:validate** | `pnpm run prebuild:validate`      | Run pre-build checks only                        |
| **build:dmg**         | `pnpm run build:dmg`              | Validate, then full Tauri build (includes DMG)   |
| **build:dmg:unsigned**| `pnpm run build:dmg:unsigned`     | Validate, then Tauri build (no code signing)     |
| **tauri:build**       | `pnpm run tauri:build`            | Standard Tauri build (no prebuild step)         |

For a DMG on macOS, use:

```bash
cd frontend
pnpm run build:dmg
```

Output is under `frontend/src-tauri/target/release/bundle/` (e.g. `dmg` and `app`).

## Signing requirements

- **Development / local testing:** You can skip code signing. In `tauri.conf.json`, `bundle.macOS.signingIdentity` is set to `"-"`, which produces an unsigned (or ad-hoc) build. Gatekeeper may show “unverified developer”; users can open via Right‑click → Open.
- **Distribution outside the Mac App Store:** For notarization and smoother distribution:
  1. Use an **Apple Developer** account and a **Developer ID Application** certificate.
  2. Set `signingIdentity` in `tauri.conf.json` to the exact name of that certificate (e.g. `"Developer ID Application: Your Name (TEAM_ID)"`).
  3. After building, sign and notarize the app (and optionally the DMG) with `codesign` and `xcrun notarytool` (or legacy `altool`).
  4. Staple the notarization ticket to the app/DMG.

Notarization is required for macOS 10.15+ when distributing outside the App Store so users can open the app without extra steps.

## DMG customization

To change the installer window or icon positions, edit `bundle.macOS.dmg` in `frontend/src-tauri/tauri.conf.json`:

- **windowSize:** Default 660×400; adjust `width`/`height` as needed.
- **appPosition:** Position of the app icon in the DMG window.
- **applicationFolderPosition:** Position of the “Applications” folder icon.

Optional: add a custom **background** image for the DMG window (see [Tauri DMG docs](https://v2.tauri.app/distribute/dmg)).

## Summary

- **Identifier:** `com.meetily.ai`
- **URL scheme:** `meetily`
- **Permissions:** Microphone, audio input/output, screen recording in `entitlements.plist`; calendar via Google OAuth (no system calendar entitlement).
- **Build:** `pnpm run prebuild:validate` then `pnpm run build:dmg` (or `tauri:build`) in `frontend`.
- **Signing:** Optional for development (`signingIdentity: "-"`); use a Developer ID and notarization for public distribution.
