#!/bin/bash
# Creates a self-contained Meetily-Installer folder in Google Drive.
# Run: bash ~/meeting-minutes-dbx/scripts/package_installer.sh

REPO="$HOME/meeting-minutes-dbx"
FRONTEND="$REPO/frontend"
VERSION="0.2.1"
GDRIVE="$HOME/Library/CloudStorage/GoogleDrive-bimal.sebastian@databricks.com/My Drive/Databricks notes/Databricks/meetily-app"
OUT="$GDRIVE/Meetily-Installer"
ZIP="$GDRIVE/Meetily-Installer.zip"

echo ""
echo "Packaging Meetily v$VERSION installer..."
echo ""

# ── Find DMG ──────────────────────────────────────────────
DMG=""
for search_dir in \
  "$REPO/target/release/bundle/dmg" \
  "$FRONTEND/src-tauri/target/release/bundle/dmg"; do
  if [ -d "$search_dir" ]; then
    candidate=$(find "$search_dir" -name "*.dmg" 2>/dev/null | head -1)
    if [ -n "$candidate" ]; then
      DMG="$candidate"
      break
    fi
  fi
done

if [ -z "$DMG" ]; then
  echo "✗ No .dmg found. Run build_and_install.sh first."
  exit 1
fi
echo "✓ DMG:     $(basename "$DMG")"

# ── Verify Google Drive path ──────────────────────────────
if [ ! -d "$GDRIVE" ]; then
  echo "✗ Google Drive folder not found:"
  echo "  $GDRIVE"
  echo "  Is Google Drive syncing?"
  exit 1
fi

# ── Create output folder ──────────────────────────────────
rm -rf "$OUT"
mkdir -p "$OUT"

# ── Copy DMG ──────────────────────────────────────────────
cp "$DMG" "$OUT/"
echo "✓ DMG copied"

# ── Bundle backend (no venv, no DB) ──────────────────────
tar -czf "$OUT/meetily-backend.tar.gz" \
  -C "$REPO" \
  --exclude="backend/venv" \
  --exclude="backend/*.db" \
  --exclude="backend/*.sqlite" \
  --exclude="backend/__pycache__" \
  --exclude="backend/app/__pycache__" \
  --exclude="backend/.env" \
  backend
echo "✓ Backend bundled"

# ── Copy install script ───────────────────────────────────
cp "$REPO/scripts/install.sh" "$OUT/install.sh"
chmod +x "$OUT/install.sh"
echo "✓ install.sh included"

# ── Write README ──────────────────────────────────────────
cat > "$OUT/README.txt" << 'EOF'
Meetily — Installation
══════════════════════

1. Open Terminal  (Cmd+Space → "Terminal" → Enter)
2. Type:  bash  then drag install.sh into the Terminal window, press Enter
3. Follow the prompts — a browser window will open for Databricks login

That's it.
EOF
echo "✓ README written"

# ── Zip ───────────────────────────────────────────────────
rm -f "$ZIP"
cd "$GDRIVE"
zip -r "Meetily-Installer.zip" "Meetily-Installer" -q
echo "✓ Zipped"

echo ""
echo "════════════════════════════════════════════"
echo "  Done!  Ready to share:"
echo "  $ZIP"
echo "════════════════════════════════════════════"
echo ""

open "$GDRIVE"
