from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from pathlib import Path
import uvicorn
from typing import Optional, List
import logging
from dotenv import load_dotenv
from db import DatabaseManager
import json
from threading import Lock
from transcript_processor import TranscriptProcessor
import time
from gcal import router as calendar_router, init_calendar, calendar_polling_loop
from genie_live_agent import (init_genie_live, stop_scheduler, get_genie_status, cleanup_old_state)
from telemetry import TelemetryWriter, get_app_version

# Load environment variables
load_dotenv()

# Configure logger with line numbers and function names
logger = logging.getLogger(__name__)
logger.setLevel(logging.DEBUG)

# Create console handler with formatting
console_handler = logging.StreamHandler()
console_handler.setLevel(logging.DEBUG)

# Create formatter with line numbers and function names
formatter = logging.Formatter(
    '%(asctime)s - %(levelname)s - [%(filename)s:%(lineno)d - %(funcName)s()] - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
console_handler.setFormatter(formatter)

# Add handler to logger if not already added
if not logger.handlers:
    logger.addHandler(console_handler)

app = FastAPI(
    title="Meeting Summarizer API",
    description="API for processing and summarizing meeting transcripts",
    version="1.0.0"
)

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],     # Allow all origins for testing
    allow_credentials=True,
    allow_methods=["*"],     # Allow all methods
    allow_headers=["*"],     # Allow all headers
    max_age=3600,            # Cache preflight requests for 1 hour
)

app.include_router(calendar_router)

# Global database manager instance for meeting management endpoints
db = DatabaseManager()

# Telemetry — initialised in startup_event once DB is ready.
# Always present so route handlers can call capture() safely before startup completes.
_telemetry: TelemetryWriter = TelemetryWriter("", "boot", get_app_version())

# New Pydantic models for meeting management
class Transcript(BaseModel):
    id: str
    text: str
    timestamp: str
    # Recording-relative timestamps for audio-transcript synchronization
    audio_start_time: Optional[float] = None
    audio_end_time: Optional[float] = None
    duration: Optional[float] = None

class MeetingResponse(BaseModel):
    id: str
    title: str

class MeetingDetailsResponse(BaseModel):
    id: str
    title: str
    created_at: str
    updated_at: str
    transcripts: List[Transcript]

class MeetingTitleUpdate(BaseModel):
    meeting_id: str
    title: str

class DeleteMeetingRequest(BaseModel):
    meeting_id: str

class SaveTranscriptRequest(BaseModel):
    meeting_title: str
    transcripts: List[Transcript]
    folder_path: Optional[str] = None  # NEW: Path to meeting folder (for new folder structure)
    meeting_id: Optional[str] = None   # Pre-generated UUID from Rust (for attachment linkage)

class SaveModelConfigRequest(BaseModel):
    provider: str
    model: str
    whisperModel: str
    apiKey: Optional[str] = None

class SaveTranscriptConfigRequest(BaseModel):
    provider: str
    model: str
    apiKey: Optional[str] = None

class TranscriptRequest(BaseModel):
    """Request model for transcript text, updated with meeting_id"""
    text: str
    model: str
    model_name: str
    meeting_id: str
    chunk_size: Optional[int] = 5000
    overlap: Optional[int] = 1000
    custom_prompt: Optional[str] = "Generate a summary of the meeting transcript."

# Copilot Pydantic models
class CopilotHint(BaseModel):
    id: str
    meeting_id: str
    created_at: str
    updated_at: Optional[str] = None
    cycle_number: Optional[int] = None
    extracted_query: Optional[str] = None
    talking_points: List[str] = []
    genie_status: Optional[str] = "pending"
    genie_raw_answer: Optional[str] = None
    genie_sources: List[dict] = []
    genie_conversation_id: Optional[str] = None
    genie_poll_attempts: Optional[int] = None
    genie_response_time_seconds: Optional[float] = None
    llm_fallback_used: bool = False

class CopilotRecordingSignal(BaseModel):
    action: str   # "start" or "stop"
    meeting_id: str

class SaveCopilotSettingsRequest(BaseModel):
    databricksWorkspaceHost: Optional[str] = None
    databricksCliProfile: str = "DEFAULT"
    copilotEnabled: bool = False
    copilotIntervalMinutes: int = 5
    knowledgeStorePath: str = ""

class SummaryProcessor:
    """Handles the processing of summaries in a thread-safe way"""
    def __init__(self):
        try:
            self.db = DatabaseManager()

            logger.info("Initializing SummaryProcessor components")
            self.transcript_processor = TranscriptProcessor()
            logger.info("SummaryProcessor initialized successfully (core components)")
        except Exception as e:
            logger.error(f"Failed to initialize SummaryProcessor: {str(e)}", exc_info=True)
            raise

    async def process_transcript(self, text: str, model: str, model_name: str, chunk_size: int = 5000, overlap: int = 1000, custom_prompt: str = "Generate a summary of the meeting transcript.") -> tuple:
        """Process a transcript text"""
        try:
            if not text:
                raise ValueError("Empty transcript text provided")

            # Validate chunk_size and overlap
            if chunk_size <= 0:
                raise ValueError("chunk_size must be positive")
            if overlap < 0:
                raise ValueError("overlap must be non-negative")
            if overlap >= chunk_size:
                overlap = chunk_size - 1  # Ensure overlap is less than chunk_size

            # Ensure step size is positive
            step_size = chunk_size - overlap
            if step_size <= 0:
                chunk_size = overlap + 1  # Adjust chunk_size to ensure positive step

            logger.info(f"Processing transcript of length {len(text)} with chunk_size={chunk_size}, overlap={overlap}")
            num_chunks, all_json_data = await self.transcript_processor.process_transcript(
                text=text,
                model=model,
                model_name=model_name,
                chunk_size=chunk_size,
                overlap=overlap,
                custom_prompt=custom_prompt
            )
            logger.info(f"Successfully processed transcript into {num_chunks} chunks")

            return num_chunks, all_json_data
        except Exception as e:
            logger.error(f"Error processing transcript: {str(e)}", exc_info=True)
            raise

    def cleanup(self):
        """Cleanup resources"""
        try:
            logger.info("Cleaning up resources")
            if hasattr(self, 'transcript_processor'):
                self.transcript_processor.cleanup()
            logger.info("Cleanup completed successfully")
        except Exception as e:
            logger.error(f"Error during cleanup: {str(e)}", exc_info=True)

