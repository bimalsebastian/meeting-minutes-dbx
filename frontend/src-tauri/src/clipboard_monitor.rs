// clipboard_monitor.rs
//
// Polls the Mac clipboard every 2 seconds for new image content during recording.
// When a new image is detected: saves it as a PNG file in the meeting folder,
// records the file path via the backend REST API, and emits a Tauri event.

use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;
use tauri::Emitter;
use tokio_util::sync::CancellationToken;

// ============================================================================
// GLOBAL STATE
// ============================================================================

/// Cancellation token for stopping the monitor loop
static MONITOR_CANCEL: Mutex<Option<CancellationToken>> = Mutex::new(None);

/// Pre-generated UUID for the current recording session
static ACTIVE_MEETING_ID: Mutex<Option<String>> = Mutex::new(None);

/// Recent image hashes with timestamps for deduplication (purge entries older than 10s)
static RECENT_HASHES: Mutex<Option<VecDeque<(String, Instant)>>> = Mutex::new(None);

/// Folder where PNG files are saved for the current recording
static MEETING_FOLDER: Mutex<Option<PathBuf>> = Mutex::new(None);

// ============================================================================
// PUBLIC API
// ============================================================================

/// Read the current clipboard image (if any) and return its SHA-256 hash.
/// Returns None if the clipboard is empty or contains non-image data.
/// Used to pre-seed the dedup hash set so pre-existing images are never captured.
fn snapshot_clipboard_hash() -> Option<String> {
    let mut clipboard = arboard::Clipboard::new().ok()?;
    let image = clipboard.get_image().ok()?;
    let png_bytes = rgba_to_png(
        image.bytes.as_ref(),
        image.width as u32,
        image.height as u32,
    ).ok()?;
    Some(format!("{:x}", Sha256::digest(&png_bytes)))
}

/// Start the clipboard monitor for a new recording session.
/// Cancels any previously running monitor first.
pub fn start_monitor<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    meeting_id: String,
    meeting_folder: PathBuf,
) {
    // Cancel any previous session
    stop_monitor();

    // Store meeting metadata
    {
        let mut id_guard = ACTIVE_MEETING_ID.lock().unwrap();
        *id_guard = Some(meeting_id.clone());
    }
    {
        let mut folder_guard = MEETING_FOLDER.lock().unwrap();
        *folder_guard = Some(meeting_folder.clone());
    }
    {
        // Pre-seed the hash set with whatever is currently in the clipboard.
        // This ensures any image that was already copied *before* recording started
        // is treated as "already seen" and never captured into this session.
        let mut initial: VecDeque<(String, Instant)> = VecDeque::new();
        if let Some(hash) = snapshot_clipboard_hash() {
            log::debug!("Clipboard monitor: pre-seeding hash {} (pre-existing clipboard image will be ignored)", &hash[..8]);
            initial.push_back((hash, Instant::now()));
        }
        let mut hashes_guard = RECENT_HASHES.lock().unwrap();
        *hashes_guard = Some(initial);
    }

    // Create a new cancellation token and store it
    let token = CancellationToken::new();
    {
        let mut cancel_guard = MONITOR_CANCEL.lock().unwrap();
        *cancel_guard = Some(token.clone());
    }

    log::info!(
        "Starting clipboard monitor for meeting: {} in folder: {:?}",
        meeting_id,
        meeting_folder
    );

    // Spawn the polling loop
    tauri::async_runtime::spawn(async move {
        clipboard_poll_loop(app, token).await;
    });
}

/// Stop the clipboard monitor by cancelling the current token.
pub fn stop_monitor() {
    let token = {
        let mut cancel_guard = MONITOR_CANCEL.lock().unwrap();
        cancel_guard.take()
    };

    if let Some(token) = token {
        log::info!("Stopping clipboard monitor");
        token.cancel();
    }
}

/// Return the absolute paths of all PNG files saved for a given meeting UUID.
/// Used by the frontend AttachmentsPanel as a fallback when the Python backend is not running.
pub fn list_meeting_pngs(meeting_id: &str) -> Vec<String> {
    let folder = crate::audio::recording_preferences::get_default_recordings_folder()
        .join(meeting_id);

    match std::fs::read_dir(&folder) {
        Ok(entries) => entries
            .flatten()
            .filter_map(|e| {
                let path = e.path();
                if path.extension().and_then(|s| s.to_str()) == Some("png") {
                    path.to_str().map(|s| s.to_owned())
                } else {
                    None
                }
            })
            .collect(),
        Err(_) => vec![],
    }
}

