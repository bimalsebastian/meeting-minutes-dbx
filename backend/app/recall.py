import asyncio
import json
import logging
import os
from datetime import datetime, timedelta
from typing import Optional

logger = logging.getLogger(__name__)

USE_MOCK_CALENDAR = True  # Set to False once TM2's gcal.py is merged


async def _get_upcoming_events_mock() -> list:
    """Mock calendar events for testing without real calendar."""
    now = datetime.utcnow()
    return [
        {
            "event_id": "mock-event-001",
            "title": "Q3 Planning Session",
            "start": (now + timedelta(minutes=12)).isoformat() + "Z",
            "end": (now + timedelta(minutes=72)).isoformat() + "Z",
            "attendees": ["alice.johnson@example.com", "bob.smith@corp.com"]
        },
        {
            "event_id": "mock-event-002",
            "title": "Architecture Review",
            "start": (now + timedelta(minutes=50)).isoformat() + "Z",
            "end": (now + timedelta(minutes=110)).isoformat() + "Z",
            "attendees": ["carol.white@example.com"]
        }
    ]


async def _get_upcoming_events_real(db) -> list:
    """Use TM2's calendar module once merged."""
    try:
        # TODO: replace with direct import once TM2's gcal.py is merged
        from gcal import get_upcoming_events
        return await get_upcoming_events(db)
    except ImportError:
        logger.debug("gcal.py not available yet — recall feature requires TM2 calendar integration")
        return []
    except Exception as e:
        logger.error(f"Error fetching calendar events: {e}")
        return []


async def get_upcoming_events(db) -> list:
    if USE_MOCK_CALENDAR:
        return await _get_upcoming_events_mock()
    return await _get_upcoming_events_real(db)


def _extract_name_tokens(attendees: list) -> list:
    """
    Extract searchable name tokens from attendee emails.
    "alice.johnson@corp.com" -> ["alice", "johnson"]
    Filter tokens < 4 chars and common noise words.
    """
    noise = {"info", "admin", "mail", "noreply", "hello", "contact", "support"}
    tokens = set()
    for email in attendees:
        if not email or '@' not in email:
            continue
        local = email.split('@')[0]
        parts = local.replace('.', ' ').replace('-', ' ').replace('_', ' ').split()
        for part in parts:
            part = part.lower()
            if len(part) >= 4 and part not in noise:
                tokens.add(part)
    return list(tokens)


async def generate_brief_text(db, attendee_display: list, summaries: list) -> str:
    """Generate a pre-meeting brief using LLM or raw fallback."""
    if not summaries:
        return "No previous meeting notes found for these attendees."

    attendee_str = ", ".join(attendee_display) if attendee_display else "these attendees"

    # Build raw bullet fallback (also used when LLM is not configured)
    raw_bullets = []
    for s in summaries[:9]:  # cap at 9 to stay under 8-bullet limit with header
        date_str = s.get('created_at', '')[:10]
        title = s.get('title', 'Unknown Meeting')
        excerpt = s.get('summary_text', '')[:200].replace('\n', ' ')
        raw_bullets.append(f"• {title} ({date_str}): {excerpt}")

    raw_text = "\n".join(raw_bullets)

    # Try LLM
    try:
        settings = await db.get_model_config()
        if not settings or not settings.get('provider'):
            return raw_text

        provider = settings['provider']
        api_key = await db.get_api_key(provider) if provider != 'localWhisper' else None

        if provider not in ['ollama', 'openai', 'claude', 'groq'] or (provider != 'ollama' and not api_key):
            return raw_text

        # Build LLM prompt
        summaries_text = "\n\n".join(
            f"Meeting: {s.get('title')} ({s.get('created_at', '')[:10]})\n{s.get('summary_text', '')}"
            for s in summaries
        )
        prompt = (
            f"You are preparing a pre-meeting brief. The following are past meeting notes involving {attendee_str}. "
            f"Summarise in a short bulleted list: when you last met, the top 2-3 topics discussed, and any open "
            f"actions mentioned. Be concise — maximum 8 bullets total.\n\n"
            f"Past meeting notes:\n{summaries_text}"
        )

        # Call LLM using the same pattern as transcript_processor.py
        llm_response = await _call_llm(provider, settings.get('model', ''), api_key, prompt)
        if llm_response:
            return llm_response
    except Exception as e:
        logger.error(f"LLM brief generation failed: {e}")

    return raw_text


