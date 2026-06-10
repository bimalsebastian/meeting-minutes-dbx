from __future__ import annotations
import asyncio
import json
import logging
import os
import sqlite3 as _sqlite3
import time
import uuid
import datetime
import re
from pathlib import Path
from typing import TypedDict, Optional, Any

logger = logging.getLogger(__name__)

_GDRIVE_KB = Path.home() / "Library/CloudStorage/GoogleDrive-bimal.sebastian@databricks.com/My Drive/Databricks notes/Databricks/genie-live-knowledge"
_REPO_KB   = Path(__file__).parent.parent.parent / "copilot-knowledge"

# KB_BASE starts with auto-detected default; overridden by init_genie_live() if
# the user has configured a knowledgeStorePath in settings.
KB_BASE: Path = _GDRIVE_KB if _GDRIVE_KB.exists() else _REPO_KB
KB_FALLBACK: Path = _REPO_KB / "databricks-sa-context.md"

# Poll interval shape: 45s cold-start → ramp up → peak → settle at 15s floor.
#
# First wait is 45s — agentic systems don't respond in 5s; waiting less is
# just noise. After the initial wait, ramp briefly to 25s (reduces API chatter
# while Genie is mid-reasoning), then settle to a steady 15s for the long tail.
# At the tail the probability Genie is already done is high and user patience
# is low — 15s is the right balance (not 5s, not 60s).
#
# Cumulative check times (from genie_ask):
#   45 → 60 → 80 → 105 → 125 → 140 → 155 → 170 → 185 → 200
#   → 215 → 230 → 245 → 260 → 275 → 290 → 305s
#
# Total budget: ~305s (5 min 5s). Tail interval: 15s.
GENIE_POLL_INTERVALS = [45, 15, 20, 25, 20, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15]

# For follow-up questions in the chat thread the conversation is already loaded
# in Genie — responses typically arrive in 2-10s, not 45s.  Poll aggressively
# for the first few seconds, then back off if it's a heavier query.
# Total budget: ~90s. Much shorter than live-recording budget.
GENIE_FOLLOWUP_POLL_INTERVALS = [2, 2, 3, 3, 5, 5, 5, 10, 10, 10, 15, 15, 15]
GENIE_MAX_POLLS = len(GENIE_POLL_INTERVALS)
STAGE1_LLM_TIMEOUT = 20   # topic extraction — short response, 20s is safe
STAGE3_LLM_TIMEOUT = 45  # synthesis — 349 tokens observed at ~12s; 45s gives headroom
MAX_LOOP_COUNT = 1  # 1 retry max — total worst-case: 2 × 90s + stage timeouts ≈ 210s
MIN_TRANSCRIPT_WORDS = 50

# ---------------------------------------------------------------------------
# Module-level state
# ---------------------------------------------------------------------------
_genie_available: bool = False
_active_meeting_id: Optional[str] = None
_genie_status_cache: Optional[dict] = None
_genie_status_cache_time: float = 0.0
_current_settings: dict = {}
# Cached WorkspaceClient — created once per profile, reused across all LLM calls.
# Key: cli_profile string. Avoids re-running `databricks auth token` on every call.
_ws_client_cache: dict = {}
# Tracks meetings with an in-flight cycle. Prevents duplicate concurrent cycles
# when Genie takes longer than the frontend timer interval (3 min < 5 min Genie time).
_running_cycles: set = set()


# ---------------------------------------------------------------------------
# State definitions
# ---------------------------------------------------------------------------

class PersistedMeetingState(TypedDict):
    meeting_id: str
    genie_conversation_id: Optional[str]
    cycles_completed: int
    topics_addressed: list
    kb_files_loaded: list
    customer_identified: Optional[str]
    last_cycle_at: str


class AgentWorkingState(TypedDict):
    meeting_id: str
    genie_conversation_id: Optional[str]
    cycles_completed: int
    topics_addressed: list
    kb_files_loaded: list
    customer_identified: Optional[str]
    current_transcript_chunk: str
    current_query: Optional[str]
    user_notes: list
    loop_count: int
    genie_answer: Optional[str]
    genie_sources: list
    genie_status: str
    genie_poll_attempts: int
    genie_response_time: float
    kb_context: Optional[str]
    talking_points: Optional[list]
    quality_sufficient: bool
    llm_fallback_used: bool
    hint_id: Optional[str]
    quality_score: int


# ---------------------------------------------------------------------------
# Genie MCP helpers
# ---------------------------------------------------------------------------

def _get_structured_content(result) -> dict:
    """Extract structuredContent dict from a CallToolResult, or empty dict."""
    sc = getattr(result, 'structuredContent', None)
    return sc if isinstance(sc, dict) else {}


def _parse_conversation_id(result) -> Optional[str]:
    # Primary: structuredContent
    sc = _get_structured_content(result)
    if sc.get("conversation_id"):
        return sc["conversation_id"]
    # Fallback: parse content[0].text
    try:
        raw = result.content[0].text
        logger.debug(f"[genie_live] parsing conversation_id from text: {raw[:200]}")
        try:
            data = json.loads(raw)
            return data.get("conversation_id") or data.get("conversationId")
        except json.JSONDecodeError:
            match = re.search(r'conversation_id["\s:]+([a-zA-Z0-9_-]+)', raw)
            return match.group(1) if match else None
    except Exception as e:
        logger.warning(f"[genie_live] could not parse conversation_id — {e}")
        return None


def _parse_field(result, field: str) -> Optional[str]:
    """Parse any named field — structuredContent first, then content[0].text."""
    sc = _get_structured_content(result)
    if sc.get(field):
        return sc[field]
    try:
        raw = result.content[0].text
        try:
            data = json.loads(raw)
            return data.get(field)
        except json.JSONDecodeError:
            match = re.search(rf'{re.escape(field)}["\s:]+([a-zA-Z0-9_-]+)', raw)
            return match.group(1) if match else None
    except Exception:
        return None


def _is_genie_complete(result) -> bool:
    # Accept "completed" or "complete" — Genie API has returned both
    sc = _get_structured_content(result)
    if sc:
        status = sc.get("status", "")
        is_done = status in ("completed", "complete")
        if is_done:
            final = sc.get("final_answer")
            if not final:
                logger.debug(f"[genie_live] status={status} but final_answer empty — treating as incomplete")
                return False
        return is_done
    # Fallback: text scan
    try:
        raw = result.content[0].text.lower()
        return any(s in raw for s in ["completed", "done", "finished"])
    except Exception:
        return False


def _extract_genie_text(result) -> str:
    # Primary: structuredContent.final_answer (the actual Genie answer)
    sc = _get_structured_content(result)
    if sc.get("final_answer"):
        return sc["final_answer"]
    # Secondary: content[0].text — skip MCP instruction comments
    try:
        raw = result.content[0].text
        if raw.startswith("<!--"):
            return ""  # MCP client instruction, not the answer
        try:
            data = json.loads(raw)
            return (data.get("answer") or data.get("content") or
                    data.get("text") or data.get("response") or str(data))
        except json.JSONDecodeError:
            return raw
    except Exception as e:
        logger.warning(f"[genie_live] text extraction failed — {e}")
        return ""