# Initialize processor
processor = SummaryProcessor()


# New meeting management endpoints
@app.get("/get-meetings", response_model=List[MeetingResponse])
async def get_meetings():
    """Get all meetings with their basic information"""
    try:
        meetings = await db.get_all_meetings()
        return [{"id": meeting["id"], "title": meeting["title"]} for meeting in meetings]
    except Exception as e:
        logger.error(f"Error getting meetings: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/get-meeting/{meeting_id}", response_model=MeetingDetailsResponse)
async def get_meeting(meeting_id: str):
    """Get a specific meeting by ID with all its details"""
    try:
        meeting = await db.get_meeting(meeting_id)
        if not meeting:
            raise HTTPException(status_code=404, detail="Meeting not found")
        return meeting
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting meeting: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/save-meeting-title")
async def save_meeting_title(data: MeetingTitleUpdate):
    """Save a meeting title"""
    try:
        await db.update_meeting_title(data.meeting_id, data.title)
        return {"message": "Meeting title saved successfully"}
    except Exception as e:
        logger.error(f"Error saving meeting title: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/delete-meeting")
async def delete_meeting(data: DeleteMeetingRequest):
    """Delete a meeting and all its associated data"""
    try:
        success = await db.delete_meeting(data.meeting_id)
        if success:
            return {"message": "Meeting deleted successfully"}
        else:
            raise HTTPException(status_code=500, detail="Failed to delete meeting")
    except Exception as e:
        logger.error(f"Error deleting meeting: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

async def process_transcript_background(process_id: str, transcript: TranscriptRequest, custom_prompt: str):
    """Background task to process transcript"""
    try:
        logger.info(f"Starting background processing for process_id: {process_id}")
        
        # Early validation for common issues
        if not transcript.text or not transcript.text.strip():
            raise ValueError("Empty transcript text provided")
        
        if transcript.model in ["claude", "groq", "openai"]:
            # Check if API key is available for cloud providers
            api_key = await processor.db.get_api_key(transcript.model)
            if not api_key:
                provider_names = {"claude": "Anthropic", "groq": "Groq", "openai": "OpenAI"}
                raise ValueError(f"{provider_names.get(transcript.model, transcript.model)} API key not configured. Please set your API key in the model settings.")

        _, all_json_data = await processor.process_transcript(
            text=transcript.text,
            model=transcript.model,
            model_name=transcript.model_name,
            chunk_size=transcript.chunk_size,
            overlap=transcript.overlap,
            custom_prompt=custom_prompt
        )

        # Create final summary structure by aggregating chunk results
        final_summary = {
            "MeetingName": "",
            "People": {"title": "People", "blocks": []},
            "SessionSummary": {"title": "Session Summary", "blocks": []},
            "CriticalDeadlines": {"title": "Critical Deadlines", "blocks": []},
            "KeyItemsDecisions": {"title": "Key Items & Decisions", "blocks": []},
            "ImmediateActionItems": {"title": "Immediate Action Items", "blocks": []},
            "NextSteps": {"title": "Next Steps", "blocks": []},
            # "OtherImportantPoints": {"title": "Other Important Points", "blocks": []},
            # "ClosingRemarks": {"title": "Closing Remarks", "blocks": []},
            "MeetingNotes": {
                "meeting_name": "",
                "sections": []
            }
        }

        # Process each chunk's data
        for json_str in all_json_data:
            try:
                json_dict = json.loads(json_str)
                if "MeetingName" in json_dict and json_dict["MeetingName"]:
                    final_summary["MeetingName"] = json_dict["MeetingName"]
                for key in final_summary:
                    if key == "MeetingNotes" and key in json_dict:
                        # Handle MeetingNotes sections
                        if isinstance(json_dict[key].get("sections"), list):
                            # Ensure each section has blocks array
                            for section in json_dict[key]["sections"]:
                                if not section.get("blocks"):
                                    section["blocks"] = []
                            final_summary[key]["sections"].extend(json_dict[key]["sections"])
                        if json_dict[key].get("meeting_name"):
                            final_summary[key]["meeting_name"] = json_dict[key]["meeting_name"]
                    elif key != "MeetingName" and key in json_dict and isinstance(json_dict[key], dict) and "blocks" in json_dict[key]:
                        if isinstance(json_dict[key]["blocks"], list):
                            final_summary[key]["blocks"].extend(json_dict[key]["blocks"])
                            # Also add as a new section in MeetingNotes if not already present
                            section_exists = False
                            for section in final_summary["MeetingNotes"]["sections"]:
                                if section["title"] == json_dict[key]["title"]:
                                    section["blocks"].extend(json_dict[key]["blocks"])
                                    section_exists = True
                                    break
                            
                            if not section_exists:
                                final_summary["MeetingNotes"]["sections"].append({
                                    "title": json_dict[key]["title"],
                                    "blocks": json_dict[key]["blocks"].copy() if json_dict[key]["blocks"] else []
                                })
            except json.JSONDecodeError as e:
                logger.error(f"Failed to parse JSON chunk for {process_id}: {e}. Chunk: {json_str[:100]}...")
            except Exception as e:
                logger.error(f"Error processing chunk data for {process_id}: {e}. Chunk: {json_str[:100]}...")

        # Update database with meeting name using meeting_id
        if final_summary["MeetingName"]:
            await processor.db.update_meeting_name(transcript.meeting_id, final_summary["MeetingName"])

        # Save final result
        if all_json_data:
            await processor.db.update_process(process_id, status="completed", result=json.dumps(final_summary))
            logger.info(f"Background processing completed for process_id: {process_id}")
        else:
            error_msg = "Summary generation failed: No chunks were processed successfully. Check logs for specific errors."
            await processor.db.update_process(process_id, status="failed", error=error_msg)
            logger.error(f"Background processing failed for process_id: {process_id} - {error_msg}")

    except ValueError as e:
        # Handle specific value errors (like API key issues)
        error_msg = str(e)
        logger.error(f"Configuration error in background processing for {process_id}: {error_msg}", exc_info=True)
        try:
            await processor.db.update_process(process_id, status="failed", error=error_msg)
        except Exception as db_e:
            logger.error(f"Failed to update DB status to failed for {process_id}: {db_e}", exc_info=True)
    except Exception as e:
        # Handle all other exceptions
        error_msg = f"Processing error: {str(e)}"
        logger.error(f"Error in background processing for {process_id}: {error_msg}", exc_info=True)
        try:
            await processor.db.update_process(process_id, status="failed", error=error_msg)
        except Exception as db_e:
            logger.error(f"Failed to update DB status to failed for {process_id}: {db_e}", exc_info=True)

@app.post("/process-transcript")
async def process_transcript_api(
    transcript: TranscriptRequest,
    background_tasks: BackgroundTasks
):
    """Process a transcript text with background processing"""
    try:
        # Create new process linked to meeting_id
        process_id = await processor.db.create_process(transcript.meeting_id)

        # Save transcript data associated with meeting_id
        await processor.db.save_transcript(
            transcript.meeting_id,
            transcript.text,
            transcript.model,
            transcript.model_name,
            transcript.chunk_size,
            transcript.overlap
        )

        custom_prompt = transcript.custom_prompt

        # Start background processing
        background_tasks.add_task(
            process_transcript_background,
            process_id,
            transcript,
            custom_prompt
        )

        return JSONResponse({
            "message": "Processing started",
            "process_id": process_id
        })

    except Exception as e:
        logger.error(f"Error in process_transcript_api: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/get-summary/{meeting_id}")
async def get_summary(meeting_id: str):
    """Get the summary for a given meeting ID"""
    try:
        result = await processor.db.get_transcript_data(meeting_id)
        if not result:
            return JSONResponse(
                status_code=404,
                content={
                    "status": "error",
                    "meetingName": None,
                    "meeting_id": meeting_id,
                    "data": None,
                    "start": None,
                    "end": None,
                    "error": "Meeting ID not found"
                }
            )

        status = result.get("status", "unknown").lower()
        logger.debug(f"Summary status for meeting {meeting_id}: {status}, error: {result.get('error')}")

        # Parse result data if available
        summary_data = None
        if result.get("result"):
            try:
                parsed_result = json.loads(result["result"])
                if isinstance(parsed_result, str):
                    summary_data = json.loads(parsed_result)
                else:
                    summary_data = parsed_result
                if not isinstance(summary_data, dict):
                    logger.error(f"Parsed summary data is not a dictionary for meeting {meeting_id}")
                    summary_data = None
            except json.JSONDecodeError as e:
                logger.error(f"Failed to parse JSON data for meeting {meeting_id}: {str(e)}")
                status = "failed"
                result["error"] = f"Invalid summary data format: {str(e)}"
            except Exception as e:
                logger.error(f"Unexpected error parsing summary data for {meeting_id}: {str(e)}")
                status = "failed"
                result["error"] = f"Error processing summary data: {str(e)}"

        # Transform summary data into frontend format if available - PRESERVE ORDER
        transformed_data = {}
        if isinstance(summary_data, dict) and status == "completed":
            # Add MeetingName to transformed data
            transformed_data["MeetingName"] = summary_data.get("MeetingName", "")

            # Map backend sections to frontend sections
            section_mapping = {
                # "SessionSummary": "key_points",
                # "ImmediateActionItems": "action_items",
                # "KeyItemsDecisions": "decisions",
                # "NextSteps": "next_steps",
                # "CriticalDeadlines": "critical_deadlines",
                # "People": "people"
            }

            # Add each section to transformed data
            for backend_key, frontend_key in section_mapping.items():
                if backend_key in summary_data and isinstance(summary_data[backend_key], dict):
                    transformed_data[frontend_key] = summary_data[backend_key]
            
            # Add meeting notes sections if available - PRESERVE ORDER AND HANDLE DUPLICATES
            if "MeetingNotes" in summary_data and isinstance(summary_data["MeetingNotes"], dict):
                meeting_notes = summary_data["MeetingNotes"]
                if isinstance(meeting_notes.get("sections"), list):
                    # Add section order array to maintain order
                    transformed_data["_section_order"] = []
                    used_keys = set()
                    
                    for index, section in enumerate(meeting_notes["sections"]):
                        if isinstance(section, dict) and "title" in section and "blocks" in section:
                            # Ensure blocks is a list to prevent frontend errors
                            if not isinstance(section.get("blocks"), list):
                                section["blocks"] = []
                                
                            # Convert title to snake_case key
                            base_key = section["title"].lower().replace(" & ", "_").replace(" ", "_")
                            
                            # Handle duplicate section names by adding index
                            key = base_key
                            if key in used_keys:
                                key = f"{base_key}_{index}"
                            
                            used_keys.add(key)
                            transformed_data[key] = section
                            # Only add to _section_order if the section was successfully added
                            transformed_data["_section_order"].append(key)

        response = {
            "status": "processing" if status in ["processing", "pending", "started"] else status,
            "meetingName": summary_data.get("MeetingName") if isinstance(summary_data, dict) else None,
            "meeting_id": meeting_id,
            "start": result.get("start_time"),
            "end": result.get("end_time"),
            "data": transformed_data if status == "completed" else None
        }

        if status == "failed":
            response["status"] = "error"
            response["error"] = result.get("error", "Unknown processing error")
            response["data"] = None
            response["meetingName"] = None
            logger.info(f"Returning failed status with error: {response['error']}")
            return JSONResponse(status_code=400, content=response)

        elif status in ["processing", "pending", "started"]:
            response["data"] = None
            return JSONResponse(status_code=202, content=response)

        elif status == "completed":
            if not summary_data:
                response["status"] = "error"
                response["error"] = "Completed but summary data is missing or invalid"
                response["data"] = None
                response["meetingName"] = None
                return JSONResponse(status_code=500, content=response)
            return JSONResponse(status_code=200, content=response)

        else:
            response["status"] = "error"
            response["error"] = f"Unknown or unexpected status: {status}"
            response["data"] = None
            response["meetingName"] = None
            return JSONResponse(status_code=500, content=response)

    except Exception as e:
        logger.error(f"Error getting summary for {meeting_id}: {str(e)}", exc_info=True)
        return JSONResponse(
            status_code=500,
            content={
                "status": "error",
                "meetingName": None,
                "meeting_id": meeting_id,
                "data": None,
                "start": None,
                "end": None,
                "error": f"Internal server error: {str(e)}"
            }
        )

@app.post("/save-transcript")
async def save_transcript(request: SaveTranscriptRequest):
    """Save transcript segments for a meeting without processing"""
    try:
        logger.info(f"Received save-transcript request for meeting: {request.meeting_title}")
        logger.info(f"Number of transcripts to save: {len(request.transcripts)}")

        # Log first transcript timestamps for debugging
        if request.transcripts:
            first = request.transcripts[0]
            logger.debug(f"First transcript: audio_start_time={first.audio_start_time}, audio_end_time={first.audio_end_time}, duration={first.duration}")

        # Use pre-generated UUID from Rust (preserves attachment linkage) or fall back to timestamp ID
        meeting_id = request.meeting_id or f"meeting-{int(time.time() * 1000)}"
        logger.info(f"[main.py - save_transcript()] - Using meeting_id: {meeting_id} (from_rust={request.meeting_id is not None})")

        # Save the meeting with folder path (if provided)
        await db.save_meeting(meeting_id, request.meeting_title, folder_path=request.folder_path)

        # Save each transcript segment with NEW timestamp fields for playback sync
        for transcript in request.transcripts:
            await db.save_meeting_transcript(
                meeting_id=meeting_id,
                transcript=transcript.text,
                timestamp=transcript.timestamp,
                summary="",
                action_items="",
                key_points="",
                # NEW: Recording-relative timestamps for audio-transcript synchronization
                audio_start_time=transcript.audio_start_time,
                audio_end_time=transcript.audio_end_time,
                duration=transcript.duration
            )

        logger.info("Transcripts saved successfully")
        return {"status": "success", "message": "Transcript saved successfully", "meeting_id": meeting_id}
    except Exception as e:
        logger.error(f"Error saving transcript: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/get-model-config")
async def get_model_config():
    """Get the current model configuration"""
    model_config = await db.get_model_config()
    if model_config:
        api_key = await db.get_api_key(model_config["provider"])
        if api_key != None:
            model_config["apiKey"] = api_key
    return model_config

@app.post("/save-model-config")
async def save_model_config(request: SaveModelConfigRequest):
    """Save the model configuration"""
    await db.save_model_config(request.provider, request.model, request.whisperModel)
    if request.apiKey != None:
        await db.save_api_key(request.apiKey, request.provider)
    return {"status": "success", "message": "Model configuration saved successfully"}  

@app.get("/get-transcript-config")
async def get_transcript_config():
    """Get the current transcript configuration"""
    transcript_config = await db.get_transcript_config()
    if transcript_config:
        transcript_api_key = await db.get_transcript_api_key(transcript_config["provider"])
        if transcript_api_key != None:
            transcript_config["apiKey"] = transcript_api_key
    return transcript_config

@app.post("/save-transcript-config")
async def save_transcript_config(request: SaveTranscriptConfigRequest):
    """Save the transcript configuration"""
    await db.save_transcript_config(request.provider, request.model)
    if request.apiKey != None:
        await db.save_transcript_api_key(request.apiKey, request.provider)
    return {"status": "success", "message": "Transcript configuration saved successfully"}

class GetApiKeyRequest(BaseModel):
    provider: str

@app.post("/get-api-key")
async def get_api_key(request: GetApiKeyRequest):
    try:
        return await db.get_api_key(request.provider)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/get-transcript-api-key")
async def get_transcript_api_key(request: GetApiKeyRequest):
    try:
        return await db.get_transcript_api_key(request.provider)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

class MeetingSummaryUpdate(BaseModel):
    meeting_id: str
    summary: dict

@app.post("/save-meeting-summary")
async def save_meeting_summary(data: MeetingSummaryUpdate):
    """Save a meeting summary"""
    try:
        await db.update_meeting_summary(data.meeting_id, data.summary)
        return {"message": "Meeting summary saved successfully"}
    except ValueError as ve:
        logger.error(f"Value error saving meeting summary: {str(ve)}")
        raise HTTPException(status_code=404, detail=str(ve))
    except Exception as e:
        logger.error(f"Error saving meeting summary: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

class SearchRequest(BaseModel):
    query: str

class RecallBriefResponse(BaseModel):
    event_id: str
    event_title: str
    attendees_json: str
    brief_text: str
    created_at: str
    triggered_at: str

class UpcomingRecallBrief(BaseModel):
    event_id: str
    event_title: str
    attendees_json: str
    brief_text: str
    triggered_at: str

class UpcomingRecallResponse(BaseModel):
    briefs: List[UpcomingRecallBrief]
    recall_enabled: bool

class RecallSettingsRequest(BaseModel):
    recall_enabled: bool

class AttachmentCreate(BaseModel):
    attachment_id: str
    timestamp: float
    file_path: str
    image_hash: str

class AttachmentResponse(BaseModel):
    id: str
    meeting_id: str
    timestamp: float
    file_path: str
    created_at: str

@app.post("/search-transcripts")
async def search_transcripts(request: SearchRequest):
    """Search through meeting transcripts for the given query"""
    try:
        results = await db.search_transcripts(request.query)
        return JSONResponse(content=results)
    except Exception as e:
        logger.error(f"Error searching transcripts: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

def _get_enabled_features(settings: dict) -> list:
    """Return list of enabled feature names from a settings dict."""
    features = []
    if settings.get("copilotEnabled"):
        features.append("genie_live")
    if settings.get("calendarConnected"):
        features.append("calendar")
    if settings.get("recall_enabled"):
        features.append("recall")
    return features


@app.on_event("startup")
async def startup_event():
    """Initialize calendar, recall, and co-pilot modules on startup."""
    global _telemetry
    import asyncio, os
    from recall import recall_polling_loop
    init_calendar(db)
    asyncio.create_task(calendar_polling_loop(db))
    asyncio.create_task(recall_polling_loop(db))
    # Crash recovery — clear stale state
    from genie_live_agent import stop_scheduler as _gl_stop
    _gl_stop("startup")
    # Cleanup old state
    asyncio.create_task(cleanup_old_state(db))
    logger.info("Calendar, recall, and co-pilot modules initialized")

    # --- Telemetry startup ---
    try:
        install_id = await db.get_or_create_install_id()
        tel_settings = await db.get_telemetry_settings()
        _telemetry = TelemetryWriter(
            telemetry_path=tel_settings.get("telemetryPath") or "",
            install_id=install_id,
            app_version=get_app_version(),
        )
        if tel_settings.get("telemetryPath") and tel_settings.get("telemetryEnabled"):
            _telemetry.enabled = _telemetry.initialise()
        app.state.telemetry = _telemetry
        copilot_settings = await db.get_copilot_settings()
        await _telemetry.capture("backend_started", {
            "features_enabled": _get_enabled_features(copilot_settings),
        })
    except Exception as _te:
        logger.debug(f"Telemetry startup: {_te}")


@app.post("/api/recall/brief/{event_id}/dismiss")
async def dismiss_recall_brief(event_id: str):
    """Record that the user dismissed a pre-meeting brief."""
    await _telemetry.capture("recall_brief_dismissed")
    return {"status": "ok"}


@app.get("/api/recall/brief/{event_id}", response_model=RecallBriefResponse)
async def get_recall_brief(event_id: str):
    """Get the pre-meeting brief for a specific calendar event."""
    brief = await db.get_recall_brief(event_id)
    if not brief:
        raise HTTPException(status_code=404, detail="Brief not found")
    return brief


@app.get("/api/recall/upcoming", response_model=UpcomingRecallResponse)
async def get_upcoming_recall():
    """Get upcoming recall briefs and recall enabled status."""
    briefs = await db.get_upcoming_recall_briefs(hours_ahead=2)
    recall_enabled = await db.get_recall_enabled()
    return {"briefs": briefs, "recall_enabled": recall_enabled}


@app.post("/api/recall/settings")
async def save_recall_settings(request: RecallSettingsRequest):
    """Enable or disable the pre-meeting recall feature."""
    await db.set_recall_enabled(request.recall_enabled)
    return {"status": "success"}


@app.post("/api/live-transcript", status_code=201)
async def live_transcript(request: dict):
    """Receive a single transcript segment streamed from the frontend during recording.

    Saves directly to the transcripts table so the co-pilot can analyse it in real-time.
    Silently ignores duplicates (same meeting_id + timestamp).
    """
    try:
        meeting_id = request.get("meeting_id", "")
        transcript = request.get("transcript", "")
        from datetime import datetime as _dt
        # Always use server UTC time as a full ISO datetime so get_recent_transcripts
        # comparisons work correctly. Client timestamps may be HH:MM:SS only.
        timestamp = _dt.utcnow().isoformat()
        if not meeting_id or not transcript:
            return {"status": "skipped"}
        await db.save_meeting_transcript(
            meeting_id=meeting_id,
            transcript=transcript,
            timestamp=timestamp,
        )
        return {"status": "ok"}
    except Exception as e:
        # Fire-and-forget from frontend — never raise, just log
        logger.debug(f"live_transcript: {e}")
        return {"status": "error"}


@app.post("/api/meetings/{meeting_id}/attachments", status_code=201)
async def create_attachment(meeting_id: str, request: AttachmentCreate):
    """Save a clipboard screenshot attachment for a meeting."""
    try:
        logger.info(f"[main.py - create_attachment()] - Saving attachment {request.attachment_id} for meeting {meeting_id}")
        # No pre-existence check: SQLite does not enforce FKs by default, and the meeting
        # record is only created at recording stop. Attachments are captured during recording
        # and linked by UUID; they will be consistent once /save-transcript completes.
        await db.add_attachment(
            attachment_id=request.attachment_id,
            meeting_id=meeting_id,
            timestamp=request.timestamp,
            file_path=request.file_path,
            image_hash=request.image_hash,
        )
        await _telemetry.capture("screenshot_captured")
        from datetime import datetime as _dt
        return JSONResponse(status_code=201, content={
            "id": request.attachment_id, "meeting_id": meeting_id,
            "timestamp": request.timestamp, "file_path": request.file_path,
            "created_at": _dt.utcnow().isoformat(),
        })
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error saving attachment: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/meetings/{meeting_id}/attachments")
async def get_attachments(meeting_id: str):
    """Get all attachments for a meeting ordered by timestamp."""
    try:
        rows = await db.get_attachments(meeting_id)
        return JSONResponse(content=rows)
    except Exception as e:
        logger.error(f"Error fetching attachments: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/meetings/{meeting_id}/attachments/{attachment_id}")
async def delete_attachment(meeting_id: str, attachment_id: str):
    """Delete a single attachment."""
    try:
        deleted = await db.delete_attachment(attachment_id)
        if not deleted:
            raise HTTPException(status_code=404, detail=f"Attachment {attachment_id} not found")
        await _telemetry.capture("screenshot_dismissed")
        return JSONResponse(content={"message": "Attachment deleted successfully"})
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting attachment: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/copilot/hints/{meeting_id}")
async def get_copilot_hints(meeting_id: str):
    """Get all copilot hints for a meeting"""
    hints = await db.get_copilot_hints(meeting_id)
    return {"hints": hints}


@app.post("/api/copilot/recording-signal")
async def copilot_recording_signal(signal: CopilotRecordingSignal):
    """Signal recording start or stop. On start, initialise Genie Live credentials."""
    settings = await db.get_copilot_settings()
    if signal.action == "start" and signal.meeting_id:
        workspace_host = settings.get('databricksWorkspaceHost', '')
        cli_profile = settings.get('databricksCliProfile', 'DEFAULT')
        knowledge_store_path = settings.get('knowledgeStorePath', '')
        init_genie_live(workspace_host, cli_profile, settings, knowledge_store_path=knowledge_store_path)
        await _telemetry.capture("recording_started")
    else:
        stop_scheduler(signal.meeting_id)
        await _telemetry.capture("recording_stopped")
    return {"status": "ok"}


@app.post("/api/genie-live/analyze")
async def genie_live_analyze(request: dict, background_tasks: BackgroundTasks):
    """
    Frontend-driven Genie Live cycle endpoint.

    Body: {meeting_id, transcript_chunk, user_notes?: string[]}
    Returns: {hint_id, skipped, reason}
    """
    from genie_live_agent import run_genie_live_cycle, init_genie_live, _genie_available

    meeting_id = request.get("meeting_id", "")
    transcript_chunk = request.get("transcript_chunk", "")
    user_notes: List[str] = request.get("user_notes") or []

    if not meeting_id:
        return {"skipped": True, "reason": "no meeting_id"}

    settings = await db.get_copilot_settings()

    # Auto-initialize Genie if not already available (guards against backend restart
    # happening between app launch and the first recording-signal reaching the backend)
    if not _genie_available:
        workspace_host = settings.get('databricksWorkspaceHost', '')
        cli_profile = settings.get('databricksCliProfile', 'DEFAULT')
        knowledge_store_path = settings.get('knowledgeStorePath', '')
        if workspace_host:
            logger.info(f"[genie_live] auto-init on analyze call (backend may have restarted)")
            init_genie_live(workspace_host, cli_profile, settings, knowledge_store_path=knowledge_store_path)

    async def _run():
        try:
            await run_genie_live_cycle(meeting_id, db, transcript_chunk, user_notes=user_notes)
        except Exception as e:
            logger.error(f"[genie_live] analyze cycle failed: {e}", exc_info=True)

    background_tasks.add_task(_run)
    note_count = len(user_notes)
    logger.info(f"[genie_live] analyze task fired for {meeting_id} ({len(transcript_chunk.split())} words, {note_count} user notes)")
    return {"skipped": False, "reason": "cycle started"}


@app.post("/api/meetings/{meeting_id}/notes")
async def save_meeting_note(meeting_id: str, request: dict):
    """Persist a user note for a meeting. Called fire-and-forget from the frontend."""
    text = (request.get("text") or "").strip()
    if not text:
        return {"saved": False, "reason": "empty text"}
    note_id = request.get("id") or f"note-{int(time.time()*1000)}"
    wall_clock_time = request.get("wallClockTime") or ""
    try:
        await db.save_meeting_note(meeting_id, note_id, text, wall_clock_time)
        return {"saved": True, "id": note_id}
    except Exception as e:
        logger.warning(f"[notes] save failed: {e}")
        return {"saved": False, "reason": str(e)}


@app.get("/api/meetings/{meeting_id}/genie-chat")
async def get_meeting_genie_chat(meeting_id: str):
    """Return all meeting-level Genie chat messages."""
    try:
        messages = await db.get_meeting_chat_messages(meeting_id)
        return {"messages": messages}
    except Exception as e:
        logger.warning(f"[genie_chat] get failed: {e}")
        return {"messages": []}


@app.post("/api/meetings/{meeting_id}/genie-chat")
async def post_meeting_genie_chat(
    meeting_id: str,
    request: dict,
    background_tasks: BackgroundTasks,
):
    """
    Fire-and-return: saves user message, schedules Genie in a FastAPI BackgroundTask,
    returns {status:"pending"} immediately.  Frontend polls GET /genie-chat every 3s
    until a new 'genie' or 'error' message appears.
    """
    import uuid as _uuid
    from genie_live_agent import ask_genie_followup, _ensure_genie_available

    question = (request.get("question") or "").strip()
    if not question:
        raise HTTPException(status_code=400, detail="question required")

    user_msg_id = str(_uuid.uuid4())
    try:
        await db.save_meeting_chat_message(meeting_id, user_msg_id, "user", question)
    except Exception as e:
        logger.error(f"[genie_chat] failed to save user message: {e}", exc_info=True)
        return {"status": "error", "user_message_id": None, "detail": str(e)}

    async def _run_genie_bg():
        """Runs after the HTTP response is sent."""
        try:
            await _ensure_genie_available(db)

            hints = await db.get_copilot_hints(meeting_id)
            conv_id = None
            for h in reversed(hints):
                if h.get("genie_conversation_id"):
                    conv_id = h["genie_conversation_id"]
                    break

            answer, _, status = await ask_genie_followup(question, conv_id)
            logger.info(f"[genie_chat] Genie status={status} has_answer={bool(answer)}")

            if answer:
                await db.save_meeting_chat_message(
                    meeting_id, str(_uuid.uuid4()), "genie", answer
                )
            else:
                await db.save_meeting_chat_message(
                    meeting_id, str(_uuid.uuid4()), "error", f"__status:{status}__"
                )
        except Exception as e:
            logger.error(f"[genie_chat] background task error: {e}", exc_info=True)
            try:
                await db.save_meeting_chat_message(
                    meeting_id, str(_uuid.uuid4()), "error", f"__status:error__ {e}"
                )
            except Exception:
                pass

    background_tasks.add_task(_run_genie_bg)
    return {"status": "pending", "user_message_id": user_msg_id}


@app.get("/api/meetings/{meeting_id}/notes")
async def get_meeting_notes(meeting_id: str):
    """Return all user notes for a meeting, ordered by creation time."""
    try:
        notes = await db.get_meeting_notes(meeting_id)
        return {"notes": notes}
    except Exception as e:
        logger.warning(f"[notes] fetch failed: {e}")
        return {"notes": []}


@app.get("/api/copilot/genie-status")
async def get_genie_status_endpoint():
    """Check Genie MCP availability. Cached 60 seconds."""
    from genie_live_agent import get_genie_status as _get_status
    settings = await db.get_copilot_settings()
    workspace_host = settings.get('databricksWorkspaceHost', '')
    cli_profile = settings.get('databricksCliProfile', 'DEFAULT')
    return await _get_status(workspace_host, cli_profile)


@app.get("/api/copilot/settings")
async def get_copilot_settings():
    """Get copilot settings (API keys excluded)"""
    settings = await db.get_copilot_settings()
    safe = {k: v for k, v in settings.items() if 'ApiKey' not in k and 'api_key' not in k}
    return safe


@app.post("/api/copilot/settings")
async def save_copilot_settings(request: SaveCopilotSettingsRequest):
    """Save copilot settings"""
    await db.save_copilot_settings(
        request.databricksWorkspaceHost,
        request.databricksCliProfile,
        request.copilotEnabled,
        request.copilotIntervalMinutes,
        request.knowledgeStorePath,
    )
    return {"status": "success"}


# ---------------------------------------------------------------------------
# Telemetry endpoints
# ---------------------------------------------------------------------------

class TelemetrySettingsRequest(BaseModel):
    telemetryEnabled: bool = True
    telemetryPath: str = ""
    telemetryConsentShown: bool = False


@app.get("/api/telemetry/settings")
async def get_telemetry_settings():
    """Return current telemetry settings including consent state and install ID."""
    return await db.get_telemetry_settings()


@app.post("/api/telemetry/settings")
async def save_telemetry_settings(request: TelemetrySettingsRequest):
    """Persist telemetry settings and reconfigure the writer."""
    global _telemetry
    await db.save_telemetry_settings(
        request.telemetryEnabled,
        request.telemetryPath,
        request.telemetryConsentShown,
    )
    # Reconfigure the live telemetry writer
    if request.telemetryPath and request.telemetryEnabled:
        install_id = await db.get_or_create_install_id()
        _telemetry = TelemetryWriter(
            telemetry_path=request.telemetryPath,
            install_id=install_id,
            app_version=get_app_version(),
        )
        _telemetry.enabled = _telemetry.initialise()
    else:
        _telemetry.enabled = False
    app.state.telemetry = _telemetry
    copilot_settings = await db.get_copilot_settings()
    await _telemetry.capture("settings_saved", {
        "features_enabled": _get_enabled_features(copilot_settings),
    })
    return {"status": "ok"}


@app.get("/api/telemetry/recent")
async def get_recent_telemetry():
    """Return last 10 events for the debug panel. Shows users exactly what is collected."""
    install_id = await db.get_or_create_install_id()
    return {
        "events": _telemetry.get_recent_events(10),
        "install_id": install_id,
        "enabled": _telemetry.enabled,
    }


@app.post("/api/telemetry/app-opened")
async def telemetry_app_opened():
    """Called from the frontend on each app open."""
    copilot_settings = await db.get_copilot_settings()
    await _telemetry.capture("app_opened", {
        "features_enabled": _get_enabled_features(copilot_settings),
    })
    return {"status": "ok"}


# ── Knowledge Store ────────────────────────────────────────────────────────────

def _get_kb_base() -> Path:
    """Return the active KB base path (from genie_live_agent, or auto-detected)."""
    from genie_live_agent import KB_BASE
    return KB_BASE


@app.get("/api/knowledge-store/files")
async def list_kb_files():
    """Return the KB file tree. File I/O is run in a thread to avoid blocking the event loop."""
    import asyncio

    def _list_sync():
        kb = _get_kb_base()
        if not kb.exists():
            return {"files": [], "base": str(kb)}
        files = []
        for p in sorted(kb.rglob("*.md")):
            try:
                rel = p.relative_to(kb)
            except ValueError:
                continue
            parts = rel.parts
            folder = str(parts[0]) if len(parts) > 1 else ""
            files.append({"path": str(rel), "folder": folder, "name": p.stem})
        return {"files": files, "base": str(kb)}

    return await asyncio.to_thread(_list_sync)


@app.get("/api/knowledge-store/file")
async def read_kb_file(path: str):
    """Read the content of a KB file. path is relative to KB_BASE."""
    import asyncio

    def _read_sync():
        kb = _get_kb_base()
        target = (kb / path).resolve()
        if not str(target).startswith(str(kb.resolve())):
            return None, "invalid"
        if not target.exists():
            return None, "missing"
        return target.read_text(encoding="utf-8"), "ok"

    content, status = await asyncio.to_thread(_read_sync)
    if status == "invalid":
        raise HTTPException(status_code=400, detail="Invalid path")
    if status == "missing":
        raise HTTPException(status_code=404, detail="File not found")
    return {"content": content, "path": path}


class KbWriteRequest(BaseModel):
    path: str
    content: str


@app.post("/api/knowledge-store/file", status_code=201)
async def write_kb_file(request: KbWriteRequest):
    """Create or overwrite a KB file. path is relative to KB_BASE."""
    import asyncio

    def _write_sync():
        kb = _get_kb_base()
        target = (kb / request.path).resolve()
        if not str(target).startswith(str(kb.resolve())):
            return "invalid"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(request.content, encoding="utf-8")
        return "ok"

    status = await asyncio.to_thread(_write_sync)
    if status == "invalid":
        raise HTTPException(status_code=400, detail="Invalid path")
    return {"status": "ok", "path": request.path}


@app.delete("/api/knowledge-store/file")
async def delete_kb_file(path: str):
    """Delete a KB file. path is relative to KB_BASE."""
    import asyncio

    def _delete_sync():
        kb = _get_kb_base()
        target = (kb / path).resolve()
        if not str(target).startswith(str(kb.resolve())):
            return "invalid"
        if not target.exists():
            return "missing"
        target.unlink()
        return "ok"

    status = await asyncio.to_thread(_delete_sync)
    if status == "invalid":
        raise HTTPException(status_code=400, detail="Invalid path")
    if status == "missing":
        raise HTTPException(status_code=404, detail="File not found")
    return {"status": "ok"}


@app.post("/api/knowledge-store/context")
async def get_kb_context(request: dict):
    """
    Return KB context for AI summary generation.

    Implements the loader-instructions.md protocol:
    - Always includes key-contacts.md + databricks-sa-context.md (Rule 0)
    - Tier-priority keyword matching from index.md for up to 2 additional files (Rule 1/2)

    This is richer than the live Genie cycle loader: it reads the authoritative
    keyword table from index.md rather than scoring by file-path words, so it
    correctly resolves compound triggers like "Shobie" → customers/gsk.md.
    """
    import asyncio

    def _context_sync():
        try:
            from genie_live_agent import _load_kb_for_summary
            transcript = request.get("transcript", "")
            if not transcript:
                return {"context": "", "files_used": []}
            context_text, loaded_files = _load_kb_for_summary(transcript)
            return {
                "context": context_text.strip(),
                "files_used": loaded_files,
            }
        except Exception as e:
            logger.warning(f"KB context fetch failed (non-fatal): {e}")
            return {"context": "", "files_used": []}

    return await asyncio.to_thread(_context_sync)


@app.on_event("shutdown")
async def shutdown_event():
    """Cleanup on API shutdown"""
    logger.info("API shutting down, cleaning up resources")
    try:
        processor.cleanup()
        logger.info("Successfully cleaned up resources")
    except Exception as e:
        logger.error(f"Error during cleanup: {str(e)}", exc_info=True)

if __name__ == "__main__":
    import multiprocessing
    multiprocessing.freeze_support()
    uvicorn.run("main:app", host="0.0.0.0", port=5167, reload=True)
