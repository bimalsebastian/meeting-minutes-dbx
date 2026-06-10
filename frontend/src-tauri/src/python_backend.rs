/// python_backend.rs
///
/// Manages the lifecycle of the Python FastAPI backend (port 5167).
/// Spawns uvicorn directly (no --reload) so the process tree is simple
/// and can be cleanly killed on app exit.

use std::fs::{self, OpenOptions};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

static BACKEND_PROCESS: Mutex<Option<Child>> = Mutex::new(None);

fn resolve_backend_paths() -> Option<(PathBuf, PathBuf)> {
    let home = dirs::home_dir()?;
    let project_root = home.join("meeting-minutes-dbx");

    let python = project_root
        .join("backend")
        .join("venv")
        .join("bin")
        .join("python");

    let app_dir = project_root.join("backend").join("app");

    if python.exists() && app_dir.exists() {
        Some((python, app_dir))
    } else {
        None
    }
}

fn log_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("Library")
        .join("Logs")
        .join("meetily-backend.log")
}

/// Build a PATH that includes Homebrew, the venv bin, and standard system paths.
fn augmented_path(python: &std::path::Path) -> String {
    let venv_bin = python.parent().unwrap_or(std::path::Path::new("/usr/bin"));
    let extras = [
        venv_bin.to_str().unwrap_or(""),
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ];
    extras.join(":")
}

/// Start the Python backend. Idempotent — does nothing if already running.
pub fn start_backend() {
    let mut guard = BACKEND_PROCESS.lock().unwrap();
    if guard.is_some() {
        return;
    }

    let (python, app_dir) = match resolve_backend_paths() {
        Some(p) => p,
        None => {
            log::warn!("[python_backend] Backend not found — co-pilot and calendar features will be unavailable");
            return;
        }
    };

    // Rotate log file (keep last run)
    let log = log_path();
    if let Some(parent) = log.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::remove_file(&log);
    let log_file = match OpenOptions::new().create(true).write(true).open(&log) {
        Ok(f) => f,
        Err(e) => {
            log::error!("[python_backend] Cannot open log file {}: {}", log.display(), e);
            return;
        }
    };
    let log_stderr = match log_file.try_clone() {
        Ok(f) => f,
        Err(_) => return,
    };

    let path_env = augmented_path(&python);

    log::info!(
        "[python_backend] Starting backend (logs → {})",
        log.display()
    );

    match Command::new(&python)
        .args([
            "-m", "uvicorn",
            "main:app",
            "--host", "0.0.0.0",
            "--port", "5167",
            "--log-level", "warning",
        ])
        .current_dir(&app_dir)
        .env("PATH", &path_env)
        .env("HOME", dirs::home_dir().unwrap_or_default())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_stderr))
        .spawn()
    {
        Ok(child) => {
            log::info!("[python_backend] Backend started (PID {})", child.id());
            *guard = Some(child);
        }
        Err(e) => {
            log::error!("[python_backend] Failed to start backend: {}", e);
        }
    }
}

/// Wait until the backend is accepting connections (max ~15 seconds).
pub async fn wait_until_ready() {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap_or_default();

    for i in 0..15 {
        tokio::time::sleep(Duration::from_secs(1)).await;
        if client
            .get("http://localhost:5167/api/meetings")
            .send()
            .await
            .map(|r| r.status().as_u16() < 500)
            .unwrap_or(false)
        {
            log::info!("[python_backend] Backend ready after {}s", i + 1);
            return;
        }
    }
    log::warn!("[python_backend] Backend did not become ready in 15s — check ~/Library/Logs/meetily-backend.log");
}

/// Kill the backend cleanly on app exit.
pub fn stop_backend() {
    let mut guard = BACKEND_PROCESS.lock().unwrap();
    if let Some(mut child) = guard.take() {
        log::info!("[python_backend] Stopping backend (PID {})", child.id());
        let _ = child.kill();
        let _ = child.wait();
    }
}
