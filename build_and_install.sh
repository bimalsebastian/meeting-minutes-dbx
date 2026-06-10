#!/bin/bash
# Meetily — build release and install to /Applications in one shot.
# Run from anywhere: bash ~/meeting-minutes-dbx/build_and_install.sh

set -euo pipefail

REPO="$HOME/meeting-minutes-dbx"
FRONTEND="$REPO/frontend"
APP_NAME="meetily"
VERSION="0.2.1"
ARCH="$(uname -m)"   # arm64 on Apple Silicon, x86_64 on Intel
DMG="$FRONTEND/src-tauri/target/release/bundle/dmg/${APP_NAME}_${VERSION}_${ARCH}.dmg"
APP_BUNDLE="$FRONTEND/src-tauri/target/release/bundle/macos/meetily.app"

echo "═══════════════════════════════════════════"
echo "  Meetily v$VERSION — build + install"
echo "  arch: $ARCH"
echo "═══════════════════════════════════════════"
echo ""

# ── Kill any stale backend processes so the new app owns port 5167 ──────────
echo "▶ Clearing stale backend processes on port 5167..."
lsof -ti :5167 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 1

# ── 1. Clear Next.js cache (avoids stale compiled chunks) ───────────────────
echo "▶ Clearing Next.js cache..."
rm -rf "$FRONTEND/.next"

# ── 2. Tauri production build ────────────────────────────────────────────────
echo "▶ Building (this takes ~15-30 min on first run)..."
cd "$FRONTEND"
pnpm run tauri build 2>&1

# ── 3. Locate output ─────────────────────────────────────────────────────────
if [ ! -f "$DMG" ]; then
  # Tauri sometimes uses different arch suffix; find it
  DMG=$(find "$FRONTEND/src-tauri/target/release/bundle/dmg" -name "*.dmg" 2>/dev/null | head -1)
fi

if [ -z "$DMG" ] || [ ! -f "$DMG" ]; then
  echo ""
  echo "✗ Build failed — no .dmg found."
  echo "  Check the output above for errors."
  exit 1
fi

echo ""
echo "✓ Build complete: $DMG"
echo ""

# ── 4. Kill any running instance ─────────────────────────────────────────────
if pgrep -x "meetily" > /dev/null 2>&1; then
  echo "▶ Stopping running instance..."
  pkill -x "meetily" 2>/dev/null || true
  sleep 1
fi

# ── 5. Mount DMG, copy to /Applications, unmount ─────────────────────────────
echo "▶ Installing to /Applications..."
MOUNT_POINT=$(mktemp -d)
hdiutil attach "$DMG" -mountpoint "$MOUNT_POINT" -quiet -nobrowse

# Remove old install if present
if [ -d "/Applications/meetily.app" ]; then
  rm -rf "/Applications/meetily.app"
fi

cp -R "$MOUNT_POINT/meetily.app" "/Applications/meetily.app"
hdiutil detach "$MOUNT_POINT" -quiet
rmdir "$MOUNT_POINT"

# ── 6. Strip quarantine flag (avoid Gatekeeper "unidentified developer" block) ──
echo "▶ Removing quarantine flag..."
xattr -cr "/Applications/meetily.app"

# ── 7. Done ──────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════"
echo "  ✓ Meetily v$VERSION installed"
echo "  Launch: open /Applications/meetily.app"
echo "═══════════════════════════════════════════"
echo ""
read -p "Open Meetily now? [y/N] " answer
if [[ "$answer" =~ ^[Yy]$ ]]; then
  open "/Applications/meetily.app"
fi
