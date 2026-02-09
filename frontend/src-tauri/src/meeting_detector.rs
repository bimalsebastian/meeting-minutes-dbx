//! Active window detection for meeting auto-start (Zoom, Teams, Meet).

use std::process::Command;

/// Returns the title of the currently active/frontmost application window.
/// Used to detect when Zoom, Teams, or Google Meet is in focus so Meetily can auto-start recording.
#[tauri::command]
pub fn get_active_window_title() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        // Use osascript to get frontmost app name (and optionally window name).
        let script = "tell application \"System Events\" to get name of first application process whose frontmost is true";
        let output = Command::new("osascript")
            .arg("-e")
            .arg(script)
            .output()
            .map_err(|e| format!("Failed to run osascript: {}", e))?;
        if output.status.success() {
            let title = String::from_utf8_lossy(&output.stdout).trim().to_string();
            Ok(title)
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("osascript error: {}", stderr))
        }
    }

    #[cfg(target_os = "windows")]
    {
        // PowerShell: Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | Sort-Object Id | Select-Object -First 1 -ExpandProperty MainWindowTitle
        // Simpler: get foreground window via Add-Type and GetForegroundWindow (requires more code).
        // Use a simple PowerShell one-liner that lists processes with main window and picks one.
        let script = r#"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
    public static string GetActiveWindowTitle() {
        IntPtr h = GetForegroundWindow();
        var sb = new System.Text.StringBuilder(256);
        GetWindowText(h, sb, 256);
        return sb.ToString();
    }
}
"@
[Win]::GetActiveWindowTitle()
"#;
        let output = Command::new("powershell")
            .args(["-NoProfile", "-Command", script])
            .output()
            .map_err(|e| format!("Failed to run PowerShell: {}", e))?;
        if output.status.success() {
            let title = String::from_utf8_lossy(&output.stdout).trim().to_string();
            Ok(title)
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("PowerShell error: {}", stderr))
        }
    }

    #[cfg(target_os = "linux")]
    {
        // xdotool getwindowname $(xdotool getactivewindow)
        let output = Command::new("sh")
            .args(["-c", "xdotool getwindowname $(xdotool getactivewindow 2>/dev/null) 2>/dev/null"])
            .output()
            .map_err(|e| format!("Failed to get active window (install xdotool?): {}", e))?;
        if output.status.success() {
            let title = String::from_utf8_lossy(&output.stdout).trim().to_string();
            Ok(title)
        } else {
            Ok(String::new())
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = Command::new("");
        Ok(String::new())
    }
}