def _extract_genie_sources(result) -> list:
    # deep_link from structuredContent is a useful source
    sources = []
    sc = _get_structured_content(result)
    if sc.get("deep_link"):
        sources.append({"url": sc["deep_link"], "title": "Explore in Databricks"})
    return sources


async def _call_genie_mcp(state: AgentWorkingState) -> tuple:
    """Returns: (answer, sources, status, poll_attempts, response_time, conversation_id)"""
    if not _genie_available:
        return None, [], "unavailable", 0, 0.0, state.get("genie_conversation_id")

    try:
        from databricks_mcp import DatabricksMCPClient
        from databricks.sdk import WorkspaceClient

        ws = _get_ws_client(_current_settings.get("databricksCliProfile", "DEFAULT"))
        profile_host = (ws.config.host or _current_settings.get("databricksWorkspaceHost", "")).rstrip("/")
        client = DatabricksMCPClient(
            server_url=f"{profile_host}/api/2.0/mcp/genie",
            workspace_client=ws,
        )

        poll_start = time.time()
        conv_id = state.get("genie_conversation_id")

        # Build the rich question for Genie (shown only in logs, not in UI)
        rich_question = _build_genie_question(
            topic=state["current_query"],
            transcript=state.get("current_transcript_chunk", ""),
            customer_identified=state.get("customer_identified"),
            user_notes=state.get("user_notes") or [],
        )
        args = {"question": rich_question}
        if conv_id:
            args["conversation_id"] = conv_id
            logger.info(f"[genie_live] continuing conversation {conv_id}")
        else:
            logger.info("[genie_live] starting new Genie conversation")
        logger.debug(f"[genie_live] genie_ask question: {rich_question[:200]}...")

        ask_result = await client.acall_tool("genie_ask", args)
        # genie_ask returns {"response_id": "...", "conversation_id": "...", "status": "in_progress"}
        # genie_poll_response requires response_id (NOT conversation_id)
        response_id = _parse_field(ask_result, "response_id")
        new_conv_id = _parse_conversation_id(ask_result)
        if new_conv_id:
            conv_id = new_conv_id

        if not response_id:
            logger.warning("[genie_live] genie_ask did not return a response_id — cannot poll")
            return None, [], "unavailable", 0, 0.0, conv_id

        logger.info(f"[genie_live] genie_ask response_id={response_id} conv_id={conv_id}")

        genie_answer = None
        genie_sources = []
        status = "timeout"
        attempt = 0

        for attempt in range(GENIE_MAX_POLLS):
            await asyncio.sleep(GENIE_POLL_INTERVALS[attempt])
            try:
                poll_result = await client.acall_tool(
                    "genie_poll_response",
                    {"response_id": response_id, "conversation_id": conv_id},
                )
                sc_status = _get_structured_content(poll_result).get("status", "?")
                logger.debug(f"[genie_live] poll {attempt+1}: status={sc_status}")
                if _is_genie_complete(poll_result):
                    genie_answer = _extract_genie_text(poll_result)
                    genie_sources = _extract_genie_sources(poll_result)
                    status = "complete"
                    logger.info(f"[genie_live] complete after {attempt+1} polls ({time.time()-poll_start:.1f}s)")
                    break
            except Exception as e:
                logger.warning(f"[genie_live] poll {attempt+1} failed — {e}")
                continue

        return genie_answer, genie_sources, status, attempt + 1, time.time() - poll_start, conv_id

    except Exception as e:
        err = str(e)
        if "write tool" in err.lower() or "disabled" in err.lower():
            logger.warning(f"[genie_live] genie_ask blocked by workspace policy — {e}")
        else:
            logger.warning(f"[genie_live] genie_ask failed — {e}")
        return None, [], "unavailable", 0, 0.0, state.get("genie_conversation_id")


# ---------------------------------------------------------------------------
# KB loading
# ---------------------------------------------------------------------------

def _score_kb_file(rel_path: str, query_lower: str, customer_identified: Optional[str]) -> int:
    """Score a KB file for relevance to a query. Higher = more relevant."""
    parts = rel_path.replace("/", " ").replace("-", " ").replace("_", " ").replace(".md", "")
    score = 0

    # Customer file for the identified customer is always highest priority
    if customer_identified and rel_path == f"customers/{customer_identified}.md":
        score += 100

    # Root-level files (index, open-actions) give useful SA meta-context
    if "/" not in rel_path:
        score += 25

    # Directory name appears in query (e.g. "technical-patterns" → "technical patterns")
    dir_name = rel_path.split("/")[0].replace("-", " ") if "/" in rel_path else ""
    if dir_name and dir_name in query_lower:
        score += 35

    # Individual words in the file path that appear in the query
    for word in parts.split():
        if len(word) >= 4 and word in query_lower:
            score += 15

    return score


def _load_kb_for_query(
    query: str, already_loaded: list, customer_identified: Optional[str] = None
) -> tuple[str, list]:
    """
    Dynamically discover every .md file under KB_BASE, score each by relevance
    to the query, and load the top scorers within a char budget.

    This handles arbitrary new files and subfolders automatically — no hardcoded
    keyword lists required.
    """
    CHAR_BUDGET = 10000  # chars of KB to load per cycle (~2500 tokens); sized for large customer files

    query_lower = query.lower()

    # Discover all .md files recursively; skip templates
    try:
        all_files = [
            p for p in KB_BASE.glob("**/*.md")
            if p.name != "_template.md"
        ]
    except Exception:
        all_files = []

    # Score each file
    scored: list[tuple[int, str, Path]] = []
    for fpath in all_files:
        try:
            rel = str(fpath.relative_to(KB_BASE))
        except ValueError:
            rel = fpath.name
        s = _score_kb_file(rel, query_lower, customer_identified)
        scored.append((s, rel, fpath))

    # Sort: highest score first; skip already-loaded files with score 0
    scored.sort(key=lambda x: -x[0])

    # Load files within budget, always include at least the customer file if identified
    content_parts: list[str] = []
    new_files: list[str] = []
    total_chars = 0

    for score, rel, fpath in scored:
        if rel in already_loaded:
            continue
        # Skip zero-score files unless nothing else was found (handled below)
        if score == 0 and content_parts:
            continue
        try:
            content = fpath.read_text(encoding="utf-8")
        except Exception:
            continue

        if total_chars + len(content) > CHAR_BUDGET:
            remaining = CHAR_BUDGET - total_chars
            if remaining > 300:
                content_parts.append(f"## {rel}\n{content[:remaining]}…")
                new_files.append(rel)
            break

        content_parts.append(f"## {rel}\n{content}")
        new_files.append(rel)
        total_chars += len(content)

    # Nothing loaded at all — use the generic SA context fallback
    if not content_parts:
        fb = load_fallback_kb()
        if fb:
            content_parts.append(fb)
        if "databricks-sa-context.md" not in already_loaded:
            new_files = ["databricks-sa-context.md"]

    logger.debug(f"[kb] loaded {len(content_parts)} files ({total_chars} chars): {new_files}")
    return "\n\n".join(content_parts), new_files