// ============================================================================
// INTERNAL IMPLEMENTATION
// ============================================================================

async fn clipboard_poll_loop<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    cancel: CancellationToken,
) {
    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                log::info!("Clipboard monitor cancelled");
                break;
            }
            _ = tokio::time::sleep(std::time::Duration::from_secs(2)) => {
                if let Err(e) = check_clipboard_for_image(&app).await {
                    log::debug!("Clipboard check error: {}", e);
                }
            }
        }
    }
}

async fn check_clipboard_for_image<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> anyhow::Result<()> {
    // Read clipboard image on a blocking thread (required on macOS for arboard)
    let image_result = tokio::task::spawn_blocking(|| {
        let mut clipboard = arboard::Clipboard::new()?;
        clipboard.get_image()
    })
    .await??;

    // Convert RGBA image data to PNG bytes
    let png_bytes = rgba_to_png(
        image_result.bytes.as_ref(),
        image_result.width as u32,
        image_result.height as u32,
    )?;

    // Compute SHA-256 hash for deduplication
    let hash = format!("{:x}", Sha256::digest(&png_bytes));

    // Check RECENT_HASHES — deduplicate for the entire session (no expiry)
    {
        let mut hashes_guard = RECENT_HASHES.lock().unwrap();
        let hashes = hashes_guard.get_or_insert_with(VecDeque::new);

        // Skip if this exact image was seen at any point during this recording session
        if hashes.iter().any(|(h, _)| h == &hash) {
            return Ok(());
        }

        // Record this hash (kept for the full session — cleared on start_monitor)
        hashes.push_back((hash.clone(), Instant::now()));
    }

    // Determine meeting folder
    let meeting_folder = {
        let folder_guard = MEETING_FOLDER.lock().unwrap();
        match folder_guard.as_ref() {
            Some(p) => p.clone(),
            None => {
                log::debug!("No meeting folder set, skipping clipboard attachment");
                return Ok(());
            }
        }
    };

    // Get meeting id
    let meeting_id = {
        let id_guard = ACTIVE_MEETING_ID.lock().unwrap();
        match id_guard.as_ref() {
            Some(id) => id.clone(),
            None => {
                log::debug!("No active meeting ID, skipping clipboard attachment");
                return Ok(());
            }
        }
    };

    // Generate a unique filename
    let attachment_id = uuid::Uuid::new_v4().to_string();
    let filename = format!("{}.png", attachment_id);
    let file_path = meeting_folder.join(&filename);

    // Write PNG file to disk
    std::fs::write(&file_path, &png_bytes)?;

    log::info!(
        "Saved clipboard screenshot: {:?} for meeting: {}",
        file_path,
        meeting_id
    );

    // Get current recording position
    let timestamp = crate::audio::recording_commands::get_current_recording_duration();

    // POST to backend
    let file_path_str = file_path.to_string_lossy().to_string();
    let created_at = chrono::Utc::now().to_rfc3339();

    let url = format!(
        "http://localhost:5167/api/meetings/{}/attachments",
        meeting_id
    );

    let body = serde_json::json!({
        "attachment_id": attachment_id,
        "timestamp": timestamp,
        "file_path": file_path_str,
        "image_hash": hash,
    });

    // Fire-and-forget POST — log errors but don't fail
    match reqwest::Client::new()
        .post(&url)
        .json(&body)
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            log::debug!("Backend attachment saved successfully");
        }
        Ok(resp) => {
            log::debug!("Backend attachment POST returned status: {}", resp.status());
        }
        Err(e) => {
            log::debug!("Backend attachment POST failed: {}", e);
        }
    }

    // Emit Tauri event so the frontend can update in real time
    #[derive(Clone, serde::Serialize)]
    struct AttachmentCaptured {
        attachment_id: String,
        meeting_id: String,
        timestamp: f64,
        file_path: String,
        created_at: String,
    }

    app.emit(
        "attachment-captured",
        AttachmentCaptured {
            attachment_id,
            meeting_id,
            timestamp,
            file_path: file_path_str,
            created_at,
        },
    )?;

    Ok(())
}

