from __future__ import annotations
import json
import asyncio
import logging
from collections import deque
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)


def _is_url(path: str) -> bool:
    return path.startswith("http://") or path.startswith("https://")


class TelemetryWriter:
    """
    Writes anonymous usage events to either:
      - A shared folder (file system or Google Drive mount): set telemetry_path
        to a local/mounted path, e.g. /Users/you/Google Drive/meetily-telemetry
      - An HTTP endpoint: set telemetry_path to a URL, e.g. https://your-server/telemetry
        Events are POSTed as JSON. Any endpoint that accepts POST JSON works.

    What IS collected:
      - Which features are used
      - App version
      - Error types (no details)
      - A random install ID (not linked to any person)

    What is NEVER collected:
      - Meeting content or transcripts
      - Names, emails, or personal identifiers
      - Attendee names or company names
      - File contents or paths
      - Workspace hostnames
    """

    def __init__(
        self,
        telemetry_path: str,
        install_id: str,
        app_version: str,
    ):
        self.raw_path = telemetry_path or ""
        self.install_id = install_id
        self.app_version = app_version
        self.enabled = False
        self._write_lock = asyncio.Lock()
        self._mode: str = "none"  # "file" | "http" | "none"

        # File-mode attributes
        self.base_path: Optional[Path] = None
        self.events_path: Optional[Path] = None
        self.event_file: Optional[Path] = None

        # HTTP-mode attributes
        self._http_url: Optional[str] = None

        # In-memory buffer of recent events — populated for both file and HTTP modes
        self._recent_buffer: deque = deque(maxlen=20)

        if _is_url(self.raw_path):
            self._mode = "http"
            self._http_url = self.raw_path.rstrip("/")
        elif self.raw_path:
            self._mode = "file"
            self.base_path = Path(self.raw_path)
            self.events_path = self.base_path / "events"
            self.event_file = self.events_path / f"{install_id}.jsonl"

    def initialise(self) -> bool:
        """
        Prepare for writing.
        - File mode: creates directory structure + README.
        - HTTP mode: validates the URL looks reachable (sync HEAD-like check skipped;
          first POST will reveal connectivity).
        Returns True if ready to write.
        """
        if self._mode == "http":
            logger.info(f"Telemetry: HTTP mode → {self._http_url}")
            return True

        if self._mode == "file":
            try:
                self.events_path.mkdir(parents=True, exist_ok=True)
                readme = self.base_path / "README.md"
                if not readme.exists():
                    readme.write_text(
                        "# Meetily Telemetry\n\n"
                        "Anonymous usage statistics for the Meetily meeting assistant.\n\n"
                        "## What is collected\n"
                        "- Which features are used\n"
                        "- App version\n"
                        "- Error types (no details)\n"
                        "- A random install ID per machine (not linked to any person)\n\n"
                        "## What is never collected\n"
                        "- Meeting content or transcripts\n"
                        "- Names, emails, or any personal data\n"
                        "- File contents or paths\n\n"
                        "## File format\n"
                        "Each .jsonl file in events/ is one install. "
                        "Each line is one event.\n\n"
                        f"Last app version seen: {self.app_version}\n"
                    )
                logger.info(f"Telemetry: file mode → {self.events_path}")
                return True
            except Exception as e:
                logger.warning(f"Telemetry: init failed — {e}")
                self.enabled = False
                return False

        return False

    async def capture(
        self,
        event: str,
        properties: Optional[dict] = None,
    ) -> None:
        """
        Record a single anonymous event. Fire-and-forget, never raises.
        Skipped entirely if enabled=False.
        """
        if not self.enabled:
            return

        record = {
            "event": event,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "install_id": self.install_id,
            "app_version": self.app_version,
            "properties": sanitise_properties(properties or {}),
        }

        asyncio.create_task(
            self._dispatch(json.dumps(record), record),
            name=f"telemetry_{event}",
        )

    async def _dispatch(self, line: str, record: dict) -> None:
        """Route to the right backend (file or HTTP)."""
        self._recent_buffer.append(record)
        if self._mode == "file":
            await self._write_to_file(line)
        elif self._mode == "http":
            await self._post_to_http(record)

    # ── File mode ────────────────────────────────────────────────────────────

    async def _write_to_file(self, line: str) -> None:
        try:
            async with self._write_lock:
                await asyncio.wait_for(
                    asyncio.to_thread(self._append_line, line),
                    timeout=3.0,
                )
        except asyncio.TimeoutError:
            logger.debug("Telemetry: file write timed out")
        except Exception as e:
            logger.debug(f"Telemetry: file write failed — {e}")

    def _append_line(self, line: str) -> None:
        with open(self.event_file, "a", encoding="utf-8") as f:
            f.write(line + "\n")

    # ── HTTP mode ────────────────────────────────────────────────────────────

    async def _post_to_http(self, record: dict) -> None:
        """POST event as JSON to the configured URL. Uses stdlib urllib — no extra deps."""
        try:
            await asyncio.wait_for(
                asyncio.to_thread(self._sync_post, record),
                timeout=5.0,
            )
        except asyncio.TimeoutError:
            logger.debug("Telemetry: HTTP POST timed out")
        except Exception as e:
            logger.debug(f"Telemetry: HTTP POST failed — {e}")

    def _sync_post(self, record: dict) -> None:
        import urllib.request
        data = json.dumps(record).encode("utf-8")
        req = urllib.request.Request(
            self._http_url,
            data=data,
            headers={"Content-Type": "application/json", "User-Agent": "Meetily-Telemetry/1.0"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=4) as resp:
            logger.debug(f"Telemetry: HTTP POST {resp.status} to {self._http_url}")

    # ── Shared ───────────────────────────────────────────────────────────────

    def get_recent_events(self, n: int = 10) -> list[dict]:
        """
        Return last N events. HTTP mode returns from in-memory buffer; file mode
        reads from disk (more complete across restarts).
        Used by the Settings debug panel.
        """
        if self._mode == "file" and self.event_file:
            try:
                lines = self.event_file.read_text(encoding="utf-8").strip().split("\n")
                return [json.loads(l) for l in lines[-n:] if l.strip()]
            except Exception:
                pass
        # HTTP mode (or file read failed): return from in-memory buffer
        return list(self._recent_buffer)[-n:]


def sanitise_properties(props: dict) -> dict:
    """
    Remove any property values that look like personal data.
    Numeric values, booleans, and whitelisted strings are safe.
    Any string value over 50 chars is removed.
    """
    safe = {}
    ALLOWED_STRING_KEYS = {
        "genie_status",
        "error_type",
        "component",
        "trigger",
        "reason",
        "app_version",
        "split_trigger",
        "scope",
    }
    for k, v in props.items():
        if isinstance(v, (int, float, bool)):
            safe[k] = v
        elif isinstance(v, str):
            if k in ALLOWED_STRING_KEYS and len(v) <= 50:
                safe[k] = v
        elif isinstance(v, list):
            if k == "features_enabled":
                safe[k] = [i for i in v if isinstance(i, str) and len(i) <= 30]
    return safe


def get_app_version() -> str:
    """Read version from Tauri config."""
    try:
        tauri_config = Path("frontend/src-tauri/tauri.conf.json")
        if tauri_config.exists():
            import json as _json
            config = _json.loads(tauri_config.read_text())
            return config.get("version", "unknown")
    except Exception:
        pass
    return "unknown"