def load_fallback_kb() -> str:
    try:
        return KB_FALLBACK.read_text(encoding="utf-8")
    except FileNotFoundError:
        return "No SA knowledge base file found."


# ---------------------------------------------------------------------------
# Summary-optimised KB loader (implements loader-instructions.md protocol)
# ---------------------------------------------------------------------------

def _parse_index_keyword_map() -> list[tuple[list[str], str]]:
    """
    Parse the File Loading Guide table in index.md.
    Returns list of (keywords, file_path) tuples in table order (= priority order).
    Skips the header and separator rows.
    """
    index_path = KB_BASE / "index.md"
    if not index_path.exists():
        return []

    result: list[tuple[list[str], str]] = []
    in_table = False

    for line in index_path.read_text(encoding="utf-8").split("\n"):
        stripped = line.strip()
        if not stripped.startswith("|"):
            if in_table:
                break  # table ended
            continue

        in_table = True
        # Skip separator rows (|---|---|)
        if re.match(r"^\|[-| ]+\|$", stripped):
            continue

        # Extract cells
        cells = [c.strip() for c in stripped.split("|") if c.strip()]
        if len(cells) < 2:
            continue

        # Skip header row
        kw_cell = cells[0]
        file_cell = cells[1]
        if "trigger" in kw_cell.lower() or "keyword" in kw_cell.lower():
            continue

        # Extract backtick-quoted file path
        m = re.search(r"`([^`]+\.md)`", file_cell)
        if not m:
            continue

        file_path = m.group(1)
        keywords = [k.strip().lower() for k in kw_cell.split(",") if k.strip()]
        if keywords and file_path:
            result.append((keywords, file_path))

    return result


def _load_kb_for_summary(transcript: str) -> tuple[str, list[str]]:
    """
    Load KB files for AI summary generation, implementing the loader-instructions.md protocol:

    Rule 0  — Always load key-contacts.md + databricks-sa-context.md unconditionally.
    Rule 1  — Tier-priority keyword matching from index.md table for additional files.
    Rule 2  — Max 4 files total; always-load files consume 2 slots, leaving 2 for contextual.
    Fallback — If KB unavailable, return empty string (summary runs without context).

    This gives the summary LLM: who was in the room (key-contacts), full account context
    (sa-context), and the 1–2 most-relevant product/competitive/technical files.
    """
    if not KB_BASE.exists():
        logger.debug("[kb-summary] KB_BASE not found, skipping context")
        return "", []

    # ── Rule 0: always-load files ─────────────────────────────────────────────
    ALWAYS_LOAD = ["key-contacts.md", "databricks-sa-context.md"]
    # Per-file char limits to stay within the summary prompt budget
    PER_FILE_LIMITS = {
        "key-contacts.md":        6000,   # rich contact index; first 6k covers all key people
        "databricks-sa-context.md": 8000, # designed to be standalone; load in full (~8k)
    }
    CONTEXTUAL_LIMIT = 3000   # per contextual file
    MAX_CONTEXTUAL   = 2      # slots remaining after always-load

    content_parts: list[str] = []
    loaded: list[str] = []
    total_chars = 0

    for rel in ALWAYS_LOAD:
        fpath = KB_BASE / rel
        if not fpath.exists():
            continue
        try:
            text = fpath.read_text(encoding="utf-8")
            limit = PER_FILE_LIMITS.get(rel, 6000)
            if len(text) > limit:
                text = text[:limit] + "\n…[truncated]"
            content_parts.append(f"### {rel}\n{text}")
            loaded.append(rel)
            total_chars += len(text)
        except Exception as e:
            logger.debug(f"[kb-summary] failed to read {rel}: {e}")

    # ── Rule 1: keyword-match transcript against index.md table ──────────────
    kw_map = _parse_index_keyword_map()
    transcript_lower = transcript.lower()

    # Score each file by how many of its keywords appear in the transcript
    scored: list[tuple[int, int, str]] = []   # (hit_count, table_order, file_path)
    for order, (keywords, file_path) in enumerate(kw_map):
        if file_path in loaded:
            continue  # already included via always-load
        hits = sum(1 for kw in keywords if kw in transcript_lower)
        if hits > 0:
            scored.append((hits, order, file_path))

    # Sort by hit count (desc), then by table order (lower index = higher tier)
    scored.sort(key=lambda x: (-x[0], x[1]))

    # ── Rule 2: fill remaining slots ─────────────────────────────────────────
    for _, _, rel in scored[:MAX_CONTEXTUAL]:
        fpath = KB_BASE / rel
        if not fpath.exists():
            continue
        try:
            text = fpath.read_text(encoding="utf-8")
            if len(text) > CONTEXTUAL_LIMIT:
                text = text[:CONTEXTUAL_LIMIT] + "\n…[truncated]"
            content_parts.append(f"### {rel}\n{text}")
            loaded.append(rel)
            total_chars += len(text)
        except Exception as e:
            logger.debug(f"[kb-summary] failed to read {rel}: {e}")

    logger.info(f"[kb-summary] loaded {len(loaded)} files ({total_chars} chars): {loaded}")
    return "\n\n---\n\n".join(content_parts), loaded


# ---------------------------------------------------------------------------
# LangGraph nodes
# ---------------------------------------------------------------------------

async def retrieve_node(state: AgentWorkingState) -> AgentWorkingState:
    """Node 1: load KB and call Genie in parallel."""
    kb_content, new_files = _load_kb_for_query(
        state["current_query"] or "",
        state.get("kb_files_loaded", []),
        customer_identified=state.get("customer_identified"),
    )

    if _genie_available:
        genie_result = await _call_genie_mcp(state)
        answer, sources, status, attempts, resp_time, conv_id = genie_result
    else:
        answer, sources, status, attempts, resp_time, conv_id = (
            None, [], "unavailable", 0, 0.0, state.get("genie_conversation_id")
        )

    updated = dict(state)
    updated["genie_answer"] = answer
    updated["genie_sources"] = sources
    updated["genie_status"] = status
    updated["genie_poll_attempts"] = attempts
    updated["genie_response_time"] = resp_time
    updated["genie_conversation_id"] = conv_id
    updated["kb_context"] = kb_content
    updated["kb_files_loaded"] = list(state.get("kb_files_loaded", [])) + new_files

    return updated


