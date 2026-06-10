from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from dateutil import parser as dateutil_parser
from datetime import datetime, timezone, timedelta
from pydantic import BaseModel
import json
import asyncio
import logging

router = APIRouter()
logger = logging.getLogger(__name__)
logging.basicConfig(
    format='%(asctime)s - %(levelname)s - [%(filename)s:%(lineno)d - %(funcName)s()] - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)

_oauth_states: dict = {}  # state -> flow (for CSRF validation)
_db = None  # set by init_calendar(db)

_polling_state = {
    "pending_split": False,
    "pending_event_title": None,
    "next_event_title": None,
    "next_event_id": None,
    "minutes_until_next": None,
    "grace_seconds_remaining": 180,
    "dismissed_event_id": None,
    "last_triggered_event_id": None,
    "grace_period_started_at": None,
    "auto_split_triggered": False,
    "connected": False,
}


def init_calendar(db):
    """Initialize the calendar module with the database manager."""
    global _db
    _db = db
    logger.info("[gcal.py:init_calendar()] - Calendar module initialized with database")


async def get_upcoming_events(db=None) -> list:
    """Fetch upcoming calendar events. Used by polling loop and by external callers."""
    global _db
    db_or_global = db if db is not None else _db

    if db_or_global is None:
        logger.warning("[gcal.py:get_upcoming_events()] - No database available")
        return []

    try:
        token_json = await db_or_global.get_calendar_token()
        if not token_json:
            return []

        creds = Credentials.from_authorized_user_info(json.loads(token_json))

        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
            await db_or_global.save_calendar_token(creds.to_json())
            logger.info("[gcal.py:get_upcoming_events()] - Refreshed calendar token")

        service = build('calendar', 'v3', credentials=creds)
        now_utc = datetime.utcnow().isoformat() + 'Z'
        events_result = service.events().list(
            calendarId='primary',
            maxResults=5,
            orderBy='startTime',
            singleEvents=True,
            timeMin=now_utc
        ).execute()

        items = events_result.get('items', [])
        result = []
        for item in items:
            start_raw = item.get('start', {}).get('dateTime') or item.get('start', {}).get('date', '')
            end_raw = item.get('end', {}).get('dateTime') or item.get('end', {}).get('date', '')

            def to_utc_iso(dt_str):
                if not dt_str:
                    return dt_str
                parsed = dateutil_parser.isoparse(dt_str)
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                return parsed.astimezone(timezone.utc).isoformat()

            result.append({
                'event_id': item['id'],
                'title': item.get('summary', 'Untitled'),
                'start': to_utc_iso(start_raw),
                'end': to_utc_iso(end_raw),
                'attendees': [a['email'] for a in item.get('attendees', [])]
            })

        return result

    except Exception as e:
        logger.error(f"[gcal.py:get_upcoming_events()] - Error fetching upcoming events: {e}", exc_info=True)
        return []


# ============================================================================
# Pydantic request models
# ============================================================================

class DismissBody(BaseModel):
    event_id: str


class SaveCredentialsBody(BaseModel):
    client_id: str
    client_secret: str


# ============================================================================
# Endpoints
# ============================================================================

@router.get("/api/calendar/auth")
async def calendar_auth():
    """Start OAuth flow: return the Google authorization URL."""
    creds_data = await _db.get_calendar_credentials()
    if not creds_data or not creds_data.get('client_id'):
        raise HTTPException(
            status_code=400,
            detail="Calendar credentials not configured. Set them in Settings → Calendar."
        )

    flow = Flow.from_client_config(
        {
            "web": {
                "client_id": creds_data['client_id'],
                "client_secret": creds_data['client_secret'],
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
                "redirect_uris": ["http://localhost:5167/api/calendar/callback"]
            }
        },
        scopes=["https://www.googleapis.com/auth/calendar.readonly"],
        redirect_uri="http://localhost:5167/api/calendar/callback"
    )
    auth_url, state = flow.authorization_url(access_type='offline', prompt='consent')
    _oauth_states[state] = flow
    logger.info(f"[gcal.py:calendar_auth()] - Started OAuth flow, state={state[:8]}...")
    return {"auth_url": auth_url}


@router.get("/api/calendar/callback")
async def calendar_callback(code: str, state: str):
    """Handle OAuth callback from Google."""
    if state not in _oauth_states:
        raise HTTPException(status_code=400, detail="Invalid OAuth state parameter")

    flow = _oauth_states.pop(state)
    flow.fetch_token(code=code)
    await _db.save_calendar_token(flow.credentials.to_json())
    _polling_state["connected"] = True
    logger.info("[gcal.py:calendar_callback()] - OAuth callback handled, token saved")
    try:
        from main import _telemetry
        import asyncio
        asyncio.create_task(_telemetry.capture("calendar_connected"))
    except Exception:
        pass

    return HTMLResponse(
        '<html><body><h2>Authentication successful!</h2>'
        '<p>You can close this tab.</p>'
        '<script>setTimeout(()=>window.close(),1500)</script>'
        '</body></html>'
    )


@router.get("/api/calendar/upcoming")
async def calendar_upcoming():
    """Return upcoming calendar events and connection status."""
    events = await get_upcoming_events()
    connected = await _db.has_calendar_token()
    return {"connected": connected, "events": events}


@router.get("/api/calendar/status")
async def calendar_status():
    """Return current polling/split state for the frontend banner."""
    global _polling_state

    # Recalculate grace_seconds_remaining if grace period is active
    if _polling_state["pending_split"] and _polling_state["grace_period_started_at"]:
        now = datetime.now(timezone.utc)
        elapsed = (now - _polling_state["grace_period_started_at"]).total_seconds()
        _polling_state["grace_seconds_remaining"] = max(0, int(180 - elapsed))

    _polling_state["connected"] = await _db.has_calendar_token()

    # Serialize datetime for JSON response
    serializable = dict(_polling_state)
    if serializable["grace_period_started_at"] is not None:
        serializable["grace_period_started_at"] = serializable["grace_period_started_at"].isoformat()

    return serializable


@router.post("/api/calendar/dismiss")
async def calendar_dismiss(body: DismissBody):
    """Dismiss the auto-split banner for a specific event."""
    _polling_state["dismissed_event_id"] = body.event_id
    _polling_state["pending_split"] = False
    logger.info(f"[gcal.py:calendar_dismiss()] - Dismissed split for event_id={body.event_id}")
    return {"ok": True}


@router.post("/api/calendar/acknowledge_split")
async def calendar_acknowledge_split():
    """Acknowledge that a split was performed; clear pending state."""
    _polling_state["pending_split"] = False
    _polling_state["pending_event_title"] = None
    _polling_state["next_event_title"] = None
    _polling_state["next_event_id"] = None
    _polling_state["grace_period_started_at"] = None
    _polling_state["auto_split_triggered"] = False
    logger.info("[gcal.py:calendar_acknowledge_split()] - Split acknowledged, state cleared")
    try:
        from main import _telemetry
        import asyncio
        asyncio.create_task(_telemetry.capture("meeting_split_triggered", {"trigger": "calendar"}))
    except Exception:
        pass
    return {"ok": True}


@router.post("/api/calendar/save-credentials")
async def calendar_save_credentials(body: SaveCredentialsBody):
    """Save Google OAuth 2.0 client credentials."""
    await _db.save_calendar_credentials(body.client_id, body.client_secret)
    logger.info("[gcal.py:calendar_save_credentials()] - Credentials saved")
    return {"ok": True}


@router.get("/api/calendar/credentials")
async def calendar_credentials():
    """Return whether credentials exist (no secrets exposed)."""
    creds = await _db.get_calendar_credentials()
    has_credentials = bool(creds and creds.get('client_id'))
    client_id_preview = None
    if has_credentials:
        client_id_preview = creds['client_id'][:8] + '...'
    return {"has_credentials": has_credentials, "client_id_preview": client_id_preview}


@router.post("/api/calendar/disconnect")
async def calendar_disconnect():
    """Disconnect from Google Calendar: delete token and reset state."""
    global _polling_state

    # Best-effort token revocation
    try:
        token_json = await _db.get_calendar_token()
        if token_json:
            token_data = json.loads(token_json)
            token = token_data.get('token')
            if token:
                import requests
                requests.post('https://oauth2.googleapis.com/revoke', params={'token': token})
    except Exception:
        pass

    await _db.delete_calendar_token()

    # Reset polling state
    _polling_state.update({
        "pending_split": False,
        "pending_event_title": None,
        "next_event_title": None,
        "next_event_id": None,
        "minutes_until_next": None,
        "grace_seconds_remaining": 180,
        "dismissed_event_id": None,
        "last_triggered_event_id": None,
        "grace_period_started_at": None,
        "auto_split_triggered": False,
        "connected": False,
    })

    logger.info("[gcal.py:calendar_disconnect()] - Disconnected from Google Calendar")
    return {"ok": True}


# ============================================================================
# Background polling loop
# ============================================================================

async def calendar_polling_loop(db):
    """Background task: polls Google Calendar every 60s and detects meeting end boundaries."""
    global _polling_state

    logger.info("[gcal.py:calendar_polling_loop()] - Calendar polling loop started")

    while True:
        try:
            await asyncio.sleep(60)

            if not await db.has_calendar_token():
                continue

            events = await get_upcoming_events(db)
            now = datetime.now(timezone.utc)

            # Check for events that just ended (in the last 65 seconds)
            for event in events:
                end_time = dateutil_parser.isoparse(event['end'])
                if end_time.tzinfo is None:
                    end_time = end_time.replace(tzinfo=timezone.utc)
                seconds_since_end = (now - end_time).total_seconds()

                if 0 <= seconds_since_end <= 65:
                    event_id = event['event_id']
                    if event_id == _polling_state.get('last_triggered_event_id'):
                        continue
                    if event_id == _polling_state.get('dismissed_event_id'):
                        continue

                    # Find next event starting after now
                    next_events = [
                        e for e in events
                        if dateutil_parser.isoparse(e['start']).astimezone(timezone.utc) > now
                    ]
                    next_event = next_events[0] if next_events else None

                    minutes_until_next = None
                    if next_event:
                        minutes_until_next = int(
                            (dateutil_parser.isoparse(next_event['start']).astimezone(timezone.utc) - now).total_seconds() / 60
                        )

                    _polling_state.update({
                        "pending_split": True,
                        "pending_event_title": event['title'],
                        "next_event_title": next_event['title'] if next_event else None,
                        "next_event_id": next_event['event_id'] if next_event else None,
                        "minutes_until_next": minutes_until_next,
                        "grace_period_started_at": now,
                        "last_triggered_event_id": event_id,
                        "auto_split_triggered": False,
                    })

                    logger.info(
                        f"[gcal.py:calendar_polling_loop()] - Split triggered for event: {event['title']}"
                    )
                    break

            # Update grace period countdown
            if _polling_state["pending_split"] and _polling_state["grace_period_started_at"]:
                elapsed = (now - _polling_state["grace_period_started_at"]).total_seconds()
                _polling_state["grace_seconds_remaining"] = max(0, int(180 - elapsed))
                if elapsed >= 180:
                    _polling_state["auto_split_triggered"] = True
                    _polling_state["pending_split"] = False
                    logger.info("[gcal.py:calendar_polling_loop()] - Grace period expired, auto-split triggered")

        except Exception as e:
            logger.error(f"[gcal.py:calendar_polling_loop()] - Error in polling loop: {e}", exc_info=True)
