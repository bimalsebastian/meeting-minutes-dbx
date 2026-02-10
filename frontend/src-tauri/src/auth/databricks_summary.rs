//! Tauri command to generate a summary via Databricks Model Serving from the Rust backend.
//! Used when the frontend wants to call the serving endpoint from the native side (e.g. to avoid CSP/network restrictions).

use serde::Deserialize;
use serde_json::json;

const DEFAULT_SYSTEM_PROMPT: &str = "You are a helpful assistant that summarizes meeting transcripts. Produce a clear, concise summary with key points and action items when relevant.";

#[derive(Debug, Deserialize)]
pub struct DatabricksGenerateSummaryArgs {
    #[serde(rename = "workspaceUrl")]
    workspace_url: String,
    #[serde(rename = "endpointName")]
    endpoint_name: String,
    token: String,
    transcript: String,
}

#[tauri::command]
pub async fn databricks_generate_summary(args: DatabricksGenerateSummaryArgs) -> Result<String, String> {
    let DatabricksGenerateSummaryArgs {
        workspace_url,
        endpoint_name,
        token,
        transcript,
    } = args;

    println!("[Rust] databricks_generate_summary called");
    println!("[Rust] Workspace URL: {}", workspace_url);
    println!("[Rust] Endpoint: {}", endpoint_name);
    println!("[Rust] Token length: {}", token.len());
    println!("[Rust] Transcript length: {}", transcript.len());

    let url = format!(
        "{}/serving-endpoints/{}/invocations",
        workspace_url.trim_end_matches('/'),
        urlencoding::encode(&endpoint_name)
    );

    println!("[Rust] Request URL: {}", url);

    let payload = json!({
        "messages": [
            {
                "role": "system",
                "content": DEFAULT_SYSTEM_PROMPT
            },
            {
                "role": "user",
                "content": transcript
            }
        ],
        "max_tokens": 2000
    });

    println!(
        "[Rust] Payload: {}",
        serde_json::to_string_pretty(&payload).unwrap()
    );

    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", token))
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            eprintln!("[Rust] Request failed: {}", e);
            format!("Request failed: {}", e)
        })?;

    let status = response.status();
    println!("[Rust] Response status: {}", status);

    let response_text = response.text().await.map_err(|e| {
        eprintln!("[Rust] Failed to read response: {}", e);
        format!("Failed to read response: {}", e)
    })?;

    let preview_len = response_text.len().min(500);
    println!("[Rust] Response body: {}", &response_text[..preview_len]);

    if !status.is_success() {
        return Err(format!("API returned {}: {}", status, response_text));
    }

    let response_json: serde_json::Value = serde_json::from_str(&response_text)
        .map_err(|e| format!("Invalid JSON response: {}", e))?;

    let summary = response_json["choices"][0]["message"]["content"]
        .as_str()
        .ok_or("Missing content in response")?
        .to_string();

    println!("[Rust] Summary extracted, length: {}", summary.len());

    Ok(summary)
}