async def synthesise_node(state: AgentWorkingState, db=None) -> AgentWorkingState:
    """Node 2: synthesise talking points and decide quality."""
    cycle_num = state.get("cycles_completed", 0) + 1
    prev_topics = state.get("topics_addressed", [])

    meeting_context = (
        f"Genie Live — Cycle {cycle_num}\n"
        f"Topics addressed earlier: "
        f"{', '.join(prev_topics[:-1]) if len(prev_topics) > 1 else 'None — first check'}\n"
        f"Current topic: {state['current_query']}\n"
        f"Reformulation attempt: {state.get('loop_count', 0)} of {MAX_LOOP_COUNT}"
    )

    genie_status = state.get("genie_status", "unavailable")
    kb_ctx = state.get("kb_context") or load_fallback_kb()

    if genie_status == "complete" and state.get("genie_answer"):
        sys_p = (
            "You are a Databricks Solutions Architect co-pilot assisting during a live customer meeting. "
            "You have retrieved an answer from an enterprise knowledge base connected to Databricks "
            "documentation, internal SA playbooks, GSK account materials, Glean, and Google Drive.\n\n"
            "Produce two outputs:\n\n"
            "TALKING_POINTS: maximum 4 bullet points. Each must be a complete, usable talking point. "
            "Preserve specific facts, figures, dates, product names, and named documents exactly. "
            "Lead with Databricks-specific products if relevant. Note if this topic relates to "
            "something discussed earlier. Do not add information not in the source.\n\n"
            "QUALITY: rate 1-3 where:\n"
            "1 = irrelevant or too generic\n2 = relevant but incomplete\n3 = relevant and actionable\n\n"
            "Return in this exact format:\nQUALITY: <1|2|3>\nTALKING_POINTS:\n- bullet 1\n- bullet 2"
        )
        usr_p = (
            f"Meeting context:\n{meeting_context}\n\n"
            f"Knowledge base response from Genie Live:\n{state['genie_answer']}\n\n"
            f"Additional SA context:\n{kb_ctx[:6000]}\n\n"
            "Synthesise into talking points."
        )
        llm_fallback = False
    else:
        timeout_note = "timed out after 90s" if genie_status == "timeout" else "was unavailable"
        sys_p = (
            f"You are a Databricks Solutions Architect co-pilot. Genie Live {timeout_note}. "
            "Draw on your Databricks product knowledge and the SA context provided.\n\n"
            "TALKING_POINTS: maximum 4 bullet points, complete and usable. "
            "Focus on Databricks capabilities and enterprise patterns. "
            "Prefix any unverified claim with 'Verify:'. "
            "Do not fabricate specific customer data, dates, or named documents.\n\n"
            "QUALITY: 1-3 (1=cannot address, 2=general guidance, 3=sufficient).\n\n"
            "Return:\nQUALITY: <1|2|3>\nTALKING_POINTS:\n- bullet 1\n- bullet 2"
        )
        usr_p = (
            f"Meeting context:\n{meeting_context}\n\n"
            f"SA knowledge base:\n{kb_ctx[:6000]}\n\n"
            f"Topic: {state['current_query']}"
        )
        llm_fallback = True

    # Call LLM
    llm_response = await _call_llm_with_timeout(sys_p, usr_p, STAGE3_LLM_TIMEOUT)

    # Parse response
    quality_score = 2
    talking_points = []
    if llm_response:
        for line in llm_response.split("\n"):
            if line.startswith("QUALITY:"):
                try:
                    quality_score = int(line.split(":")[-1].strip())
                except Exception:
                    pass
            elif line.strip().startswith("- "):
                talking_points.append(line.strip()[2:])

    quality_sufficient = (
        quality_score >= 2
        or state.get("loop_count", 0) >= MAX_LOOP_COUNT
        or genie_status == "unavailable"
    )

    updated = dict(state)
    updated["talking_points"] = talking_points
    updated["quality_score"] = quality_score
    updated["quality_sufficient"] = quality_sufficient
    updated["llm_fallback_used"] = llm_fallback

    # If quality insufficient and loops remain, reformulate query
    if not quality_sufficient and state.get("loop_count", 0) < MAX_LOOP_COUNT:
        reform_prompt = (
            f"The following search query returned a low-quality result (rated {quality_score}/3) "
            f"from an enterprise knowledge base: '{state['current_query']}'\n\n"
            "Return a single improved search query of max 12 words. Return only the query."
        )
        new_query = await _call_llm_with_timeout("", reform_prompt, 5)
        if new_query:
            updated["current_query"] = new_query.strip()
        updated["loop_count"] = state.get("loop_count", 0) + 1
    else:
        # Save hint to DB if we have one
        if db and updated.get("hint_id") and talking_points:
            try:
                await db.update_copilot_hint(
                    updated["hint_id"],
                    {
                        "talking_points": json.dumps(talking_points),
                        "topic_detected": state.get("current_query", ""),
                        "genie_status": genie_status,
                        "genie_raw_answer": state.get("genie_answer"),
                        "genie_sources": json.dumps(updated.get("genie_sources", [])),
                        "genie_conversation_id": updated.get("genie_conversation_id"),
                        "genie_poll_attempts": updated.get("genie_poll_attempts", 0),
                        "genie_response_time_seconds": round(updated.get("genie_response_time", 0.0), 2),
                        "llm_fallback_used": 1 if llm_fallback else 0,
                        "quality_score": quality_score,
                        "loop_count_used": state.get("loop_count", 0),
                        "cycle_number": cycle_num,
                        "updated_at": datetime.datetime.utcnow().isoformat(),
                    }
                )
            except Exception as e:
                logger.error(f"[genie_live] hint DB update failed — {e}")

    return updated


def _should_loop(state: AgentWorkingState) -> str:
    if (
        not state.get("quality_sufficient", True)
        and state.get("loop_count", 0) < MAX_LOOP_COUNT
        and state.get("genie_status") != "unavailable"
    ):
        return "retrieve"
    return "end"


# ---------------------------------------------------------------------------
# Build LangGraph graph
# ---------------------------------------------------------------------------

def _build_graph(db=None):
    """Build and compile the LangGraph agent graph with MemorySaver checkpointer."""
    try:
        from langgraph.graph import StateGraph, END
        from langgraph.checkpoint.memory import MemorySaver

        builder = StateGraph(AgentWorkingState)

        # Bind db to synthesise_node via closure
        async def _synthesise(state):
            return await synthesise_node(state, db=db)

        builder.add_node("retrieve", retrieve_node)
        builder.add_node("synthesise", _synthesise)
        builder.set_entry_point("retrieve")
        builder.add_edge("retrieve", "synthesise")
        builder.add_conditional_edges(
            "synthesise",
            _should_loop,
            {"retrieve": "retrieve", "end": END}
        )

        graph = builder.compile(checkpointer=MemorySaver())
        logger.info("[genie_live] LangGraph graph compiled with MemorySaver")
        return graph

    except ImportError as e:
        logger.warning(f"[genie_live] LangGraph not available — {e}")
        return None


_graph = None


def get_graph(db=None):
    global _graph
    if _graph is None:
        _graph = _build_graph(db)
    return _graph


# ---------------------------------------------------------------------------
# LLM caller
# ---------------------------------------------------------------------------

