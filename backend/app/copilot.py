import asyncio
import json
import logging
import os
from datetime import datetime, timedelta
from typing import Optional

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger

logger = logging.getLogger(__name__)

_active_meeting_id: Optional[str] = None
_recording_start_time: Optional[datetime] = None
_scheduler: Optional[AsyncIOScheduler] = None
_knowledge_base_content: str = ""
_db = None
_genie_available: Optional[bool] = None  # None=unchecked, True=ready, False=disabled


def load_knowledge_base(path: str) -> str:
    """Read knowledge base file, warn if not found, return content or empty string."""
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return f.read()
    except FileNotFoundError:
        logger.warning(f"Co-pilot knowledge base not found at: {path}")
        return ""
    except Exception as e:
        logger.warning(f"Could not read knowledge base at {path}: {e}")
        return ""


async def _check_genie_available(workspace_host: str, cli_profile: str) -> None:
    """Probe the Genie MCP endpoint at startup. Sets _genie_available accordingly."""
    global _genie_available
    try:
        from databricks.mcp import DatabricksMCPClient
        from databricks.sdk import WorkspaceClient

        client = DatabricksMCPClient(
            server_url=f"{workspace_host}/api/2.0/mcp/genie",
            workspace_client=WorkspaceClient(profile=cli_profile),
        )
        tools = await asyncio.wait_for(client.alist_tools(), timeout=10.0)
        tool_names = [t.name for t in tools] if tools else []
        if "genie_ask" in tool_names:
            _genie_available = True
            logger.info(f"[copilot.py:{_check_genie_available.__code__.co_firstlineno} - _check_genie_available()] - Genie available. Tools: {tool_names}")
        else:
            _genie_available = False
            logger.warning(f"[copilot.py - _check_genie_available()] - genie_ask not found in MCP tools {tool_names}. Genie disabled.")
    except ImportError:
        _genie_available = False
        logger.warning("[copilot.py - _check_genie_available()] - databricks-mcp not installed. Genie disabled.")
    except asyncio.TimeoutError:
        _genie_available = False
        logger.warning("[copilot.py - _check_genie_available()] - Genie startup probe timed out. Genie disabled.")
    except Exception as e:
        _genie_available = False
        logger.warning(f"[copilot.py - _check_genie_available()] - Genie startup probe failed: {e}. Genie disabled.")


async def call_genie(question: str, workspace_host: str, cli_profile: str) -> Optional[str]:
    """Call Genie via databricks-mcp 0.9.0 DatabricksMCPClient.acall_tool() API."""
    global _genie_available
    if _genie_available is False:
        return None

    try:
        from databricks.mcp import DatabricksMCPClient
        from databricks.sdk import WorkspaceClient

        # Lazy startup check if not yet run
        if _genie_available is None:
            await _check_genie_available(workspace_host, cli_profile)
            if not _genie_available:
                return None

        client = DatabricksMCPClient(
            server_url=f"{workspace_host}/api/2.0/mcp/genie",
            workspace_client=WorkspaceClient(profile=cli_profile),
        )

        # Start conversation
        result = await asyncio.wait_for(
            client.acall_tool("genie_ask", {"question": question}),
            timeout=15.0,
        )
        if not result or not result.content:
            logger.warning("[copilot.py - call_genie()] - genie_ask returned empty result")
            return None

        response_text = result.content[0].text

        # Parse conversation_id — response may be JSON with an id field or plain text answer
        conversation_id = None
        try:
            response_json = json.loads(response_text)
            conversation_id = (
                response_json.get("conversation_id")
                or response_json.get("conversationId")
                or response_json.get("id")
            )
            if not conversation_id:
                # Synchronous answer returned directly in JSON
                answer = response_json.get("answer") or response_json.get("response") or response_json.get("text")
                return str(answer) if answer else response_text
        except (json.JSONDecodeError, AttributeError):
            # Plain-text synchronous answer
            if response_text and len(response_text) > 10:
                return response_text

        if not conversation_id:
            return response_text or None

        # Poll for completion — 15 attempts × 1s = 15s max
        for _ in range(15):
            await asyncio.sleep(1)
            try:
                poll = await asyncio.wait_for(
                    client.acall_tool("genie_poll_response", {"conversation_id": conversation_id}),
                    timeout=5.0,
                )
            except asyncio.TimeoutError:
                continue

            if not poll or not poll.content:
                continue

            poll_text = poll.content[0].text
            try:
                poll_json = json.loads(poll_text)
                status = poll_json.get("status", "").lower()
                if status in ("completed", "done", "finished", "success"):
                    answer = poll_json.get("answer") or poll_json.get("response") or poll_json.get("text")
                    return str(answer) if answer else poll_text
                if status in ("failed", "error"):
                    logger.warning(f"[copilot.py - call_genie()] - Genie poll error status: {poll_json}")
                    return None
                # Still pending — continue loop
            except (json.JSONDecodeError, AttributeError):
                if poll_text and len(poll_text) > 10:
                    return poll_text

        logger.warning("[copilot.py - call_genie()] - Genie polling exceeded 15s, returning None")
        return None

    except ImportError:
        _genie_available = False
        logger.warning("[copilot.py - call_genie()] - databricks-mcp not installed. Genie disabled.")
        return None
    except asyncio.TimeoutError:
        logger.warning("[copilot.py - call_genie()] - genie_ask initial call timed out after 15s")
        return None
    except Exception as e:
        logger.error(f"[copilot.py - call_genie()] - Genie call failed: {e}", exc_info=True)
        return None


