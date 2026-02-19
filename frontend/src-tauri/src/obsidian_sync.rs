use std::fs;
use std::path::Path;
use crate::state::AppState;

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

#[tauri::command]
pub async fn get_all_meetings_with_summaries(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    println!("[Obsidian] Fetching all meetings with summaries...");
    
    let pool = state.db_manager.pool();
    
    // Query meetings and summaries tables
    let rows = sqlx::query_as::<_, (String, String, String, Option<String>)>(
        r#"
        SELECT 
            m.id,
            m.title,
            m.created_at,
            s.summary_text
        FROM meetings m
        INNER JOIN summaries s ON s.meeting_id = m.id
        ORDER BY m.created_at DESC
        "#
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("DB query failed: {}", e))?;
    
    let result: Vec<serde_json::Value> = rows
        .iter()
        .map(|row| {
            // Format date to YYYY-MM-DD from TEXT field (format: "2026-02-17T14:30:00Z")
            let date_str = row.2
                .split('T')
                .next()
                .unwrap_or("")
                .to_string();
            
            serde_json::json!({
                "meetingId": row.0.clone(),
                "meetingTitle": row.1.clone(),
                "meetingDate": if date_str.is_empty() {
                    chrono::Local::now().format("%Y-%m-%d").to_string()
                } else {
                    date_str
                },
                "summaryText": row.3.clone().unwrap_or_default(),
            })
        })
        .collect();
    
    println!("[Obsidian] Found {} meetings with summaries", result.len());
    Ok(result)
}