async def _call_llm_with_timeout(system_prompt: str, user_message: str, timeout: float) -> Optional[str]:
    """Call the configured LLM. Uses _current_settings.

    Provider priority:
    1. Whatever is configured in the Python backend settings table
    2. Rust SQLite model config (Databricks) as automatic fallback when
       the configured provider is unavailable (e.g. Ollama not running)
    """
    settings = _current_settings
    provider = (settings.get("provider") or "").lower()
    model = settings.get("model") or ""

    # Always read Databricks config from Rust SQLite as a fallback source
    rust_cfg = _read_rust_model_config()

    if not provider or not model:
        # No provider configured at all — use Rust config directly
        if rust_cfg:
            provider = rust_cfg.get("provider", "databricks")
            model = rust_cfg.get("model", "")
            settings = {**settings, **rust_cfg, "databricksCliProfile": settings.get("databricksCliProfile", "logfood")}

    async def _do():
        try:
            if provider == "databricks":
                from databricks.sdk import WorkspaceClient
                from databricks.sdk.service.serving import ChatMessage, ChatMessageRole

                cli_profile = settings.get("databricksCliProfile", "DEFAULT")

                def _sync():
                    ws = _get_ws_client(cli_profile)
                    msgs = []
                    if system_prompt:
                        msgs.append(ChatMessage(role=ChatMessageRole.SYSTEM, content=system_prompt))
                    msgs.append(ChatMessage(role=ChatMessageRole.USER, content=user_message))
                    resp = ws.serving_endpoints.query(name=model, messages=msgs, max_tokens=1500)
                    return resp.choices[0].message.content if resp.choices else None

                loop = asyncio.get_event_loop()
                return await loop.run_in_executor(None, _sync)

            elif provider == "ollama":
                from ollama import AsyncClient
                client = AsyncClient(host=os.getenv("OLLAMA_HOST", "http://127.0.0.1:11434"))
                resp = await client.chat(model=model, messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_message},
                ])
                return resp["message"]["content"]

            elif provider == "claude":
                import anthropic
                api_key = settings.get("anthropicApiKey") or os.getenv("ANTHROPIC_API_KEY", "")
                client = anthropic.AsyncAnthropic(api_key=api_key)
                msg = await client.messages.create(
                    model=model, max_tokens=1500, system=system_prompt,
                    messages=[{"role": "user", "content": user_message}]
                )
                return msg.content[0].text if msg.content else None
        except Exception as e:
            logger.error(f"[genie_live] LLM call failed ({provider}): {e}")
            return None

    try:
        result = await asyncio.wait_for(_do(), timeout=timeout)
    except asyncio.TimeoutError:
        logger.warning(f"[genie_live] LLM timed out after {timeout}s")
        result = None

    # If configured provider failed (Ollama down, API key missing, etc.)
    # and Databricks is available from Rust config, retry with Databricks
    if result is None and provider != "databricks" and rust_cfg:
        db_provider = rust_cfg.get("provider", "databricks")
        db_model = rust_cfg.get("model", "")
        if db_provider == "databricks" and db_model:
            logger.info(f"[genie_live] {provider} failed — retrying with Databricks fallback")
            db_settings = {**settings, **rust_cfg,
                           "databricksCliProfile": settings.get("databricksCliProfile", "logfood")}

            async def _databricks_fallback():
                try:
                    from databricks.sdk import WorkspaceClient
                    from databricks.sdk.service.serving import ChatMessage, ChatMessageRole
                    cli_profile = db_settings.get("databricksCliProfile", "DEFAULT")
                    def _sync():
                        ws = _get_ws_client(cli_profile)
                        msgs = []
                        if system_prompt:
                            msgs.append(ChatMessage(role=ChatMessageRole.SYSTEM, content=system_prompt))
                        msgs.append(ChatMessage(role=ChatMessageRole.USER, content=user_message))
                        resp = ws.serving_endpoints.query(name=db_model, messages=msgs, max_tokens=1500)
                        return resp.choices[0].message.content if resp.choices else None
                    loop = asyncio.get_event_loop()
                    return await loop.run_in_executor(None, _sync)
                except Exception as e:
                    logger.error(f"[genie_live] Databricks fallback also failed: {e}")
                    return None

            try:
                result = await asyncio.wait_for(_databricks_fallback(), timeout=timeout + 5)
            except asyncio.TimeoutError:
                logger.warning("[genie_live] Databricks fallback timed out")

    return result


def _get_ws_client(cli_profile: str):
    """Return a cached WorkspaceClient for the given profile.
    Avoids re-running `databricks auth token` on every LLM call.
    """
    global _ws_client_cache
    if cli_profile not in _ws_client_cache:
        from databricks.sdk import WorkspaceClient
        _ws_client_cache[cli_profile] = WorkspaceClient(profile=cli_profile)
        logger.info(f"[genie_live] WorkspaceClient created for profile '{cli_profile}'")
    return _ws_client_cache[cli_profile]


def _rust_sqlite_path() -> str:
    home = os.path.expanduser("~")
    return os.path.join(home, "Library", "Application Support", "com.meetily.ai", "meeting_minutes.sqlite")


def _read_rust_model_config() -> dict:
    try:
        conn = _sqlite3.connect(_rust_sqlite_path(), timeout=3, check_same_thread=False)
        row = conn.execute("SELECT provider, model FROM settings LIMIT 1").fetchone()
        conn.close()
        return {"provider": row[0], "model": row[1]} if row else {}
    except Exception:
        return {}


# ---------------------------------------------------------------------------
# Genie status probe
# ---------------------------------------------------------------------------

async def get_genie_status(workspace_host: str, cli_profile: str) -> dict:
    global _genie_status_cache, _genie_status_cache_time

    now = time.time()
    cache_ttl = 60 if (_genie_status_cache or {}).get("available") else 5
    if _genie_status_cache and (now - _genie_status_cache_time) < cache_ttl:
        return _genie_status_cache

    if not workspace_host:
        result = {"available": False, "reason": "not_configured", "tools": [], "workspace_host_masked": ""}
        _genie_status_cache = result
        _genie_status_cache_time = now
        return result

    try:
        masked = workspace_host[:20] + "..." if len(workspace_host) > 20 else workspace_host
    except Exception:
        masked = "***"

    try:
        from databricks_mcp import DatabricksMCPClient
        from databricks.sdk import WorkspaceClient
        from mcp.client.session import ClientSession
        from mcp.client.streamable_http import streamablehttp_client
        from mcp.types import SamplingCapability
        from databricks_mcp.oauth_provider import DatabricksOAuthClientProvider

        ws = _get_ws_client(cli_profile)
        profile_host = (ws.config.host or workspace_host).rstrip("/")
        auth = DatabricksOAuthClientProvider(ws)

        async def _probe():
            async with streamablehttp_client(url=f"{profile_host}/api/2.0/mcp/genie", auth=auth) as (r, w, _):
                async with ClientSession(r, w, sampling_capabilities=SamplingCapability()) as session:
                    await session.initialize()
                    # list_tools confirms the MCP server is reachable and authenticated.
                    # No need to make a real genie_ask call for a connectivity check.
                    listed = await session.list_tools()
                    return [t.name for t in listed.tools]

        tools = await asyncio.wait_for(_probe(), timeout=20.0)
        has_ask = "genie_ask" in tools
        result = {
            "available": has_ask,
            "reason": "connected" if has_ask else "genie_ask tool not listed",
            "tools": tools,
            "workspace_host_masked": masked,
        }

    except asyncio.TimeoutError:
        result = {"available": False, "reason": "probe timed out", "tools": [], "workspace_host_masked": masked}
    except Exception as e:
        result = {"available": False, "reason": "connection_failed", "tools": [], "workspace_host_masked": masked}

    _genie_status_cache = result
    _genie_status_cache_time = now
    return result


