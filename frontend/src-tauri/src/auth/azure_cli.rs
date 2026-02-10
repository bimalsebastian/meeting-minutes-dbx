//! Azure CLI authentication for Databricks.
//! Uses `az` CLI; no app registration or redirect URIs needed.
//! Token resource ID for Azure Databricks: 2ff814a6-3304-4ab8-85cb-cd0e6f879c1d

use log::{error as log_error, info as log_info};
use std::path::Path;

const DATABRICKS_TOKEN_RESOURCE: &str = "2ff814a6-3304-4ab8-85cb-cd0e6f879c1d";

/// Candidates for the `az` binary. GUI apps on macOS don't get the shell PATH, so we try Homebrew paths.
fn az_candidates() -> Vec<std::path::PathBuf> {
    let mut c = vec![std::path::PathBuf::from("az")];
    #[cfg(target_os = "macos")]
    {
        c.push(std::path::PathBuf::from("/opt/homebrew/bin/az")); // Apple Silicon Homebrew
        c.push(std::path::PathBuf::from("/usr/local/bin/az"));   // Intel Homebrew
    }
    c
}

/// Run `az` with the first candidate that exists (or "az" from PATH). Returns (stdout, stderr, ok).
fn run_az(args: &[&str]) -> (String, String, bool) {
    for path in az_candidates() {
        if path == Path::new("az") {
            let out = std::process::Command::new("az").args(args).output();
            match out {
                Ok(o) => {
                    let stdout = String::from_utf8_lossy(&o.stdout).to_string();
                    let stderr = String::from_utf8_lossy(&o.stderr).to_string();
                    return (stdout, stderr, o.status.success());
                }
                Err(_) => continue,
            }
        }
        if path.exists() {
            let out = std::process::Command::new(&path).args(args).output();
            match out {
                Ok(o) => {
                    let stdout = String::from_utf8_lossy(&o.stdout).to_string();
                    let stderr = String::from_utf8_lossy(&o.stderr).to_string();
                    return (stdout, stderr, o.status.success());
                }
                Err(e) => {
                    log_error!("Failed to run {:?}: {}", path, e);
                    continue;
                }
            }
        }
    }
    (
        String::new(),
        "Azure CLI not found. Install with: brew install azure-cli. If already installed, ensure it is at /opt/homebrew/bin/az or /usr/local/bin/az.".to_string(),
        false,
    )
}

/// Check if Azure CLI is installed by running `az --version`.
#[tauri::command]
pub fn check_azure_cli_installed() -> Result<bool, String> {
    let (_stdout, stderr, ok) = run_az(&["--version"]);
    if ok {
        log_info!("Azure CLI is installed");
        Ok(true)
    } else {
        let msg = if stderr.is_empty() {
            "Azure CLI not found. Install with: brew install azure-cli"
        } else {
            stderr.trim()
        };
        Err(format!("Azure CLI not available. {}", msg))
    }
}

/// Check if user is logged in by running `az account show`.
#[tauri::command]
pub fn check_azure_logged_in() -> Result<bool, String> {
    let (_stdout, stderr, ok) = run_az(&["account", "show"]);
    if ok {
        log_info!("Azure CLI: user is logged in");
        Ok(true)
    } else {
        let msg = if !stderr.is_empty() {
            stderr.trim().to_string()
        } else {
            "Not logged in".to_string()
        };
        Err(msg)
    }
}

/// Trigger Azure login via device code: `az login --use-device-code`.
#[tauri::command]
pub fn do_azure_login() -> Result<(), String> {
    log_info!("Running az login --use-device-code");
    let (_stdout, stderr, ok) = run_az(&["login", "--use-device-code"]);
    if ok {
        Ok(())
    } else {
        let msg = if stderr.is_empty() {
            "Login failed. Check your terminal for the device code and complete sign-in in the browser."
        } else {
            stderr.trim()
        };
        Err(msg.to_string())
    }
}

/// Get Databricks access token via Azure CLI: `az account get-access-token --resource <resource_id>`.
/// Returns the access token string; frontend stores it with secure_store.
#[tauri::command]
pub fn get_databricks_token() -> Result<String, String> {
    let (stdout, stderr, ok) = run_az(&[
        "account",
        "get-access-token",
        "--resource",
        DATABRICKS_TOKEN_RESOURCE,
        "--output",
        "json",
    ]);
    if !ok {
        let msg = if stderr.is_empty() {
            "Failed to get access token. Run 'az login' first."
        } else {
            stderr.trim()
        };
        return Err(msg.to_string());
    }
    let json: serde_json::Value = serde_json::from_str(stdout.trim()).map_err(|e| {
        format!("Failed to parse token response: {}", e)
    })?;
    let token = json
        .get("accessToken")
        .or_else(|| json.get("access_token"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Token response missing accessToken".to_string())?;
    Ok(token.to_string())
}

/// Refresh token: same as get_databricks_token (Azure CLI handles refresh).
#[tauri::command]
pub fn refresh_databricks_token() -> Result<String, String> {
    get_databricks_token()
}
