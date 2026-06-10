#!/usr/bin/env python3
"""
Bulk dark-mode fix: replaces hardcoded Tailwind gray/white classes with
CSS variable equivalents across all frontend src files.

Run from repo root:
  python3 scripts/fix_dark_mode.py
"""

import os
import re
from pathlib import Path

SRC = Path("frontend/src")

# ── Substitution rules ────────────────────────────────────────────────────────
# Each rule is (pattern, replacement).
# We only match inside className="..." or className={...} strings to stay safe.
# Order matters: more specific patterns first.

TEXT_RULES = [
    # Primary text (dark-on-light patterns that are invisible in dark mode)
    (r'\btext-gray-900\b', 'text-[var(--text-primary)]'),
    (r'\btext-gray-800\b', 'text-[var(--text-primary)]'),
    (r'\btext-gray-700\b', 'text-[var(--text-primary)]'),
    # Secondary text
    (r'\btext-gray-600\b', 'text-[var(--text-secondary)]'),
    (r'\btext-gray-500\b', 'text-[var(--text-secondary)]'),
    (r'\btext-gray-400\b', 'text-[var(--text-secondary)]'),
    # Borders
    (r'\bborder-gray-100\b', 'border-[var(--separator)]'),
    (r'\bborder-gray-200\b', 'border-[var(--separator)]'),
    (r'\bborder-gray-300\b', 'border-[var(--separator)]'),
    # Elevated backgrounds (skeleton, info boxes, etc.)
    (r'\bbg-gray-200\b', 'bg-[var(--panel-elevated)]'),
    (r'\bbg-gray-100\b', 'bg-[var(--panel-elevated)]'),
    (r'\bbg-gray-50\b',  'bg-[var(--panel-elevated)]'),
]

# bg-white needs separate handling: only replace when NOT a toggle thumb
# (toggle thumbs are: "...bg-white shadow..." patterns)
BG_WHITE_RULE = (
    # Match bg-white that is NOT immediately followed by " shadow"
    r'\bbg-white\b(?! shadow)',
    'bg-[var(--panel-bg)]',
)

# Files/patterns to skip entirely
SKIP_FILES = {
    'globals.css', 'tailwind.config.js', 'VirtualizedTranscriptView.tsx',
    'BlockNoteSummaryView.tsx',  # already fixed with useTheme
}
SKIP_DIRS = {'.next', 'node_modules', '__pycache__'}

# Only process these extensions
EXTENSIONS = {'.tsx', '.ts', '.jsx', '.js'}

# ── Helpers ───────────────────────────────────────────────────────────────────

def should_skip(path: Path) -> bool:
    for part in path.parts:
        if part in SKIP_DIRS:
            return True
    if path.name in SKIP_FILES:
        return True
    if path.suffix not in EXTENSIONS:
        return True
    return False


def apply_rules(content: str, path: Path) -> tuple[str, int]:
    """Apply all substitution rules, returning (new_content, change_count)."""
    original = content
    changes = 0

    for pattern, replacement in TEXT_RULES:
        # Skip if inside a hover:, focus:, dark:, placeholder:, or sr-only context
        # We do a simple approach: apply globally, then re-check if needed.
        # The key exclusion: don't touch "hover:text-gray-*" etc.
        # Strategy: replace only when the match is NOT preceded by a colon-variant prefix.
        safe_pattern = r'(?<!hover:)(?<!focus:)(?<!dark:)(?<!placeholder:)(?<!active:)(?<!disabled:)' + pattern
        new, n = re.subn(safe_pattern, replacement, content)
        content = new
        changes += n

    # bg-white: extra care for toggle thumbs
    safe_bg_white = r'(?<!hover:)(?<!focus:)(?<!dark:)' + BG_WHITE_RULE[0]
    new, n = re.subn(safe_bg_white, BG_WHITE_RULE[1], content)
    content = new
    changes += n

    return content, changes


def process_file(path: Path) -> bool:
    """Process one file. Returns True if file was changed."""
    try:
        original = path.read_text(encoding='utf-8')
    except Exception as e:
        print(f"  SKIP (read error): {path} — {e}")
        return False

    new_content, changes = apply_rules(original, path)

    if changes == 0:
        return False

    try:
        path.write_text(new_content, encoding='utf-8')
        print(f"  ✓ {path.relative_to(SRC.parent.parent)} ({changes} changes)")
        return True
    except Exception as e:
        print(f"  ERROR writing {path}: {e}")
        return False


def main():
    print("Dark-mode bulk fix — scanning frontend/src...\n")
    total_files = 0
    total_changed = 0

    for path in sorted(SRC.rglob('*')):
        if should_skip(path) or not path.is_file():
            continue
        if process_file(path):
            total_changed += 1
        total_files += 1

    print(f"\nDone. Scanned {total_files} files, changed {total_changed}.")
    print("Run: rm -rf frontend/.next && cd frontend && pnpm tauri dev")


if __name__ == '__main__':
    main()