# ---------------------------------------------------------------------------
# Init and scheduler
# ---------------------------------------------------------------------------

def init_genie_live(workspace_host: str, cli_profile: str, settings: dict = None, knowledge_store_path: str = '') -> bool:
    global _genie_available, _current_settings, KB_BASE

    if settings:
        _current_settings = settings

    # Apply knowledge store path override (from settings UI) if provided and valid.
    # Priority: settings UI path → Google Drive auto-detect → repo fallback.
    if knowledge_store_path and knowledge_store_path.strip():
        configured = Path(knowledge_store_path.strip()).expanduser()
        if configured.exists():
            KB_BASE = configured
            logger.info(f"[genie_live] KB_BASE set from settings: {KB_BASE}")
        else:
            logger.warning(
                f"[genie_live] knowledgeStorePath '{knowledge_store_path}' does not exist — "
                f"keeping current KB_BASE: {KB_BASE}"
            )

    # Optimistically mark Genie as available — whether genie_ask is actually
    # permitted by the workspace is discovered lazily on the first call.
    # Using client.list_tools() here would call asyncio.run() which crashes
    # inside FastAPI's already-running event loop.
    if workspace_host:
        try:
            _get_ws_client(cli_profile)  # warm the client cache, trigger auth once
            _genie_available = True
            logger.info(f"[genie_live] init: Genie optimistically enabled for {cli_profile}")
        except Exception as e:
            logger.warning(f"[genie_live] init: workspace client failed — {e}")
            _genie_available = False
    else:
        _genie_available = False
        logger.info("[genie_live] init: no workspace host — LLM fallback only")

    return _genie_available


def stop_scheduler(meeting_id: str):
    """Called by recording-signal stop. Clears the in-flight lock for this meeting."""
    global _active_meeting_id, _running_cycles
    _active_meeting_id = None
    _running_cycles.discard(meeting_id)
    logger.info(f"[genie_live] recording stopped for {meeting_id}")


# ---------------------------------------------------------------------------
# Main cycle entrypoint
# ---------------------------------------------------------------------------

async def run_genie_live_cycle(
    meeting_id: str,
    db,
    transcript_chunk: str,
    user_notes: list = None,        # SA-typed notes — take priority over transcript topics
) -> Optional[str]:
    """
    Run one Genie Live analysis cycle.

    The transcript is provided by the caller (frontend hook reads from
    TranscriptContext memory). The backend never fetches transcripts from
    any DB during recording — they don't exist there yet.
    """
    # Step 1: Guard — only one cycle at a time per meeting.
    # Genie takes 2-5 min; the frontend timer fires every 3 min.
    # Without this guard, a second request starts before the first finishes,
    # both read cycles_completed=0, and both create "Check 1" duplicates.
    global _running_cycles
    if meeting_id in _running_cycles:
        logger.info(f"[genie_live] cycle already running for {meeting_id} — skipping duplicate")
        return None
    _running_cycles.add(meeting_id)

    try:
        return await _run_genie_cycle(meeting_id, db, transcript_chunk, user_notes)
    finally:
        _running_cycles.discard(meeting_id)


async def _run_genie_cycle(
    meeting_id: str,
    db,
    transcript_chunk: str,
    user_notes: list = None,
) -> Optional[str]:
    """Inner implementation — called only when no cycle is running for this meeting."""
    if not transcript_chunk or len(transcript_chunk.split()) < MIN_TRANSCRIPT_WORDS:
        logger.info(f"[genie_live] skipping — transcript too short ({len(transcript_chunk.split())} words)")
        try:
            from main import _telemetry
            await _telemetry.capture("genie_live_skipped", {"reason": "short_transcript"})
        except Exception:
            pass
        return None

    # Step 2: Load persisted state
    persisted = await db.get_meeting_agent_state(meeting_id)
    if not persisted:
        persisted = PersistedMeetingState(
            meeting_id=meeting_id,
            genie_conversation_id=None,
            cycles_completed=0,
            topics_addressed=[],
            kb_files_loaded=[],
            customer_identified=detect_customer(transcript_chunk),
            last_cycle_at=datetime.datetime.utcnow().isoformat(),
        )

    # Step 3: Topic extraction — user notes take priority
    extracted_query = await _extract_topic(
        transcript_chunk, persisted.get("topics_addressed", []), user_notes=user_notes or []
    )
    if not extracted_query or extracted_query.upper() == "SKIP":
        logger.info(f"[genie_live] skipping — no actionable topic for {meeting_id}")
        try:
            from main import _telemetry
            await _telemetry.capture("genie_live_skipped", {"reason": "no_topic"})
        except Exception:
            pass
        return None

    logger.info(f"[genie_live] cycle {persisted['cycles_completed']+1} — topic: '{extracted_query}'")
    try:
        from main import _telemetry
        await _telemetry.capture("genie_live_cycle_fired")
    except Exception:
        pass

    # Step 4: Create pending hint
    hint_id = str(uuid.uuid4())
    try:
        await db.create_copilot_hint(
            hint_id=hint_id,
            meeting_id=meeting_id,
            cycle_number=persisted["cycles_completed"] + 1,
            extracted_query=extracted_query,
            genie_status="pending",
        )
    except Exception as e:
        logger.error(f"[genie_live] hint creation failed — {type(e).__name__}: {e}")
        hint_id = None

    # Step 5: Build working state
    working_state = AgentWorkingState(
        meeting_id=meeting_id,
        genie_conversation_id=persisted.get("genie_conversation_id"),
        cycles_completed=persisted.get("cycles_completed", 0),
        topics_addressed=list(persisted.get("topics_addressed", [])),
        kb_files_loaded=list(persisted.get("kb_files_loaded", [])),
        customer_identified=persisted.get("customer_identified"),
        current_transcript_chunk=transcript_chunk,
        current_query=extracted_query,
        user_notes=user_notes or [],
        loop_count=0,
        genie_answer=None,
        genie_sources=[],
        genie_status="pending",
        genie_poll_attempts=0,
        genie_response_time=0.0,
        kb_context=None,
        talking_points=None,
        quality_sufficient=False,
        llm_fallback_used=False,
        hint_id=hint_id,
        quality_score=2,
    )

    # Step 6: Run LangGraph agent (always mark hint non-pending on any exit path)
    async def _mark_hint_failed():
        if hint_id:
            try:
                await db.update_copilot_hint(hint_id, {
                    "genie_status": "unavailable",
                    "updated_at": datetime.datetime.utcnow().isoformat(),
                })
            except Exception:
                pass

    graph = get_graph(db)
    try:
        if graph:
            config = {"configurable": {"thread_id": f"{meeting_id}_{persisted['cycles_completed']}"}}
            final_state = await graph.ainvoke(working_state, config=config)
        else:
            # LangGraph unavailable — run nodes directly
            s = await retrieve_node(working_state)
            final_state = await synthesise_node(s, db=db)
    except Exception as e:
        logger.error(f"[genie_live] cycle failed — {e}", exc_info=True)
        await _mark_hint_failed()
        return None

    # Step 7: Persist meeting state
    try:
        await db.upsert_meeting_agent_state(PersistedMeetingState(
            meeting_id=meeting_id,
            genie_conversation_id=final_state.get("genie_conversation_id"),
            cycles_completed=final_state.get("cycles_completed", 0) + 1,
            topics_addressed=list(final_state.get("topics_addressed", [])) + [extracted_query],
            kb_files_loaded=final_state.get("kb_files_loaded", []),
            customer_identified=final_state.get("customer_identified"),
            last_cycle_at=datetime.datetime.utcnow().isoformat(),
        ))
    except Exception as e:
        logger.warning(f"[genie_live] state persist failed: {e}")

    logger.info(
        f"[genie_live] cycle complete — hint={hint_id} "
        f"quality={final_state.get('quality_score')} "
        f"genie={final_state.get('genie_status')} "
        f"loops={final_state.get('loop_count')}"
    )
    try:
        from main import _telemetry
        raw_rt = final_state.get("genie_response_time", 0)
        await _telemetry.capture("genie_live_cycle_completed", {
            "genie_status": final_state.get("genie_status", "unknown"),
            "response_time_seconds": round(raw_rt) if raw_rt else 0,
            "quality_score": final_state.get("quality_score"),
            "loop_count": final_state.get("loop_count", 0),
            "llm_fallback_used": int(bool(final_state.get("llm_fallback_used", False))),
        })
    except Exception:
        pass
    return hint_id