// ============================================================================
// PNG ENCODING HELPER (minimal, no extra crate needed)
// ============================================================================

/// Encode raw RGBA bytes into a valid PNG file using a minimal hand-rolled encoder.
/// Uses zlib deflate via the flate2/miniz_oxide path that is already pulled in
/// transitively, or falls back to uncompressed IDAT if not available.
/// For simplicity and to avoid pulling in the full `image` crate we use the
/// `png` encoding algorithm manually with just `std`.
fn rgba_to_png(rgba: &[u8], width: u32, height: u32) -> anyhow::Result<Vec<u8>> {
    // We implement a minimal PNG encoder (no external crate).
    // PNG spec: signature + IHDR + IDAT(zlib-deflated filtered rows) + IEND

    // --- helpers ---
    fn crc32(data: &[u8]) -> u32 {
        // CRC-32 as required by PNG
        let mut crc: u32 = 0xFFFF_FFFF;
        for &byte in data {
            crc ^= u32::from(byte);
            for _ in 0..8 {
                if crc & 1 != 0 {
                    crc = (crc >> 1) ^ 0xEDB8_8320;
                } else {
                    crc >>= 1;
                }
            }
        }
        !crc
    }

    fn write_chunk(out: &mut Vec<u8>, chunk_type: &[u8; 4], data: &[u8]) {
        let len = data.len() as u32;
        out.extend_from_slice(&len.to_be_bytes());
        out.extend_from_slice(chunk_type);
        out.extend_from_slice(data);
        let mut crc_data = Vec::with_capacity(4 + data.len());
        crc_data.extend_from_slice(chunk_type);
        crc_data.extend_from_slice(data);
        out.extend_from_slice(&crc32(&crc_data).to_be_bytes());
    }

    // adler32 for zlib
    fn adler32(data: &[u8]) -> u32 {
        let (mut s1, mut s2) = (1u32, 0u32);
        for &b in data {
            s1 = (s1 + u32::from(b)) % 65521;
            s2 = (s2 + s1) % 65521;
        }
        (s2 << 16) | s1
    }

    let bytes_per_pixel: usize = 4; // RGBA
    let stride = width as usize * bytes_per_pixel;

    // Build filtered scanlines (filter type 0 = None for each row)
    let mut filtered: Vec<u8> = Vec::with_capacity((1 + stride) * height as usize);
    for row in 0..height as usize {
        filtered.push(0u8); // filter type: None
        filtered.extend_from_slice(&rgba[row * stride..(row + 1) * stride]);
    }

    // Compress filtered rows using a simple store-only deflate (no compression)
    // zlib header: 0x78 0x01 (deflate, no compression level)
    // Store blocks: BFINAL=1, BTYPE=00 (no compression)
    let mut zlib_data: Vec<u8> = Vec::new();
    zlib_data.push(0x78);
    zlib_data.push(0x01);

    // Write uncompressed deflate blocks (max 65535 bytes each)
    let max_block: usize = 65535;
    let total = filtered.len();
    let mut offset = 0usize;
    while offset < total {
        let end = std::cmp::min(offset + max_block, total);
        let block = &filtered[offset..end];
        let bfinal: u8 = if end == total { 1 } else { 0 };
        zlib_data.push(bfinal); // BFINAL | BTYPE=00
        let len = block.len() as u16;
        let nlen = !len;
        zlib_data.extend_from_slice(&len.to_le_bytes());
        zlib_data.extend_from_slice(&nlen.to_le_bytes());
        zlib_data.extend_from_slice(block);
        offset = end;
    }

    // Append Adler-32 checksum (big-endian)
    zlib_data.extend_from_slice(&adler32(&filtered).to_be_bytes());

    let mut out: Vec<u8> = Vec::new();

    // PNG signature
    out.extend_from_slice(&[137, 80, 78, 71, 13, 10, 26, 10]);

    // IHDR chunk
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.push(8);  // bit depth
    ihdr.push(6);  // color type: RGBA
    ihdr.push(0);  // compression
    ihdr.push(0);  // filter
    ihdr.push(0);  // interlace
    write_chunk(&mut out, b"IHDR", &ihdr);

    // IDAT chunk
    write_chunk(&mut out, b"IDAT", &zlib_data);

    // IEND chunk
    write_chunk(&mut out, b"IEND", &[]);

    Ok(out)
}
