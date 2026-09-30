// Thin native layer: locating, reading and safely writing save files, and the backup store.
// All save-format knowledge lives in the JavaScript core module.

mod backups;

use backups::Backup;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::ipc::{InvokeBody, Request, Response};

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

fn now_ms() -> u64 {
    millis(SystemTime::now())
}

fn existing_save(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if !has_extension(&p, "sav") || !p.is_file() {
        return Err(format!("{} is not an existing .sav file", p.display()));
    }
    Ok(p)
}



#[tauri::command]
fn default_save_dir() -> Option<String> {
    // Development/screenshots: open a different folder instead of the game's.
    if let Some(dir) = std::env::var_os("NIVALIS_SAVE_DIR").filter(|d| Path::new(d).is_dir()) {
        return Some(dir.to_string_lossy().into_owned());
    }
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
    // Backups made by editor v1.0/1.1 lived inside the (Steam Cloud-synced) save folder; move them.
    if let Err(e) = backups::migrate_legacy(Path::new(&dir)) {
        eprintln!("Legacy backup migration failed: {e}");
    }
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

// Body: raw save bytes. Headers `x-save-path` and `x-backup-note`: percent-encoded.
// Backs up the current file, then writes atomically via a temp file + rename.
#[tauri::command]
fn write_save(request: Request<'_>) -> Result<Backup, String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("Expected raw save bytes".into());
    };
    let encoded = request
        .headers()
        .get("x-save-path")
        .and_then(|v| v.to_str().ok())
        .ok_or("Missing save path")?;
    let path = existing_save(&percent_decode(encoded)?)?;
    let note = match request.headers().get("x-backup-note").and_then(|v| v.to_str().ok()) {
        Some(n) => percent_decode(n)?,
        None => String::new(),
    };
    backups::write_with_backup(&path, data, now_ms(), &note)
}

#[tauri::command]
fn backup_now(path: String, note: String) -> Result<Backup, String> {
    backups::backup_current(&existing_save(&path)?, now_ms(), "manual", &note)
}

#[tauri::command]
fn list_backups(path: String) -> Result<Vec<Backup>, String> {
    backups::list(Path::new(&path))
}

#[tauri::command]
fn read_backup(path: String, id: u64) -> Result<Response, String> {
    backups::read(Path::new(&path), id).map(Response::new)
}

#[tauri::command]
fn read_backup_screenshot(path: String, id: u64) -> Result<Response, String> {
    backups::read_screenshot(Path::new(&path), id).map(Response::new)
}

#[tauri::command]
fn delete_backup(path: String, id: u64) -> Result<(), String> {
    backups::delete(Path::new(&path), id)
}

#[tauri::command]
fn backup_folder() -> Result<String, String> {
    backups::store_root().map(|p| p.to_string_lossy().into_owned())
}

// Restores a backup over the save. The current save is backed up first, so a restore can be undone.
#[tauri::command]
fn restore_backup(path: String, id: u64, note: String) -> Result<Backup, String> {
    backups::restore(&existing_save(&path)?, id, now_ms(), &note)
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
            backup_now,
            list_backups,
            read_backup,
            read_backup_screenshot,
            delete_backup,
            backup_folder,
            restore_backup,
            is_game_running
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nivalis Save Editor");
}