async def _get_transcripts_from_rust_db(meeting_id: str, since_iso: str) -> str:
    def _read():
        try:
            conn = _sqlite3.connect(_rust_sqlite_path(), timeout=5, check_same_thread=False)
            time_since = since_iso[11:19] if len(since_iso) >= 19 else "00:00:00"
            rows = conn.execute(
                "SELECT transcript FROM transcripts WHERE meeting_id=? AND timestamp>=? ORDER BY rowid ASC",
                (meeting_id, time_since)
            ).fetchall()
            conn.close()
            return " ".join(r[0] for r in rows if r[0])
        except Exception as e:
            logger.debug(f"[genie_live] Rust SQLite read failed: {e}")
            return ""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _read)


async def _get_all_transcripts_for_meeting(meeting_id: str, db) -> str:
    """
    Wide fallback: fetch ALL transcripts for this meeting from both DBs.
    Used when the 5-minute time-window query returns empty due to timestamp format mismatch.
    """
    # Try Python backend first (all rows, no time filter)
    try:
        async with db._get_connection() as conn:
            cursor = await conn.execute(
                "SELECT transcript FROM transcripts WHERE meeting_id=? ORDER BY rowid ASC",
                (meeting_id,)
            )
            rows = await cursor.fetchall()
            if rows:
                result = " ".join(r[0] for r in rows if r[0])
                if result:
                    logger.info(f"[genie_live] wide fallback (Python DB): {len(rows)} rows for {meeting_id}")
                    return result
    except Exception as e:
        logger.debug(f"[genie_live] Python DB wide fallback failed: {e}")

    # Try Rust SQLite (all rows, no time filter)
    def _read_all():
        try:
            conn = _sqlite3.connect(_rust_sqlite_path(), timeout=5, check_same_thread=False)
            rows = conn.execute(
                "SELECT transcript FROM transcripts WHERE meeting_id=? ORDER BY rowid ASC",
                (meeting_id,)
            ).fetchall()
            conn.close()
            return " ".join(r[0] for r in rows if r[0])
        except Exception as e:
            logger.debug(f"[genie_live] Rust SQLite wide fallback failed: {e}")
            return ""

    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, _read_all)
    if result:
        logger.info(f"[genie_live] wide fallback (Rust SQLite): found content for {meeting_id}")
    return result


async def _extract_topic(transcript: str, topics_addressed: list, user_notes: list = None) -> Optional[str]:
    """Extract a SHORT topic label (max 10 words) for display in the hint card UI.

    This is separate from the rich Genie question — the short label is what the SA
    sees in the sidebar card header. The full question sent to Genie is built by
    _build_genie_question() using this label plus context.
    """
    has_notes = bool(user_notes)

    notes_priority = (
        "\n\nThe SA has added notes (see USER NOTES below). "
        "Base the topic label on those notes first."
        if has_notes else ""
    )

    sys_p = (
        "You are a meeting intelligence assistant for a Databricks Solutions Architect.\n\n"
        "Rules:\n"
        "1. If the transcript has NO actionable topic (small talk, scheduling, intros only) "
        "AND there are no user notes, return the exact string SKIP and nothing else.\n"
        "2. Otherwise, return a concise topic label of maximum 10 words that captures the "
        "key question, concern, or subject being discussed.\n"
        "Return ONLY the label or SKIP — no explanation, no punctuation at the end."
        + notes_priority
    )

    notes_block = ""
    if has_notes:
        notes_list = "\n".join(f"- {n}" for n in user_notes)
        notes_block = f"\n\nUSER NOTES (highest priority):\n{notes_list}"

    usr_p = (
        f"Transcript (last few minutes):\n{transcript[:1500]}"
        + notes_block
        # Only pass the immediately previous topic — prevents back-to-back duplicates
        # without blocking the natural meeting flow across cycles.
        + f"\n\nMost recent topic (avoid repeating this exact angle):\n"
        + (topics_addressed[-1] if topics_addressed else 'None — first check')
    )
    return await _call_llm_with_timeout(sys_p, usr_p, STAGE1_LLM_TIMEOUT)


