// Thin native layer: locating, reading and safely writing save files.
// All save-format knowledge lives in the JavaScript core module.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::ipc::{InvokeBody, Request, Response};

const BACKUP_DIR: &str = "SaveEditorBackups";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveEntry {
    name: String,
    path: String,
    size: u64,
    modified_ms: u64,
    screenshot: Option<String>,
}

fn has_extension(path: &Path, ext: &str) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map_or(false, |e| e.eq_ignore_ascii_case(ext))
}

fn millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

#[tauri::command]
fn default_save_dir() -> Option<String> {
    let profile = std::env::var_os("USERPROFILE")?;
    let dir = PathBuf::from(profile)
        .join("AppData")
        .join("LocalLow")
        .join("ION LANDS")
        .join("Nivalis Nights");
    dir.is_dir().then(|| dir.to_string_lossy().into_owned())
}

#[tauri::command]
fn list_saves(dir: String) -> Result<Vec<SaveEntry>, String> {
    let entries = fs::read_dir(&dir).map_err(|e| format!("Cannot open folder {dir}: {e}"))?;
    let mut saves = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !has_extension(&path, "sav") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let screenshot = path.with_extension("png");
        saves.push(SaveEntry {
            name: path.file_stem().unwrap_or_default().to_string_lossy().into_owned(),
            path: path.to_string_lossy().into_owned(),
            size: meta.len(),
            modified_ms: meta.modified().map_or(0, millis),
            screenshot: screenshot
                .is_file()
                .then(|| screenshot.to_string_lossy().into_owned()),
        });
    }
    saves.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    Ok(saves)
}

// Returns raw bytes (an ArrayBuffer on the JS side). Limited to saves and their screenshots.
#[tauri::command]
fn read_file(path: String) -> Result<Response, String> {
    let p = Path::new(&path);
    if !has_extension(p, "sav") && !has_extension(p, "png") {
        return Err("Only .sav and .png files can be read".into());
    }
    fs::read(p)
        .map(Response::new)
        .map_err(|e| format!("Cannot read {path}: {e}"))
}

fn percent_decode(input: &str) -> Result<String, String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|e| e.to_string())?;
            out.push(u8::from_str_radix(hex, 16).map_err(|e| e.to_string())?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

// Body: raw save bytes. Header `x-save-path`: percent-encoded target path.
// Backs up the current file, then writes atomically via a temp file + rename.
#[tauri::command]
fn write_save(request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("Expected raw save bytes".into());
    };
    let encoded = request
        .headers()
        .get("x-save-path")
        .and_then(|v| v.to_str().ok())
        .ok_or("Missing save path")?;
    let path = PathBuf::from(percent_decode(encoded)?);
    if !has_extension(&path, "sav") || !path.is_file() {
        return Err(format!("{} is not an existing .sav file", path.display()));
    }

    let dir = path.parent().ok_or("Save has no parent folder")?;
    let backup_dir = dir.join(BACKUP_DIR);
    fs::create_dir_all(&backup_dir).map_err(|e| format!("Cannot create backup folder: {e}"))?;
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let backup = backup_dir.join(format!("{stem}.{stamp}.sav.bak"));
    fs::copy(&path, &backup).map_err(|e| format!("Backup failed, nothing was written: {e}"))?;

    let tmp = path.with_extension("sav.tmp");
    fs::write(&tmp, data).map_err(|e| format!("Cannot write temp file: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Cannot replace save: {e}")
    })?;
    Ok(backup.to_string_lossy().into_owned())
}

#[tauri::command]
fn is_game_running() -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq Nivalis Nights.exe", "/NH"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("Nivalis Nights.exe"))
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            default_save_dir,
            list_saves,
            read_file,
            write_save,
            is_game_running
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nivalis Save Editor");
}