async def _call_llm(provider: str, model: str, api_key: Optional[str], prompt: str) -> Optional[str]:
    """
    Call the configured LLM. Replicates the provider dispatch pattern from transcript_processor.py.
    Returns the response text string or None.
    """
    try:
        if provider == "claude":
            if not api_key:
                return None
            import httpx
            headers = {
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            }
            payload = {
                "model": model or "claude-3-5-haiku-20241022",
                "max_tokens": 1024,
                "messages": [{"role": "user", "content": prompt}],
            }
            async with httpx.AsyncClient(timeout=60.0) as client:
                resp = await client.post(
                    "https://api.anthropic.com/v1/messages",
                    headers=headers,
                    json=payload
                )
                resp.raise_for_status()
                data = resp.json()
                return data["content"][0]["text"]

        elif provider == "openai":
            if not api_key:
                return None
            import httpx
            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            }
            payload = {
                "model": model or "gpt-4o-mini",
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 1024,
            }
            async with httpx.AsyncClient(timeout=60.0) as client:
                resp = await client.post(
                    "https://api.openai.com/v1/chat/completions",
                    headers=headers,
                    json=payload
                )
                resp.raise_for_status()
                data = resp.json()
                return data["choices"][0]["message"]["content"]

        elif provider == "groq":
            if not api_key:
                return None
            import httpx
            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            }
            payload = {
                "model": model or "llama3-8b-8192",
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 1024,
            }
            async with httpx.AsyncClient(timeout=60.0) as client:
                resp = await client.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    headers=headers,
                    json=payload
                )
                resp.raise_for_status()
                data = resp.json()
                return data["choices"][0]["message"]["content"]

        elif provider == "ollama":
            ollama_host = os.getenv('OLLAMA_HOST', 'http://localhost:11434')
            import httpx
            payload = {
                "model": model or "llama3",
                "messages": [{"role": "user", "content": prompt}],
                "stream": False,
            }
            async with httpx.AsyncClient(timeout=120.0) as client:
                resp = await client.post(
                    f"{ollama_host}/api/chat",
                    json=payload
                )
                resp.raise_for_status()
                data = resp.json()
                return data["message"]["content"]

    except Exception as e:
        logger.error(f"_call_llm error for provider={provider}: {e}")
        return None

    return None


async def recall_polling_loop(db):
    """Main polling loop. Runs every 60 seconds."""
    while True:
        try:
            await asyncio.sleep(60)

            recall_enabled = await db.get_recall_enabled()
            if not recall_enabled:
                continue

            events = await get_upcoming_events(db)
            if not events:
                continue

            now = datetime.utcnow()

            for event in events:
                start_str = event.get('start', '').rstrip('Z')
                try:
                    event_start = datetime.fromisoformat(start_str)
                except ValueError:
                    continue

                seconds_until = (event_start - now).total_seconds()

                # Only process events starting within the next 15 minutes
                if seconds_until < 0 or seconds_until > 15 * 60:
                    continue

                event_id = event.get('event_id', '')

                # Idempotency check
                if await db.is_brief_triggered_today(event_id):
                    logger.debug(f"Recall: brief already triggered today for event {event_id}")
                    continue

                logger.info(
                    f"Recall: generating brief for event '{event.get('title')}' "
                    f"starting in {int(seconds_until / 60)}min"
                )

                # Extract attendee tokens for search
                attendees = event.get('attendees', [])
                tokens = _extract_name_tokens(attendees)

                # Search past meetings
                matched_meetings = await db.search_meetings_by_attendees(tokens)

                # Get summaries
                meeting_ids = [m['meeting_id'] for m in matched_meetings[:5]]
                summaries = await db.get_recent_meeting_summaries(meeting_ids, limit_per_meeting=3)

                # Generate brief
                brief_text = await generate_brief_text(db, attendees, summaries)

                # Save brief
                await db.save_recall_brief(
                    event_id=event_id,
                    event_title=event.get('title', 'Untitled Event'),
                    attendees_json=json.dumps(attendees),
                    brief_text=brief_text
                )

                logger.info(f"Recall: saved brief for event {event_id} ({event.get('title')})")

        except Exception as e:
            logger.error(f"Recall polling loop error: {e}", exc_info=True)
