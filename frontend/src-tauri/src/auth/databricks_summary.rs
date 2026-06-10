//! Tauri command to generate a summary via Databricks Model Serving from the Rust backend.
//! Used when the frontend wants to call the serving endpoint from the native side (e.g. to avoid CSP/network restrictions).

use serde::Deserialize;
use serde_json::json;

const BASE_SYSTEM_PROMPT: &str = "You are a helpful assistant that summarizes meeting transcripts. Produce a clear, concise summary with key points and action items when relevant.";

#[derive(Debug, Deserialize)]
pub struct DatabricksGenerateSummaryArgs {
    #[serde(rename = "workspaceUrl")]
    workspace_url: String,
    #[serde(rename = "endpointName")]
    endpoint_name: String,
    token: String,
    transcript: String,
    /// Optional pre-fetched knowledge base context. When provided it is
    /// prepended to the system prompt so the LLM can use it while summarising.
    #[serde(rename = "knowledgeContext", default)]
    knowledge_context: Option<String>,
}

#[tauri::command]
pub async fn databricks_generate_summary(args: DatabricksGenerateSummaryArgs) -> Result<String, String> {
    let DatabricksGenerateSummaryArgs {
        workspace_url,
        endpoint_name,
        token,
        transcript,
        knowledge_context,
    } = args;

    let system_prompt = match &knowledge_context {
        Some(ctx) if !ctx.trim().is_empty() => {
            format!(
                "Knowledge Base Context (use this background information while summarising):\n\n{}\n\n---\n\n{}",
                ctx.trim(),
                BASE_SYSTEM_PROMPT
            )
        }
        _ => BASE_SYSTEM_PROMPT.to_string(),
    };

    println!("[Rust] databricks_generate_summary called");
    println!("[Rust] KB context injected: {}", knowledge_context.is_some());

    let url = format!(
        "{}/serving-endpoints/{}/invocations",
        workspace_url.trim_end_matches('/'),
        urlencoding::encode(&endpoint_name)
    );

    let payload = json!({
        "messages": [
            {
                "role": "system",
                "content": system_prompt
            },
            {
                "role": "user",
                "content": transcript
            }
        ],
        "max_tokens": 2000
    });

    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", token))
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = response.status();
    let response_text = response.text().await.map_err(|e| format!("Failed to read response: {}", e))?;

    if !status.is_success() {
        return Err(format!("API returned {}: {}", status, response_text));
    }

    let response_json: serde_json::Value = serde_json::from_str(&response_text)
        .map_err(|e| format!("Invalid JSON response: {}", e))?;

    let summary = response_json["choices"][0]["message"]["content"]
        .as_str()
        .ok_or("Missing content in response")?
        .to_string();

    Ok(summary)
}
