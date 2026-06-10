#!/bin/bash
# ╔══════════════════════════════════════════════════════════╗
# ║              Meetily — Installer                         ║
# ║  Run this script to install Meetily and all dependencies ║
# ╚══════════════════════════════════════════════════════════╝
set -euo pipefail

MEETILY_VERSION="0.2.1"
BACKEND_DIR="$HOME/meeting-minutes-dbx/backend"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Colours ────────────────────────────────────────────────
GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'
RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${BLUE}▶${NC}  $*"; }
success() { echo -e "${GREEN}✓${NC}  $*"; }
warn()    { echo -e "${YELLOW}⚠${NC}  $*"; }
error()   { echo -e "${RED}✗${NC}  $*"; exit 1; }
header()  { echo -e "\n${BOLD}$*${NC}\n"; }

# ── Detect DMG ─────────────────────────────────────────────
find_dmg() {
  # 1. Explicit argument
  if [[ -n "${1:-}" && -f "$1" ]]; then echo "$1"; return; fi
  # 2. Same folder as this script
  local f
  f=$(find "$SCRIPT_DIR" -maxdepth 1 -name "meetily*.dmg" 2>/dev/null | head -1)
  if [[ -n "$f" ]]; then echo "$f"; return; fi
  # 3. Downloads folder
  f=$(find "$HOME/Downloads" -maxdepth 1 -name "meetily*.dmg" 2>/dev/null | head -1)
  if [[ -n "$f" ]]; then echo "$f"; return; fi
  echo ""
}

# ══════════════════════════════════════════════════════════
header "Meetily v${MEETILY_VERSION} Installer"
echo   "  This will install:"
echo   "    • meetily.app → /Applications"
echo   "    • Python backend → ~/meeting-minutes-dbx/backend"
echo   "    • All Python dependencies"
echo   "    • Databricks CLI (for Genie Live)"
echo   "    • Databricks auth (browser login)"
echo ""
read -p "Continue? [Y/n] " CONFIRM
[[ "${CONFIRM:-Y}" =~ ^[Yy]$ || -z "${CONFIRM:-}" ]] || exit 0

# ══════════════════════════════════════════════════════════
header "1 / 6  — Installing Meetily.app"

DMG=$(find_dmg "${1:-}")
if [[ -z "$DMG" ]]; then
  echo ""
  warn "No meetily DMG found automatically."
  read -ep "  Path to meetily*.dmg: " DMG
  [[ -f "$DMG" ]] || error "File not found: $DMG"
fi

info "Mounting $DMG …"
MOUNT_POINT=$(mktemp -d)
hdiutil attach "$DMG" -mountpoint "$MOUNT_POINT" -quiet -nobrowse

# Remove old install if present
[[ -d "/Applications/meetily.app" ]] && rm -rf "/Applications/meetily.app"

cp -R "$MOUNT_POINT/meetily.app" "/Applications/meetily.app"
hdiutil detach "$MOUNT_POINT" -quiet
rmdir "$MOUNT_POINT"

# Strip quarantine flag (avoids "unidentified developer" block)
xattr -cr "/Applications/meetily.app"
success "meetily.app installed to /Applications"

# ══════════════════════════════════════════════════════════
header "2 / 6  — Setting up Python backend"

# Find backend source — either bundled with this script or a separate zip
BACKEND_ZIP=$(find "$SCRIPT_DIR" -maxdepth 1 -name "meetily-backend*.tar.gz" 2>/dev/null | head -1)

if [[ -n "$BACKEND_ZIP" ]]; then
  info "Extracting backend from $BACKEND_ZIP …"
  mkdir -p "$HOME/meeting-minutes-dbx"
  tar -xzf "$BACKEND_ZIP" -C "$HOME/meeting-minutes-dbx"
  success "Backend files extracted"
elif [[ -d "$SCRIPT_DIR/../backend/app" ]]; then
  # Running from the repo itself
  info "Using backend from repo …"
  mkdir -p "$HOME/meeting-minutes-dbx"
  if [[ "$SCRIPT_DIR/../backend" != "$BACKEND_DIR" ]]; then
    cp -R "$SCRIPT_DIR/../backend" "$HOME/meeting-minutes-dbx/"
  fi
  success "Backend files ready"
else
  error "Backend files not found. Re-run with meetily-backend.tar.gz in the same folder."
fi

