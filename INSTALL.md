# Meetily — Installation Guide

Meetily is a **macOS desktop app** for AI-assisted meeting transcription and live suggestions.
The app has two parts: a native macOS app (Tauri) and a Python backend that it auto-starts.

---

## What you need

| Requirement | Used for |
|---|---|
| macOS 13+ (Apple Silicon or Intel) | Running the app |
| Python 3.11+ | Backend server (transcription, summaries, Genie) |
| Databricks CLI | Genie Live suggestions only (optional) |
| BlackHole 2ch | Capturing system audio (optional) |

---

## Step 1 — Install the app

1. Open `meetily_0.2.1_aarch64.dmg` (Apple Silicon) or `meetily_0.2.1_x86_64.dmg` (Intel)
2. Drag **meetily.app** → **Applications**
3. Remove the quarantine flag so macOS allows it to open:
   ```bash
   xattr -cr /Applications/meetily.app
   ```

---

## Step 2 — Set up the Python backend

The app looks for the backend at `~/meeting-minutes-dbx/backend/`. You need to put it there.

### 2a — Get the backend files

Ask the person who shared the app for the `backend/` folder, or clone just what you need:

```bash
# Option A: copy the backend folder from the DMG sender
# (they can zip ~/meeting-minutes-dbx/backend and send it to you)

# Option B: clone from source
git clone https://github.com/yourusername/meeting-minutes-dbx ~/meeting-minutes-dbx
```

The required structure is:
```
~/meeting-minutes-dbx/
└── backend/
    ├── app/
    │   ├── main.py
    │   ├── db.py
    │   └── ... (other .py files)
    └── requirements.txt
```

### 2b — Create the Python virtual environment

```bash
cd ~/meeting-minutes-dbx/backend

# Create venv (Python 3.11 recommended)
python3 -m venv venv

# Activate it
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

Installation takes 2–5 minutes.

### 2c — Verify the backend works

```bash
cd ~/meeting-minutes-dbx/backend
source venv/bin/activate
python app/main.py
```

You should see:
```
INFO:     Started server process
INFO:     Waiting for application startup.
INFO:     Application startup complete.
INFO:     Uvicorn running on http://0.0.0.0:5167
```

Press `Ctrl+C` to stop — the app will start it automatically on launch.

---

## Step 3 — Grant macOS permissions

On first launch, macOS will ask for permissions. **Allow both:**

1. **Microphone** — required for recording your voice
2. **Screen Recording** — required to capture system audio (what others say on calls)

If you accidentally denied them:
- **System Settings → Privacy & Security → Microphone → meetily ✓**
- **System Settings → Privacy & Security → Screen Recording → meetily ✓**

---

## Step 4 — System audio (optional — to hear other participants)

Without this, Meetily only records your microphone.

1. Download and install **BlackHole 2ch** (free):
   https://existential.audio/blackhole/

2. Open **Audio MIDI Setup** (in /Applications/Utilities/):
   - Click **+** → **Create Multi-Output Device**
   - Check both **BlackHole 2ch** and your speakers/headphones
   - Set this Multi-Output Device as your default output in System Settings

3. In Meetily Settings → Recordings, select **BlackHole 2ch** as the system audio device

---

## Step 5 — Download a transcription model

On first use, Meetily needs a speech-to-text model:

1. Open Meetily
2. Go to **Settings → Transcription**
3. Select **Parakeet** (recommended for Apple Silicon — fast, on-device)
   or **Whisper small** (works on Intel Macs too)
4. Click **Download** and wait for it to complete (~500MB)

---

## Step 6 — Genie Live (optional — AI suggestions during meetings)

Genie Live surfaces talking points in real-time during meetings, grounded in your Databricks workspace.

### 6a — Install Databricks CLI

```bash
brew tap databricks/tap
brew install databricks
```

### 6b — Authenticate

```bash
databricks configure --profile meetily
```

Enter:
- **Databricks Host**: `https://your-workspace.azuredatabricks.net`
- **Token**: your personal access token (Settings → Developer → Access Tokens in Databricks)

### 6c — Configure in Meetily

1. Open Meetily → **Settings → Genie Live**
2. Set **Workspace URL** to your Databricks host
3. Set **CLI Profile** to `meetily` (or whatever you named it)
4. Click **Test Connection** — should show green ✓
5. Toggle **Genie Live enabled** → On
6. Click **Save Settings**

### 6d — Knowledge store (optional — personalised suggestions)

For suggestions grounded in your own notes and account materials:

1. Create a folder in Google Drive (or any local folder): `genie-live-knowledge/`
2. Inside it, create subfolders: `products/`, `customers/`, `competitive/`
3. Add `.md` files with your Databricks knowledge
4. In Meetily → **Settings → Genie Live** → **Knowledge Store Path**, enter the folder path

---

## Troubleshooting

### App doesn't open
```bash
xattr -cr /Applications/meetily.app && open /Applications/meetily.app
```

### Backend didn't start / features not working
Check the backend log:
```bash
tail -50 ~/Library/Logs/meetily-backend.log
```

### No transcripts appearing
- Check microphone permission is granted
- Try a different transcription model in Settings → Transcription
- On Intel Mac, Whisper models are slower — wait 30–60s for the first transcript

### Genie Live not showing suggestions
- Verify the Databricks CLI profile works: `databricks auth status --profile meetily`
- Check the workspace URL ends with `.net` (no trailing slash)
- Suggestions appear ~45 seconds into a recording — be patient on the first cycle

---

## Sharing the backend

The easiest way to share the backend with a colleague:

```bash
# On your machine — zip just the backend folder
cd ~
zip -r meetily-backend.zip meeting-minutes-dbx/backend \
  --exclude "meeting-minutes-dbx/backend/venv/*" \
  --exclude "meeting-minutes-dbx/backend/*.db" \
  --exclude "meeting-minutes-dbx/backend/*.sqlite"
```

Send them `meetily-backend.zip` and the `.dmg`. They unzip to `~/meeting-minutes-dbx/` and run the pip install step above.
