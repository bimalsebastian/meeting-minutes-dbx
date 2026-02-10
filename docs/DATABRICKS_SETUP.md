# Databricks & Meetily Setup Guide

This guide walks you through setting up **Databricks** (for AI-powered meeting summaries) and **Google Calendar** (for upcoming-meeting detection) with Meetily. It’s written for beginners; follow the steps in order.

---

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [Databricks OAuth app creation (account-level)](#2-databricks-oauth-app-creation-account-level)
3. [Configuration reference](#3-configuration-reference)
4. [First-time setup in Meetily](#4-first-time-setup-in-meetily)
5. [Google Calendar API setup](#5-google-calendar-api-setup)
6. [Troubleshooting](#6-troubleshooting)
7. [Building from source](#7-building-from-source)

---

## 1. Prerequisites

Before you start, make sure you have:

| Requirement | What you need |
|------------|----------------|
| **Databricks workspace** | A Databricks account and at least one workspace (e.g. `https://your-workspace.cloud.databricks.com`). |
| **Account admin (for OAuth)** | To create an OAuth app you need **account-level** access (Account Console), not just workspace access. |
| **Model Serving endpoint** | A chat-style Model Serving endpoint in Databricks that Meetily will call for summaries. |
| **Google account (optional)** | Only if you want Calendar integration (upcoming meetings, auto-start). |

### Get your workspace URL

1. Log in to [Databricks](https://databricks.com/).
2. Open your workspace (e.g. from the workspace picker in the top left).
3. The browser URL is your **workspace URL**, e.g. `https://dbc-a1b2c3d4-e5f6.cloud.databricks.com`.  
   Use everything up to (and not including) the next `/` after `.com`.

> **[Screenshot placeholder: Databricks workspace URL in browser address bar]**

---

## 2. Databricks OAuth app creation (account-level)

Meetily uses **OAuth 2.0 with PKCE** to sign you into Databricks without storing a password. You must register an OAuth app at the **account** level.

### Step 1: Open the Account Console

1. Go to [https://accounts.cloud.databricks.com](https://accounts.cloud.databricks.com) (or your account-specific URL, e.g. `https://accounts.azuredatabricks.com` for Azure).
2. Sign in with an account that has **admin** or **account admin** rights.
3. In the left sidebar, find **Settings** → **OAuth** (or **OAuth applications** / **App registration** depending on UI).

> **[Screenshot placeholder: Account Console → Settings → OAuth]**

### Step 2: Create a new OAuth app

1. Click **Add OAuth application** (or **Create application** / **Register app**).
2. Fill in:

   | Field | Value | Notes |
   |-------|--------|--------|
   | **Application name** | `Meetily` (or any name you like) | Shown to users at sign-in. |
   | **Redirect URI(s)** | `meetily://oauth/callback` | Must match exactly; no trailing slash. |
   | **Confidential client** | **No** (unchecked) | Meetily uses PKCE, not a client secret. |

3. Save / Create the application.

> **[Screenshot placeholder: New OAuth app form with Redirect URI and Confidential client]**

### Step 3: Copy the Client ID

1. After creation, the app details page shows a **Client ID** (sometimes labeled “Application ID”).
2. Copy and store it somewhere safe; you’ll enter it in Meetily in [Section 4](#4-first-time-setup-in-meetily).

> **[Screenshot placeholder: OAuth app detail page showing Client ID]**

### Step 4: Scopes (if your account has a scope picker)

- If the UI asks for **scopes**, select at least **`all-apis`** (or the scope that allows access to your workspace and Model Serving).
- Meetily uses the default scope **`all-apis`** when not configured otherwise.

---

## 3. Configuration reference

Quick reference for what you need in Meetily and in Databricks.

### Databricks

| Setting | Where it comes from | Example |
|--------|----------------------|--------|
| **Workspace URL** | Your Databricks workspace in the browser | `https://your-workspace.cloud.databricks.com` |
| **Client ID** | OAuth app in Account Console (Step 2–3 above) | `a1b2c3d4e5f6...` |
| **Redirect URI** | Must match the OAuth app exactly | `meetily://oauth/callback` |
| **Scope** | Default in Meetily; optional to change | `all-apis` |
| **Serving endpoint name** | Your Model Serving endpoint in the workspace | e.g. `my-chat-endpoint` |

### Environment variables (optional, for pre-filling or CI)

You can pre-fill Databricks settings with env vars so the app can initialize the OAuth client at startup:

```bash
# Optional: in .env or your shell (frontend/.env is gitignored)
NEXT_PUBLIC_DATABRICKS_BASE_URL=https://your-workspace.cloud.databricks.com
NEXT_PUBLIC_DATABRICKS_CLIENT_ID=your-oauth-client-id
NEXT_PUBLIC_DATABRICKS_REDIRECT_URI=meetily://oauth/callback
```

If these are set, the OAuth callback handler can use them; otherwise you enter **Workspace URL** and **Client ID** (and optionally Redirect URI) in Meetily’s UI and they are stored securely.

---

## 4. First-time setup in Meetily

### Step 1: Open Model / AI settings

1. Open Meetily.
2. Go to **Settings** (gear icon) → **Model** (or **AI / Summary model**).
3. Under **Provider**, choose **Databricks**.

> **[Screenshot placeholder: Settings → Model with Databricks selected]**

### Step 2: Enter Databricks details

1. **Workspace URL**  
   Paste your workspace URL (e.g. `https://your-workspace.cloud.databricks.com`).  
   No trailing slash.

2. **Client ID**  
   Paste the OAuth app **Client ID** from the Account Console.

3. **Redirect URI**  
   Leave as `meetily://oauth/callback` unless you registered a different URI in Databricks (it must match exactly).

4. **Serving endpoint name**  
   Enter the **name** of your Model Serving chat endpoint (the one you use for summaries), e.g. `my-chat-endpoint`.  
   This is the endpoint segment used in the API path, not the full URL.

5. Click **Save** (or **Save configuration**).

### Step 3: Sign in (OAuth)

1. Click **Sign in to Databricks** (or **Connect**).
2. Your browser opens the Databricks login page. Sign in and approve access if prompted.
3. You are redirected back to Meetily via `meetily://oauth/callback`; the app completes the flow and stores tokens securely (e.g. macOS Keychain).
4. When you see a success message (e.g. “Connected to Databricks”), you’re done.

> **[Screenshot placeholder: Databricks sign-in success in Meetily]**

### Step 4: Generate a summary

1. Open a meeting (or create one with a transcript).
2. Use **Generate summary** (or the summary button).
3. Meetily uses your Databricks endpoint to produce the summary.

If you get an error about authentication, go back to **Settings → Model** and sign in again or check [Troubleshooting](#6-troubleshooting).

---

## 5. Google Calendar API setup

Google Calendar is used for **upcoming meetings** (e.g. in the next 10 minutes) and optional **auto-start** behavior. This is independent of Databricks; you can use one, both, or neither.

### Step 1: Google Cloud project and Calendar API

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project or select an existing one.
3. Enable the **Google Calendar API**:  
   **APIs & Services** → **Library** → search “Google Calendar API” → **Enable**.

> **[Screenshot placeholder: Enable Google Calendar API]**

### Step 2: OAuth consent screen

1. **APIs & Services** → **OAuth consent screen**.
2. Choose **External** (or **Internal** if it’s a Workspace app).
3. Fill in app name (e.g. `Meetily`), user support email, developer contact.
4. In **Scopes**, add:  
   `https://www.googleapis.com/auth/calendar.readonly`  
   (read-only access to calendar).
5. Save and continue; add test users if the app is in “Testing”.

> **[Screenshot placeholder: OAuth consent screen with calendar.readonly scope]**

### Step 3: Create OAuth client ID (Desktop / installed app)

1. **APIs & Services** → **Credentials** → **Create credentials** → **OAuth client ID**.
2. Application type: **Desktop app** (or **Installed application**).
3. Name: e.g. `Meetily Desktop`.
4. Create; copy the **Client ID** (and Client secret if shown; Meetily can work with client ID only for PKCE-style flows where implemented).

> **[Screenshot placeholder: OAuth client ID created – Client ID visible]**

### Step 4: Authorized redirect URI (if required)

- Some setups require an **Authorized redirect URI**.  
- Use exactly: **`meetily://oauth/google/callback`**  
  (Meetily uses this for the Google OAuth callback.)

Add it under the same OAuth client in **Credentials** → your client → **Authorized redirect URIs** → Add URI → Save.

### Step 5: Configure Meetily

1. **Settings** → **Preferences** (or the section where Calendar is configured).
2. Enable **Calendar auto-start** if you want the app to check for upcoming meetings.
3. Enter **Google Calendar Client ID** (from Step 3).  
   Optionally set **Redirect URI** to `meetily://oauth/google/callback` if the UI has a field.
4. Set **Refresh interval** (e.g. 5 minutes) for how often to check for upcoming meetings.
5. Save. When you connect, a browser window will open for Google sign-in; after approval, Meetily will store tokens securely.

### CLI / env (optional)

You can provide Google credentials via environment variables so the app can start the calendar flow without typing the client ID in the UI every time:

```bash
# Optional: in .env or shell
NEXT_PUBLIC_GOOGLE_CALENDAR_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
NEXT_PUBLIC_GOOGLE_CALENDAR_REDIRECT_URI=meetily://oauth/google/callback
```

---

## 6. Troubleshooting

### “Sign-in failed” or “Load failed” when clicking **Sign in to Databricks**

- **Cause:** Often the first request to your Databricks workspace is blocked (e.g. by the app’s security policy) or the workspace URL has a multi-level subdomain (e.g. Azure `adb-xxx.11.azuredatabricks.net`) that wasn’t allowed.
- **Fix:** Ensure **Workspace URL** is correct and saved (e.g. `https://adb-984752964297111.11.azuredatabricks.net` for Azure — no trailing space). Rebuild the app so the latest CSP and logging are included, then try again.
- **Log file (after a failed sign-in):** The app writes Databricks OAuth logs so you can investigate after the fact:
  - **macOS:** `~/Library/Application Support/com.meetily.ai/logs/databricks-oauth.log`
  - **Windows:** `%APPDATA%\com.meetily.ai\logs\databricks-oauth.log`
  - **Linux:** `~/.local/share/com.meetily.ai/logs/databricks-oauth.log`  
  Open this file after reproducing the error; it will contain timestamps, the request URL, and any error (e.g. “fetch failed”, “Load failed”, or a Databricks error).

### “State mismatch” or “Possible CSRF” when signing in to Databricks

- **Cause:** The `state` parameter in the OAuth callback doesn’t match what Meetily stored (e.g. you opened the link twice or in another tab).
- **Fix:** Start the flow again from Meetily: **Settings → Model** → **Sign in to Databricks**. Use only the browser tab Meetily opened; don’t reuse an old link.

### “Not authenticated” or “Call authorize() and exchangeCode() first”

- **Cause:** No valid tokens in secure storage (first time, or tokens were cleared/expired and refresh failed).
- **Fix:** In **Settings → Model**, click **Sign in to Databricks** again and complete the browser flow.

### “Databricks authentication expired or invalid” (401)

- **Cause:** Access or refresh token is invalid or revoked.
- **Fix:** Sign out (if the UI offers it) or clear stored tokens, then **Sign in to Databricks** again from Settings.

### Redirect URI doesn’t match

- **Error text** often mentions “redirect_uri” or “invalid redirect”.
- **Fix:**  
  - In Databricks: OAuth app **Redirect URI** must be exactly `meetily://oauth/callback` (no `https://`, no trailing slash).  
  - In Meetily: **Redirect URI** field should be the same.  
  - For Google: use exactly `meetily://oauth/google/callback` in the Google Cloud OAuth client and in Meetily.

### Meetily doesn’t open after Databricks sign-in

- **Cause:** The OS didn’t open Meetily when it received `meetily://oauth/callback`.
- **Fix:**  
  - Ensure Meetily is installed and the `meetily` URL scheme is registered (see [BUILD_DMG.md](BUILD_DMG.md)).  
  - On macOS: try opening Meetily first, then in Settings click **Sign in to Databricks** again.  
  - If you built from source, install the app (e.g. run from the built app bundle) so the scheme is registered.

### Summary fails with “endpoint” or “serving endpoint” error

- **Cause:** Wrong or missing **Serving endpoint name** in Model settings.
- **Fix:** In **Settings → Model**, set **Serving endpoint name** to the exact **name** of your Model Serving chat endpoint (e.g. `my-chat-endpoint`), not the full URL. You can find the name in Databricks under **Serving** in the workspace.

### Google Calendar: “Access blocked” or consent screen issues

- **Cause:** App not in “Production” or test users not added.
- **Fix:** In Google Cloud Console → **OAuth consent screen**, add your Google account as a **Test user**, or publish the app (e.g. for production). Ensure the scope `https://www.googleapis.com/auth/calendar.readonly` is added.

---

## 7. Building from source

To build Meetily from source (e.g. to test OAuth or use a custom build):

### Quick commands (from repo root)

```bash
# Clone (if needed)
git clone https://github.com/bimalsebastian/meeting-minutes-dbx.git
cd meeting-minutes-dbx

# Frontend + Tauri (development)
cd frontend
npm install
npm run tauri:dev
```

For a **production build** (e.g. macOS app bundle and DMG):

```bash
cd frontend
npm run prebuild:validate   # Optional: checks identifier, URL scheme, DMG target
npm run build:dmg           # Full build including DMG (see BUILD_DMG.md)
# Or without code signing (e.g. local use):
npm run build:dmg:unsigned
```

### Requirements

- **Node.js** (LTS recommended) and **npm** (or pnpm)
- **Rust** and **Tauri CLI** for the desktop app
- **macOS:** Xcode Command Line Tools (and full Xcode if you sign the app)

Detailed build instructions, GPU options, and platform-specific steps are in **[BUILDING.md](BUILDING.md)**. DMG build and signing are documented in **[BUILD_DMG.md](BUILD_DMG.md)**.

### After building

- Install or run the built app so that the **`meetily`** URL scheme is registered (required for OAuth callbacks).
- Then follow [Section 4](#4-first-time-setup-in-meetily) to configure Databricks and sign in.

---

## Summary checklist

- [ ] Databricks workspace URL and account admin access
- [ ] OAuth app created in Databricks Account Console with redirect `meetily://oauth/callback`
- [ ] Client ID copied and entered in Meetily
- [ ] Model Serving chat endpoint created; endpoint name entered in Meetily
- [ ] Signed in via **Sign in to Databricks** in Meetily at least once
- [ ] (Optional) Google Cloud project, Calendar API enabled, OAuth client with `meetily://oauth/google/callback`
- [ ] (Optional) Google Calendar client ID and preferences set in Meetily

For more on the app’s architecture and DMG build, see [BUILD_DMG.md](BUILD_DMG.md) and [BUILDING.md](BUILDING.md).