def _build_genie_question(
    topic: str,
    transcript: str,
    customer_identified: Optional[str],
    user_notes: list = None,
) -> str:
    """Build the rich, context-aware question sent to Genie MCP.

    Genie has access to corporate calendar, email, Glean, and Google Drive — it
    needs context to know what to search.  This is NOT shown in the UI; only the
    short topic label from _extract_topic is shown.
    """
    parts: list[str] = []

    if customer_identified:
        parts.append(f"I am in a meeting with a {customer_identified.upper()} team.")
    else:
        parts.append("I am in a customer meeting.")

    parts.append(f"The discussion has turned to: {topic}.")

    # Include a short transcript excerpt for grounding
    words = transcript.split()
    if len(words) > 40:
        excerpt = " ".join(words[-120:])
        parts.append(f"Recent transcript context: \"{excerpt[:500]}\"")

    # User notes take highest priority
    if user_notes:
        notes_str = "; ".join(user_notes[:3])
        parts.append(f"The SA has specifically noted: {notes_str}")

    parts.append(
        f"Please search all connected sources (Databricks docs, SA playbooks, "
        f"account materials, Glean, email, calendar, Google Drive) for information "
        f"about '{topic}' that I can use as talking points right now."
    )

    return " ".join(parts)


def detect_customer(transcript: str) -> Optional[str]:
    t = transcript.lower()
    customers = {
        "gsk": ["gsk", "glaxosmithkline", "shobie", "saqib", "mahendra", "vishnu", "kim branson"],
        "rolls-royce": ["rolls-royce", "rolls royce", "airr"],
        "databricks": ["internal", "field eng", "se team"],
    }
    for customer, keywords in customers.items():
        if any(kw in t for kw in keywords):
            return customer
    return None


async def cleanup_old_state(db):
    try:
        await db.cleanup_old_agent_state(days=30)
        logger.info("[genie_live] old agent state cleaned up")
    except Exception as e:
        logger.warning(f"[genie_live] cleanup failed: {e}")


# ---------------------------------------------------------------------------
# Genie chat continuation (summary page follow-up thread)
# ---------------------------------------------------------------------------

async def _ensure_genie_available(db) -> bool:
    """
    If Genie is not already initialised, try to do so from the persisted
    copilot settings.  Called by the chat endpoint so the summary page
    can use Genie even when no recording has happened in this process.
    """
    global _genie_available
    if _genie_available:
        logger.info("[genie_chat] _ensure_genie_available: already initialised")
        return True
    logger.info("[genie_chat] _ensure_genie_available: Genie not yet init — loading settings...")
    try:
        settings = await db.get_copilot_settings()
        host    = settings.get("databricksWorkspaceHost") or ""
        profile = settings.get("databricksCliProfile") or "DEFAULT"
        ksp     = settings.get("knowledgeStorePath") or ""
        logger.info(f"[genie_chat] settings: host={host!r} profile={profile!r}")
        if host and profile:
            result = init_genie_live(host, profile, settings, knowledge_store_path=ksp)
            logger.info(f"[genie_chat] init_genie_live returned: {result}, _genie_available={_genie_available}")
            return result
        else:
            logger.warning(f"[genie_chat] cannot init — host={host!r} profile={profile!r} (empty)")
    except Exception as e:
        logger.error(f"[genie_chat] _ensure_genie_available exception: {type(e).__name__}: {e}", exc_info=True)
    return False


async def ask_genie_followup(question: str, conversation_id: Optional[str]) -> tuple:
    """
    Continue a Genie conversation with a follow-up question.
    Returns: (answer_text, sources, status)
    NOTE: caller should call _ensure_genie_available(db) first.
    """
    import time as _time
    t0 = _time.time()

    logger.info(f"[genie_chat] ask_genie_followup START — question={question[:60]!r} conv_id={conversation_id}")
    logger.info(f"[genie_chat] _genie_available={_genie_available} settings_host={_current_settings.get('databricksWorkspaceHost','(none)')!r}")

    if not _genie_available:
        logger.warning("[genie_chat] Genie not available — returning unavailable")
        return None, [], "unavailable"

    try:
        from databricks_mcp import DatabricksMCPClient

        ws = _get_ws_client(_current_settings.get("databricksCliProfile", "DEFAULT"))
        profile_host = (ws.config.host or _current_settings.get("databricksWorkspaceHost", "")).rstrip("/")
        logger.info(f"[genie_chat] MCP endpoint: {profile_host}/api/2.0/mcp/genie")
        client = DatabricksMCPClient(
            server_url=f"{profile_host}/api/2.0/mcp/genie",
            workspace_client=ws,
        )

        args: dict = {"question": question}
        if conversation_id:
            args["conversation_id"] = conversation_id
            logger.info(f"[genie_chat] continuing conversation {conversation_id}")
        else:
            logger.info("[genie_chat] starting new Genie conversation (no conv_id)")

        logger.info("[genie_chat] calling genie_ask...")
        ask_result = await client.acall_tool("genie_ask", args)
        logger.info(f"[genie_chat] genie_ask returned in {_time.time()-t0:.1f}s: {str(ask_result)[:200]}")

        response_id = _parse_field(ask_result, "response_id")
        new_conv_id = _parse_conversation_id(ask_result)
        conv_id = new_conv_id or conversation_id
        logger.info(f"[genie_chat] response_id={response_id} conv_id={conv_id}")

        if not response_id:
            logger.warning("[genie_chat] genie_ask returned no response_id — returning unavailable")
            return None, [], "unavailable"

        # Use the fast follow-up schedule — Genie already has context loaded
        for attempt, wait in enumerate(GENIE_FOLLOWUP_POLL_INTERVALS):
            logger.info(f"[genie_chat] waiting {wait}s before poll {attempt+1}/{len(GENIE_FOLLOWUP_POLL_INTERVALS)} (elapsed {_time.time()-t0:.1f}s)")
            await asyncio.sleep(wait)
            try:
                poll_result = await client.acall_tool(
                    "genie_poll_response",
                    {"response_id": response_id, "conversation_id": conv_id},
                )
                sc = _get_structured_content(poll_result)
                status_str = sc.get("status", "?")
                is_done = _is_genie_complete(poll_result)
                answer_text = _extract_genie_text(poll_result) if is_done else ""

                logger.info(f"[genie_chat] poll {attempt+1} sc_status={status_str!r} is_done={is_done} has_text={bool(answer_text)} elapsed={_time.time()-t0:.1f}s")

                if is_done and answer_text:
                    logger.info(f"[genie_chat] SUCCESS after {attempt+1} polls ({_time.time()-t0:.1f}s total)")
                    return answer_text, [], "complete"
                if status_str in ("failed", "error"):
                    logger.warning(f"[genie_chat] Genie returned error status at poll {attempt+1}")
                    return None, [], "error"
            except Exception as e:
                logger.warning(f"[genie_chat] poll {attempt+1} exception: {type(e).__name__}: {e}")
                continue

        logger.warning(f"[genie_chat] TIMEOUT after all {len(GENIE_FOLLOWUP_POLL_INTERVALS)} polls ({_time.time()-t0:.1f}s total)")
        return None, [], "timeout"

    except Exception as e:
        logger.error(f"[genie_chat] EXCEPTION in ask_genie_followup ({_time.time()-t0:.1f}s): {type(e).__name__}: {e}", exc_info=True)
        return None, [], "unavailable"
