//! Databricks CLI authentication.
//! Reads PAT tokens directly from ~/.databrickscfg or uses
//! `databricks auth token --profile <name>` for OAuth profiles.

use serde::Serialize;
use std::path::PathBuf;

// ── Profile listing ──────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct DatabricksProfile {
    pub name: String,
    pub host: String,
    pub auth_type: String,
    pub has_pat: bool,   // true if a `token = dapi...` line is present
}

/// Parse ~/.databrickscfg and return all non-DEFAULT profiles that have a host.
#[tauri::command]
pub fn list_databricks_profiles() -> Result<Vec<DatabricksProfile>, String> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Cannot read ~/.databrickscfg: {}", e))?;
    Ok(parse_profiles(&content))
}

fn parse_profiles(content: &str) -> Vec<DatabricksProfile> {
    let mut profiles = Vec::new();
    let mut name = String::new();
    let mut host = String::new();
    let mut auth_type = String::new();
    let mut token = String::new();

    let flush = |profiles: &mut Vec<DatabricksProfile>,
                  name: &str, host: &str, auth_type: &str, token: &str| {
        if name.is_empty() || host.is_empty() || name == "DEFAULT" { return; }
        profiles.push(DatabricksProfile {
            name: name.to_string(),
            host: host.trim_end_matches('/').to_string(),
            auth_type: if auth_type.is_empty() { "pat".into() } else { auth_type.to_string() },
            has_pat: !token.is_empty(),
        });
    };

    for line in content.lines() {
        let line = line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            flush(&mut profiles, &name, &host, &auth_type, &token);
            name = line[1..line.len() - 1].to_string();
            host.clear(); auth_type.clear(); token.clear();
        } else if let Some((k, v)) = line.split_once('=') {
            match k.trim() {
                "host"      => host      = v.trim().to_string(),
                "auth_type" => auth_type = v.trim().to_string(),
                "token"     => token     = v.trim().to_string(),
                _ => {}
            }
        }
    }
    flush(&mut profiles, &name, &host, &auth_type, &token);
    profiles
}

// ── Token retrieval ──────────────────────────────────────────────────────────

/// Get a Databricks bearer token for the given profile.
///
/// Strategy:
/// 1. If the profile has a PAT (`token = dapi...`) in ~/.databrickscfg → return it directly.
/// 2. Otherwise run `databricks auth token --profile <name>` and parse the JSON output.
#[tauri::command]
pub fn get_databricks_cli_token(profile: String) -> Result<String, String> {
    // Step 1: try to read PAT from config
    if let Some(token) = read_pat_for_profile(&profile) {
        return Ok(token);
    }

    // Step 2: use `databricks auth token`
    let (stdout, stderr, ok) = run_databricks(&["auth", "token", "--profile", &profile]);
    if !ok {
        return Err(format!(
            "Could not get token for profile '{profile}'. \
             Run: databricks auth login --profile {profile}\n{stderr}"
        ));
    }

    // Output is JSON: {"access_token": "dapiXXX"} or plain token
    let trimmed = stdout.trim();
    if trimmed.starts_with('{') {
        let json: serde_json::Value = serde_json::from_str(trimmed)
            .map_err(|e| format!("Failed to parse databricks auth token output: {e}"))?;
        let token = json
            .get("access_token")
            .or_else(|| json.get("token"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| "databricks auth token returned JSON but no access_token field".to_string())?
            .to_string();
        return Ok(token);
    }

    // Sometimes just the raw token is printed
    if !trimmed.is_empty() {
        return Ok(trimmed.to_string());
    }

    Err(format!(
        "Empty token from `databricks auth token --profile {profile}`. \
         Run: databricks auth login --profile {profile}"
    ))
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn config_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join(".databrickscfg"))
        .ok_or_else(|| "Cannot locate home directory".to_string())
}

fn read_pat_for_profile(profile_name: &str) -> Option<String> {
    let path = config_path().ok()?;
    let content = std::fs::read_to_string(path).ok()?;
    let mut in_section = false;
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            in_section = line[1..line.len() - 1].trim() == profile_name;
        } else if in_section {
            if let Some((k, v)) = line.split_once('=') {
                if k.trim() == "token" {
                    let t = v.trim().to_string();
                    if !t.is_empty() { return Some(t); }
                }
            }
        }
    }
    None
}

fn databricks_candidates() -> Vec<PathBuf> {
    vec![
        PathBuf::from("databricks"),
        PathBuf::from("/opt/homebrew/bin/databricks"),
        PathBuf::from("/usr/local/bin/databricks"),
        PathBuf::from("/usr/local/bin/databricks"),
    ]
}

fn run_databricks(args: &[&str]) -> (String, String, bool) {
    for candidate in databricks_candidates() {
        let prog = if candidate == PathBuf::from("databricks") {
            std::process::Command::new("databricks").args(args).output()
        } else if candidate.exists() {
            std::process::Command::new(&candidate).args(args).output()
        } else {
            continue;
        };
        if let Ok(o) = prog {
            return (
                String::from_utf8_lossy(&o.stdout).to_string(),
                String::from_utf8_lossy(&o.stderr).to_string(),
                o.status.success(),
            );
        }
    }
    (String::new(), "Databricks CLI not found. Install from https://docs.databricks.com/dev-tools/cli/index.html".to_string(), false)
}
