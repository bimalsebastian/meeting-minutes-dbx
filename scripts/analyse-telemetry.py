"""
Meetily Telemetry Analysis
Run locally or in a Databricks notebook.

Usage (local):
  python3 scripts/analyse-telemetry.py --path "/path/to/meetily-telemetry"

Usage (Databricks notebook):
  Set TELEMETRY_PATH to the mounted Google Drive path and run all cells.
"""

import json
import argparse
from pathlib import Path
from collections import defaultdict, Counter
from datetime import datetime, timedelta, timezone


def load_events(telemetry_path: str) -> list[dict]:
    events = []
    events_dir = Path(telemetry_path) / "events"
    for f in events_dir.glob("*.jsonl"):
        for line in f.read_text(encoding="utf-8").split("\n"):
            if line.strip():
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    return sorted(events, key=lambda e: e["timestamp"])


def analyse(events: list[dict], days: int = 7):
    cutoff = (
        datetime.now(timezone.utc) - timedelta(days=days)
    ).isoformat()
    recent = [e for e in events if e["timestamp"] > cutoff]

    print(f"\n{'='*50}")
    print(f"MEETILY TELEMETRY — Last {days} days")
    print(f"{'='*50}")
    print(f"Total events (all time): {len(events)}")
    print(f"Total events (last {days}d): {len(recent)}")

    # Active installs
    active = {e["install_id"] for e in recent}
    total = {e["install_id"] for e in events}
    print(f"\nACTIVE INSTALLS")
    print(f"  Active last {days}d: {len(active)}")
    print(f"  Total ever: {len(total)}")

    # Feature usage
    print(f"\nFEATURE USAGE (last {days}d)")
    event_counts = Counter(e["event"] for e in recent)
    for event, count in event_counts.most_common():
        print(f"  {event}: {count}")

    # Genie Live health
    genie = [
        e for e in recent
        if e["event"] == "genie_live_cycle_completed"
    ]
    if genie:
        print(f"\nGENIE LIVE HEALTH (last {days}d)")
        print(f"  Cycles completed: {len(genie)}")

        status_counts = Counter(
            e["properties"].get("genie_status")
            for e in genie
        )
        for status, count in status_counts.items():
            pct = round(count / len(genie) * 100)
            print(f"  {status}: {count} ({pct}%)")

        times = [
            e["properties"].get("response_time_seconds", 0)
            for e in genie
            if e["properties"].get("genie_status") == "complete"
        ]
        if times:
            times.sort()
            print(f"  Response time p50: {times[len(times)//2]}s")
            print(f"  Response time p95: {times[int(len(times)*0.95)]}s")

        quality = Counter(
            e["properties"].get("quality_score")
            for e in genie
            if e["properties"].get("quality_score")
        )
        print(f"  Quality scores: {dict(quality)}")

        fallback = sum(
            1 for e in genie
            if e["properties"].get("llm_fallback_used") == 1
        )
        print(
            f"  LLM fallback rate: "
            f"{round(fallback/len(genie)*100)}%"
        )

    # Recording durations
    recordings = [
        e for e in recent
        if e["event"] == "recording_stopped"
    ]
    if recordings:
        print(f"\nRECORDING DURATIONS (last {days}d)")
        durations = [
            e["properties"].get("duration_seconds", 0)
            for e in recordings
        ]
        durations.sort()
        real = [d for d in durations if d > 300]
        print(f"  Total recordings: {len(durations)}")
        print(f"  Likely real meetings (>5min): {len(real)}")
        if real:
            print(
                f"  Median duration: "
                f"{real[len(real)//2]//60}min"
            )

    # Per-install Genie health
    print(f"\nGENIE HEALTH BY INSTALL")
    print(f"  (installs with <50% completion need help)")
    by_install = defaultdict(
        lambda: {"fired": 0, "complete": 0}
    )
    for e in recent:
        if e["event"] == "genie_live_cycle_fired":
            by_install[e["install_id"]]["fired"] += 1
        elif e["event"] == "genie_live_cycle_completed":
            if e["properties"].get("genie_status") == "complete":
                by_install[e["install_id"]]["complete"] += 1

    for iid, stats in by_install.items():
        if stats["fired"] > 0:
            rate = round(
                stats["complete"] / stats["fired"] * 100
            )
            flag = " ← needs help" if rate < 50 else ""
            print(
                f"  {iid}: {rate}% "
                f"({stats['complete']}/{stats['fired']})"
                f"{flag}"
            )

    # Errors
    errors = [
        e for e in recent
        if e["event"] == "app_error"
    ]
    if errors:
        print(f"\nERRORS (last {days}d)")
        error_types = Counter(
            f"{e['properties'].get('component', 'unknown')}/"
            f"{e['properties'].get('error_type', 'unknown')}"
            for e in errors
        )
        for error, count in error_types.most_common(10):
            print(f"  {error}: {count}")


# ---------------------------------------------------------------------------
# Databricks notebook cell (copy-paste from here)
# ---------------------------------------------------------------------------
# TELEMETRY_PATH = "/dbfs/mnt/gdrive/meetily-telemetry"
# events = load_events(TELEMETRY_PATH)
# analyse(events, days=7)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Analyse Meetily anonymous telemetry."
    )
    parser.add_argument(
        "--path",
        required=True,
        help="Path to meetily-telemetry folder",
    )
    parser.add_argument(
        "--days",
        type=int,
        default=7,
        help="Look-back window in days (default: 7)",
    )
    args = parser.parse_args()
    events = load_events(args.path)
    analyse(events, days=args.days)