# ── Python venv ────────────────────────────────────────────
info "Checking Python …"
PYTHON=""
for p in python3.12 python3.11 python3.10 python3; do
  if command -v "$p" &>/dev/null; then
    VER=$("$p" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
    MAJOR=${VER%%.*}; MINOR=${VER##*.}
    if [[ $MAJOR -ge 3 && $MINOR -ge 10 ]]; then
      PYTHON="$p"; break
    fi
  fi
done
[[ -n "$PYTHON" ]] || error "Python 3.10+ not found. Install from https://python.org"

if [[ ! -f "$BACKEND_DIR/venv/bin/python" ]]; then
  info "Creating virtual environment …"
  "$PYTHON" -m venv "$BACKEND_DIR/venv"
fi

info "Installing Python dependencies (this takes 2–5 minutes) …"
"$BACKEND_DIR/venv/bin/pip" install -q --upgrade pip
"$BACKEND_DIR/venv/bin/pip" install -q -r "$BACKEND_DIR/requirements.txt"
success "Python backend ready"

# ══════════════════════════════════════════════════════════
header "3 / 6  — Homebrew"

if ! command -v brew &>/dev/null; then
  info "Installing Homebrew …"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Add brew to PATH for the rest of this script
  eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv 2>/dev/null)"
else
  success "Homebrew already installed"
fi

# ══════════════════════════════════════════════════════════
header "4 / 6  — Databricks CLI"

if ! command -v databricks &>/dev/null; then
  info "Installing Databricks CLI …"
  brew tap databricks/tap 2>/dev/null || true
  brew install databricks
else
  success "Databricks CLI already installed ($(databricks --version 2>/dev/null | head -1))"
fi

# ── Browser-based OAuth login ──────────────────────────────
echo ""
echo -e "${BOLD}Databricks Authentication${NC}"
echo "  Genie Live needs access to your Databricks workspace."
echo "  A browser window will open for you to sign in."
echo ""
DEFAULT_DB_HOST="https://adb-2548836972759138.18.azuredatabricks.net"
read -p "Databricks workspace URL [${DEFAULT_DB_HOST}]: " DB_HOST_INPUT
DB_HOST="${DB_HOST_INPUT:-$DEFAULT_DB_HOST}"

# Strip trailing slash
DB_HOST="${DB_HOST%/}"

if [[ -n "$DB_HOST" ]]; then
  info "Opening browser for Databricks login …"
  databricks auth login --host "$DB_HOST" --profile meetily
  success "Databricks authentication complete (profile: meetily)"
else
  warn "Skipped — you can set this up later in Meetily → Settings → Genie Live"
fi

# ══════════════════════════════════════════════════════════
header "5 / 6  — System audio (BlackHole)"

echo "  BlackHole lets Meetily capture audio from calls (Zoom, Teams, etc.)."
echo "  Without it, only your microphone is recorded."
echo ""
read -p "Install BlackHole 2ch for system audio? [Y/n] " BH_CONFIRM
if [[ "${BH_CONFIRM:-Y}" =~ ^[Yy]$ || -z "${BH_CONFIRM:-}" ]]; then
  if system_profiler SPAudioDataType 2>/dev/null | grep -q "BlackHole 2ch"; then
    success "BlackHole 2ch already installed"
  else
    info "Installing BlackHole 2ch …"
    brew install --cask blackhole-2ch
    success "BlackHole 2ch installed"
    echo ""
    warn "IMPORTANT: Set up a Multi-Output Device in Audio MIDI Setup:"
    echo "  1. Open /Applications/Utilities/Audio MIDI Setup"
    echo "  2. Click + → Create Multi-Output Device"
    echo "  3. Tick both BlackHole 2ch AND your speakers"
    echo "  4. Set this as your default output in System Settings → Sound"
  fi
else
  info "Skipped — you can install BlackHole later with: brew install --cask blackhole-2ch"
fi

# ══════════════════════════════════════════════════════════
header "6 / 6  — macOS Permissions"

echo "  When Meetily first opens, macOS will ask for:"
echo "  • Microphone access — click Allow"
echo "  • Screen Recording access — click Allow (needed for system audio)"
echo ""
echo "  If you missed the prompts, go to:"
echo "  System Settings → Privacy & Security → Microphone → meetily ✓"
echo "  System Settings → Privacy & Security → Screen Recording → meetily ✓"

# ══════════════════════════════════════════════════════════
echo ""
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  ✓  Meetily is ready!${NC}"
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════${NC}"
echo ""
echo "  First run: open Meetily → Settings → Transcription"
echo "  and download the Parakeet model (~500 MB, one-time)."
echo ""
if [[ -n "${DB_HOST:-}" ]]; then
  echo "  Genie Live is configured. Enable it in:"
  echo "  Settings → Genie Live → toggle ON → Save"
  echo ""
fi

read -p "Open Meetily now? [Y/n] " OPEN_NOW
if [[ "${OPEN_NOW:-Y}" =~ ^[Yy]$ || -z "${OPEN_NOW:-}" ]]; then
  open /Applications/meetily.app
fi