async def _call_llm(provider: str, model: str, settings: dict, system_prompt: str, user_message: str) -> Optional[str]:
    """Call the configured LLM provider and return the text response."""
    try:
        if provider == "ollama":
            from ollama import AsyncClient
            ollama_host = os.getenv('OLLAMA_HOST', 'http://127.0.0.1:11434')
            client = AsyncClient(host=ollama_host)
            messages = [
                {'role': 'system', 'content': system_prompt},
                {'role': 'user', 'content': user_message},
            ]
            response = await client.chat(model=model, messages=messages)
            return response['message']['content']

        elif provider == "claude":
            import anthropic
            api_key = settings.get('anthropicApiKey') or os.getenv('ANTHROPIC_API_KEY', '')
            if not api_key:
                logger.warning("Co-pilot: no Anthropic API key configured")
                return None
            client = anthropic.AsyncAnthropic(api_key=api_key)
            message = await client.messages.create(
                model=model,
                max_tokens=1024,
                system=system_prompt,
                messages=[{"role": "user", "content": user_message}]
            )
            return message.content[0].text if message.content else None

        elif provider == "groq":
            from groq import AsyncGroq
            api_key = settings.get('groqApiKey') or os.getenv('GROQ_API_KEY', '')
            if not api_key:
                logger.warning("Co-pilot: no Groq API key configured")
                return None
            client = AsyncGroq(api_key=api_key)
            completion = await client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_message}
                ],
                max_tokens=1024,
            )
            return completion.choices[0].message.content

        elif provider == "openai":
            from openai import AsyncOpenAI
            api_key = settings.get('openaiApiKey') or os.getenv('OPENAI_API_KEY', '')
            if not api_key:
                logger.warning("Co-pilot: no OpenAI API key configured")
                return None
            client = AsyncOpenAI(api_key=api_key)
            completion = await client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_message}
                ],
                max_tokens=1024,
            )
            return completion.choices[0].message.content

        else:
            logger.warning(f"Co-pilot: unsupported provider '{provider}'")
            return None

    except Exception as e:
        logger.error(f"Co-pilot LLM call failed (provider={provider}): {e}", exc_info=True)
        return None


def _extract_field(text: str, prefix: str) -> Optional[str]:
    for line in text.split('\n'):
        if line.startswith(prefix):
            return line[len(prefix):].strip()
    return None


def _extract_bullets(text: str) -> list:
    bullets = []
    in_points = False
    for line in text.split('\n'):
        if line.startswith('POINTS:'):
            in_points = True
            continue
        if line.startswith('GENIE:'):
            break
        if in_points and line.startswith('- '):
            bullets.append(line[2:].strip())
    return bullets


