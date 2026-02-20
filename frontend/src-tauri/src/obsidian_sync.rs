use std::collections::HashMap;
use std::fs;
use std::path::Path;
use crate::state::AppState;
use serde_json::Value;

/// Sanitize meeting title for safe filename
fn sanitize_title(title: &str) -> String {
    title
        .chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' { c } else { '_' })
        .collect::<String>()
        .trim()
        .to_string()
}

#[tauri::command]
pub async fn write_obsidian_note(
    vault_path: String,
    meeting_title: String,
    meeting_date: String,    // ISO format: "2026-02-17"
    _meeting_duration: String, // e.g. "45 min"
    summary_text: String,
) -> Result<String, String> {
    println!("[Obsidian] Writing note: {} {}", meeting_date, meeting_title);
    
    // Create meetings subfolder if it doesn't exist
    let meetings_dir = Path::new(&vault_path).join("meetings");
    fs::create_dir_all(&meetings_dir)
        .map_err(|e| format!("Failed to create meetings dir: {}", e))?;
    
    // Sanitise meeting title for filename (remove special chars)
    let safe_title = sanitize_title(&meeting_title);
    
    // Filename: "2026-02-17 Meeting Title.md"
    let filename = format!("{} {}.md", meeting_date, safe_title);
    let file_path = meetings_dir.join(&filename);
    
    println!("[Obsidian] Writing to: {:?}", file_path);
    
    // Write the complete formatted content
    fs::write(&file_path, &summary_text)
        .map_err(|e| format!("Failed to write note: {}", e))?;
    
    let path_str = file_path.to_string_lossy().to_string();
    println!("[Obsidian] Note written successfully: {}", path_str);
    Ok(path_str)
}

#[tauri::command]
pub async fn obsidian_note_exists(
    vault_path: String,
    meeting_date: String,
    meeting_title: String,
) -> Result<bool, String> {
    let safe_title = sanitize_title(&meeting_title);
    let filename = format!("{} {}.md", meeting_date, safe_title);
    let file_path = Path::new(&vault_path)
        .join("meetings")
        .join(&filename);
    
    Ok(file_path.exists())
}

#[tauri::command]
pub async fn rename_obsidian_note(
    vault_path: String,
    meeting_date: String,
    old_title: String,
    new_title: String,
) -> Result<bool, String> {
    let meetings_dir = Path::new(&vault_path).join("meetings");
    let old_filename = format!("{} {}.md", meeting_date, sanitize_title(&old_title));
    let new_filename = format!("{} {}.md", meeting_date, sanitize_title(&new_title));
    let old_path = meetings_dir.join(&old_filename);
    let new_path = meetings_dir.join(&new_filename);
    
    println!("[Obsidian] Rename: {:?} -> {:?}", old_path, new_path);
    
    if !old_path.exists() {
        println!("[Obsidian] Old file not found, skipping rename");
        return Ok(false);
    }
    
    if old_filename == new_filename {
        println!("[Obsidian] Same filename after sanitise, skipping");
        return Ok(false);
    }
    
    fs::rename(&old_path, &new_path)
        .map_err(|e| format!("Failed to rename: {}", e))?;
    
    println!("[Obsidian] Renamed: {} -> {}", old_filename, new_filename);
    Ok(true)
}

/// Extract a single string from summary_processes.result JSON for Obsidian (prefer markdown).
fn result_to_summary_text(result_json: &str) -> String {
    let parsed: Value = match serde_json::from_str(result_json) {
        Ok(v) => v,
        Err(_) => return result_json.to_string(),
    };
    if let Some(markdown) = parsed.get("markdown").and_then(|v| v.as_str()) {
        return markdown.to_string();
    }
    // Fallback: use raw JSON so vault at least gets the content
    result_json.to_string()
}

#[tauri::command]
pub async fn get_all_meetings_with_summaries(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    println!("[Obsidian] Fetching all meetings with summaries...");
    
    let pool = state.db_manager.pool();
    
    // Prefer summary_processes (where in-app edits are saved); fallback to summaries table
    let sp_rows = sqlx::query_as::<_, (String, String)>(
        "SELECT meeting_id, result FROM summary_processes WHERE result IS NOT NULL AND result != ''"
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("DB query (summary_processes) failed: {}", e))?;
    
    let sum_rows = sqlx::query_as::<_, (String, String)>(
        "SELECT meeting_id, summary_text FROM summaries"
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("DB query (summaries) failed: {}", e))?;
    
    let mut summary_text_by_meeting: HashMap<String, String> = HashMap::new();
    for (meeting_id, summary_text) in sum_rows {
        summary_text_by_meeting.entry(meeting_id).or_insert(summary_text);
    }
    for (meeting_id, result) in sp_rows {
        summary_text_by_meeting.insert(meeting_id, result_to_summary_text(&result));
    }
    
    let meeting_ids: Vec<String> = summary_text_by_meeting.keys().cloned().collect();
    if meeting_ids.is_empty() {
        println!("[Obsidian] No meetings with summaries");
        return Ok(vec![]);
    }
    
    let mut result = Vec::with_capacity(meeting_ids.len());
    for id in &meeting_ids {
        let row = sqlx::query_as::<_, (String, String, String)>(
            "SELECT id, title, created_at FROM meetings WHERE id = ?"
        )
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("DB query (meetings) failed: {}", e))?;
        
        if let Some((mid, title, created_at)) = row {
            let date_str = created_at.split('T').next().unwrap_or("").to_string();
            let summary_text = summary_text_by_meeting.get(id).cloned().unwrap_or_default();
            result.push(serde_json::json!({
                "meetingId": mid,
                "meetingTitle": title,
                "meetingDate": if date_str.is_empty() {
                    chrono::Local::now().format("%Y-%m-%d").to_string()
                } else {
                    date_str
                },
                "summaryText": summary_text,
            }));
        }
    }
    
    result.sort_by(|a, b| {
        let a_date = a.get("meetingDate").and_then(|v| v.as_str()).unwrap_or("");
        let b_date = b.get("meetingDate").and_then(|v| v.as_str()).unwrap_or("");
        b_date.cmp(a_date)
    });
    
    println!("[Obsidian] Found {} meetings with summaries", result.len());
    Ok(result)
}