async def run_copilot_cycle():
    """Run one analysis cycle: fetch recent transcripts, call LLM, optionally call Genie, save hint."""
    global _active_meeting_id, _knowledge_base_content, _db

    if _active_meeting_id is None or _db is None:
        return

    try:
        settings = await _db.get_copilot_settings()

        if not settings.get('copilotEnabled'):
            return

        provider = settings.get('provider')
        model = settings.get('model')
        if not provider or not model:
            logger.info("Co-pilot: no LLM provider configured, skipping cycle")
            return

        # Get last 5 minutes of transcript
        since_iso = (datetime.utcnow() - timedelta(minutes=5)).isoformat()
        transcript_chunk = await _db.get_recent_transcripts(_active_meeting_id, since_iso)

        if not transcript_chunk or len(transcript_chunk.strip()) < 50:
            logger.debug("Co-pilot: transcript chunk too short, skipping")
            return

        # Build prompt
        user_message = f"[KNOWLEDGE BASE]\n{_knowledge_base_content}\n\n[TRANSCRIPT EXCERPT]\n{transcript_chunk}"
        system_prompt = (
            "You are a Databricks Solutions Architect co-pilot. "
            "Analyse this meeting transcript excerpt. Identify any questions, objections, or topics "
            "where Databricks product knowledge would help the SA. "
            "If nothing actionable is present, respond with exactly: SKIP\n"
            "Otherwise respond with:\n"
            "TOPIC: <the specific question or topic detected>\n"
            "POINTS:\n- <bullet 1>\n- <bullet 2>\n- <bullet 3>\n- <bullet 4 (max)>\n"
            "GENIE: YES or NO"
        )

        # Call LLM
        llm_response = await _call_llm(provider, model, settings, system_prompt, user_message)

        if not llm_response or llm_response.strip() == "SKIP":
            logger.debug("Co-pilot: LLM returned SKIP")
            return

        # Parse response
        topic = _extract_field(llm_response, "TOPIC:")
        points_raw = _extract_bullets(llm_response)
        genie_decision = "YES" in llm_response.split("GENIE:")[-1].upper() if "GENIE:" in llm_response else False

        if not topic or not points_raw:
            logger.warning(f"Co-pilot: could not parse LLM response: {llm_response[:200]}")
            return

        # Optional Genie call
        genie_answer = None
        workspace_host = settings.get('databricksWorkspaceHost')
        if genie_decision and workspace_host:
            cli_profile = settings.get('databricksCliProfile', 'DEFAULT')
            genie_answer = await call_genie(topic, workspace_host, cli_profile)

        # Store hint
        await _db.save_copilot_hint(
            meeting_id=_active_meeting_id,
            topic_detected=topic,
            talking_points=points_raw,
            genie_used=genie_answer is not None,
            genie_answer=genie_answer
        )
        logger.info(f"Co-pilot: hint generated for meeting {_active_meeting_id}, genie_used={genie_answer is not None}")

    except Exception as e:
        logger.error(f"Co-pilot cycle error: {e}", exc_info=True)


def set_recording_active(meeting_id: str, interval_minutes: int = 5):
    """Mark a meeting as active; reschedule the job interval if needed."""
    global _active_meeting_id, _recording_start_time, _scheduler
    _active_meeting_id = meeting_id
    _recording_start_time = datetime.utcnow()
    if _scheduler and _scheduler.get_job('copilot_job'):
        _scheduler.reschedule_job('copilot_job', trigger=IntervalTrigger(minutes=interval_minutes))
    logger.info(f"Co-pilot: recording started for meeting {meeting_id}")


def set_recording_stopped():
    """Mark recording as stopped."""
    global _active_meeting_id
    _active_meeting_id = None
    logger.info("Co-pilot: recording stopped")


async def start_copilot_scheduler(db, knowledge_base_path: str):
    """Initialize APScheduler, start the copilot job, and probe Genie if configured."""
    global _scheduler, _knowledge_base_content, _db
    _db = db
    _knowledge_base_content = load_knowledge_base(knowledge_base_path)
    if _knowledge_base_content:
        logger.info(f"[copilot.py - start_copilot_scheduler()] - Loaded knowledge base ({len(_knowledge_base_content)} chars)")
    else:
        logger.warning("[copilot.py - start_copilot_scheduler()] - Knowledge base not found or empty")

    _scheduler = AsyncIOScheduler()
    _scheduler.add_job(
        run_copilot_cycle,
        trigger=IntervalTrigger(minutes=5),
        id='copilot_job',
        max_instances=1,
        replace_existing=True,
    )
    _scheduler.start()
    logger.info("[copilot.py - start_copilot_scheduler()] - Co-pilot scheduler started")

    # Probe Genie availability now if workspace_host is already configured in the DB.
    # Runs as a background task so it doesn't block FastAPI startup.
    try:
        settings = await db.get_copilot_settings()
        workspace_host = settings.get("databricksWorkspaceHost")
        cli_profile = settings.get("databricksCliProfile", "DEFAULT")
        if workspace_host:
            asyncio.create_task(_check_genie_available(workspace_host, cli_profile))
        else:
            logger.info("[copilot.py - start_copilot_scheduler()] - No Databricks workspace configured; Genie check deferred")
    except Exception as e:
        logger.warning(f"[copilot.py - start_copilot_scheduler()] - Could not read settings for Genie check: {e}")
