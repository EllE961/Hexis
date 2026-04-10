use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

mod db;
mod lsp;
mod fs_watcher;

/// Application state shared across commands
pub struct AppState {
    pub db: Mutex<Connection>,
    pub project_path: Mutex<Option<PathBuf>>,
}

/// File info returned by scan
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub extension: Option<String>,
    pub group_path: String,
    pub size_bytes: u64,
    pub is_directory: bool,
}

/// Group info returned by scan
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GroupInfo {
    pub path: String,
    pub name: String,
    pub parent_path: Option<String>,
    pub depth: u32,
    pub file_count: u32,
}

/// Scan a project directory and return files + groups
#[tauri::command]
fn scan_project(path: String, state: State<AppState>) -> Result<serde_json::Value, String> {
    let project_path = PathBuf::from(&path);
    if !project_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    // Store project path
    *state.project_path.lock().unwrap() = Some(project_path.clone());

    // Scan filesystem
    let mut files = Vec::new();
    let mut groups = Vec::new();
    scan_dir(&project_path, &project_path, &mut files, &mut groups, 0);

    // Insert into SQLite
    let db = state.db.lock().unwrap();
    db::insert_scan_results(&db, &files, &groups).map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "files": files.len(),
        "groups": groups.len(),
        "project_path": path,
    }))
}

/// Get all files from the database
#[tauri::command]
fn get_files(state: State<AppState>) -> Result<Vec<FileInfo>, String> {
    let db = state.db.lock().unwrap();
    db::get_all_files(&db).map_err(|e| e.to_string())
}

/// Get all groups from the database
#[tauri::command]
fn get_groups(state: State<AppState>) -> Result<Vec<GroupInfo>, String> {
    let db = state.db.lock().unwrap();
    db::get_all_groups(&db).map_err(|e| e.to_string())
}

/// Read a file's content
#[tauri::command]
fn read_file(path: String, state: State<AppState>) -> Result<String, String> {
    let project = state.project_path.lock().unwrap();
    let project_path = project.as_ref().ok_or("No project loaded")?;
    let full_path = project_path.join(&path);

    // Security: ensure path is within project
    if !full_path.starts_with(project_path) {
        return Err("Path outside project".to_string());
    }

    std::fs::read_to_string(&full_path).map_err(|e| e.to_string())
}

/// Probe for an initial workspace path from CLI args / env vars.
///
/// Resolution order (first hit wins):
///   1. First positional CLI argument that is an existing directory
///      (e.g. `hexis-app C:\my\repo`)
///   2. HEXIS_TARGET environment variable
///
/// Returns Some(path) on hit, None if neither yields a valid directory.
/// The frontend then falls back to its localStorage "most recent" or
/// shows the welcome screen.
#[tauri::command]
fn get_initial_workspace() -> Option<String> {
    // CLI argument
    for arg in std::env::args().skip(1) {
        // Skip known flags
        if arg.starts_with('-') { continue; }
        let p = std::path::PathBuf::from(&arg);
        if p.is_dir() {
            return Some(p.to_string_lossy().replace('\\', "/"));
        }
    }
    // Environment variable
    if let Ok(env_target) = std::env::var("HEXIS_TARGET") {
        let p = std::path::PathBuf::from(&env_target);
        if p.is_dir() {
            return Some(p.to_string_lossy().replace('\\', "/"));
        }
    }
    None
}

/// Write content to a file
#[tauri::command]
fn write_file(path: String, content: String, state: State<AppState>) -> Result<(), String> {
    let project = state.project_path.lock().unwrap();
    let project_path = project.as_ref().ok_or("No project loaded")?;
    let full_path = project_path.join(&path);

    if !full_path.starts_with(project_path) {
        return Err("Path outside project".to_string());
    }

    std::fs::write(&full_path, content).map_err(|e| e.to_string())
}

// ═══════════════════════════════════════════════════════════════════
// File/folder CRUD — used by the hex grid drag-drop + context menus
// ═══════════════════════════════════════════════════════════════════

fn resolve_project_path(
    path: &str,
    state: &State<AppState>,
) -> Result<PathBuf, String> {
    let project = state.project_path.lock().unwrap();
    let project_path = project.as_ref().ok_or("No project loaded")?;
    let full = project_path.join(path);
    if !full.starts_with(project_path) {
        return Err("Path outside project".to_string());
    }
    Ok(full)
}

/// Create a new file with optional content. Fails if it already exists.
#[tauri::command]
fn create_file(
    path: String,
    content: Option<String>,
    state: State<AppState>,
) -> Result<(), String> {
    let full = resolve_project_path(&path, &state)?;
    if full.exists() {
        return Err("file already exists".to_string());
    }
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&full, content.unwrap_or_default()).map_err(|e| e.to_string())
}

/// Delete a file — moves to the OS trash (recoverable via the system
/// recycle bin / .Trash / etc.). Falls back to permanent unlink if
/// the trash crate can't reach a recycle bin (rare on Linux without
/// gvfs, but handled gracefully).
#[tauri::command]
fn delete_file(path: String, state: State<AppState>) -> Result<(), String> {
    let full = resolve_project_path(&path, &state)?;
    match trash::delete(&full) {
        Ok(_) => Ok(()),
        Err(e) => {
            eprintln!("[trash] delete_file fallback to permanent unlink: {}", e);
            std::fs::remove_file(&full).map_err(|err| err.to_string())
        }
    }
}

/// Copy a file from an ABSOLUTE source path (outside the workspace)
/// to a relative destination inside the workspace. Used by OS drag-in
/// when the user drops a file from File Explorer onto the hex grid.
#[tauri::command]
fn copy_external_file(
    from: String,
    to: String,
    state: State<AppState>,
) -> Result<(), String> {
    let src = PathBuf::from(&from);
    if !src.is_file() {
        return Err(format!("Source is not a file: {}", from));
    }
    let dest = resolve_project_path(&to, &state)?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::copy(&src, &dest).map_err(|e| e.to_string())?;
    Ok(())
}

/// Rename or move a file. Creates destination parent dirs if needed.
#[tauri::command]
fn rename_file(
    old_path: String,
    new_path: String,
    state: State<AppState>,
) -> Result<(), String> {
    let from = resolve_project_path(&old_path, &state)?;
    let to = resolve_project_path(&new_path, &state)?;
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}

/// Create a new (possibly nested) folder.
#[tauri::command]
fn create_folder(path: String, state: State<AppState>) -> Result<(), String> {
    let full = resolve_project_path(&path, &state)?;
    std::fs::create_dir_all(&full).map_err(|e| e.to_string())
}

/// Move/rename an entire folder and its contents.
#[tauri::command]
fn move_folder(
    from: String,
    to: String,
    state: State<AppState>,
) -> Result<(), String> {
    let from_full = resolve_project_path(&from, &state)?;
    let to_full = resolve_project_path(&to, &state)?;
    if let Some(parent) = to_full.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&from_full, &to_full).map_err(|e| e.to_string())
}

/// Recursively delete a folder — moves to the OS trash when possible,
/// falls back to permanent recursive removal otherwise.
#[tauri::command]
fn delete_folder(path: String, state: State<AppState>) -> Result<(), String> {
    let full = resolve_project_path(&path, &state)?;
    match trash::delete(&full) {
        Ok(_) => Ok(()),
        Err(e) => {
            eprintln!("[trash] delete_folder fallback to permanent rm -rf: {}", e);
            std::fs::remove_dir_all(&full).map_err(|err| err.to_string())
        }
    }
}

/// Open the OS file explorer at the given path (or its parent if it's
/// a file). Cross-platform: Windows explorer, macOS Finder, Linux xdg-open.
#[tauri::command]
fn reveal_in_explorer(path: String, state: State<AppState>) -> Result<(), String> {
    let full = resolve_project_path(&path, &state)?;

    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        // /select,<file> highlights the file inside the folder
        let arg = if full.is_file() {
            format!("/select,{}", full.to_string_lossy())
        } else {
            full.to_string_lossy().into_owned()
        };
        Command::new("explorer").arg(arg).spawn().map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        Command::new("open")
            .arg("-R")
            .arg(full.as_os_str())
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        use std::process::Command;
        let target = if full.is_file() {
            full.parent().map(|p| p.to_path_buf()).unwrap_or(full.clone())
        } else {
            full.clone()
        };
        Command::new("xdg-open")
            .arg(target.as_os_str())
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Single workspace search match — one matched line in one file
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchMatch {
    pub path: String,
    pub line: u32,
    pub col: u32,
    pub text: String,
    pub matches: Vec<[u32; 2]>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchResult {
    pub results: Vec<SearchMatch>,
    pub truncated: bool,
}

/// Workspace search via ripgrep. Requires `rg` on the system PATH.
/// Falls back to an empty result if rg is missing — UI should surface
/// a "ripgrep not installed" hint in that case.
#[tauri::command]
fn search_workspace(
    pattern: String,
    regex: Option<bool>,
    case_sensitive: Option<bool>,
    glob: Option<String>,
    max: Option<u32>,
    state: State<AppState>,
) -> Result<SearchResult, String> {
    use std::process::Command;

    if pattern.is_empty() || pattern.len() > 500 {
        return Err("invalid pattern".to_string());
    }

    let project = state.project_path.lock().unwrap();
    let project_path = project.as_ref().ok_or("No project loaded")?.clone();
    drop(project);

    let mut cmd = Command::new("rg");
    cmd.arg("--json").arg("--max-count").arg("200");
    if !regex.unwrap_or(false) {
        cmd.arg("--fixed-strings");
    }
    if !case_sensitive.unwrap_or(false) {
        cmd.arg("--ignore-case");
    }
    if let Some(g) = &glob {
        cmd.arg("--glob").arg(g);
    }
    cmd.arg("--").arg(&pattern).arg(".");
    cmd.current_dir(&project_path);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let output = cmd.output().map_err(|e| format!("ripgrep not available: {}", e))?;
    // exit 1 = no matches (ok), 0 = matches, >1 = error
    if !output.status.success() && output.status.code().unwrap_or(2) > 1 {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut results = Vec::new();
    let cap = max.unwrap_or(500) as usize;
    let mut truncated = false;

    for line in stdout.lines() {
        if results.len() >= cap { truncated = true; break; }
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if msg.get("type").and_then(|v| v.as_str()) != Some("match") { continue; }
        let data = match msg.get("data") { Some(d) => d, None => continue };

        let path = data.get("path").and_then(|p| p.get("text")).and_then(|t| t.as_str())
            .unwrap_or("").replace('\\', "/");
        let line_num = data.get("line_number").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        let text = data.get("lines").and_then(|l| l.get("text")).and_then(|t| t.as_str())
            .unwrap_or("").trim_end_matches('\n').trim_end_matches('\r').to_string();

        let submatches: Vec<[u32; 2]> = data.get("submatches")
            .and_then(|s| s.as_array())
            .map(|arr| arr.iter().filter_map(|sm| {
                let start = sm.get("start")?.as_u64()? as u32;
                let end = sm.get("end")?.as_u64()? as u32;
                Some([start, end])
            }).collect())
            .unwrap_or_default();

        let col = submatches.first().map(|m| m[0]).unwrap_or(0);

        results.push(SearchMatch { path, line: line_num, col, text, matches: submatches });
    }

    Ok(SearchResult { results, truncated })
}

fn scan_dir(
    root: &PathBuf,
    dir: &PathBuf,
    files: &mut Vec<FileInfo>,
    groups: &mut Vec<GroupInfo>,
    depth: u32,
) {
    let ignore = [".git", "node_modules", ".claude", "dist", "target", "__pycache__", ".next"];

    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if name.starts_with('.') && name != ".env" {
            continue;
        }
        if ignore.contains(&name.as_str()) {
            continue;
        }

        let rel_path = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");

        if path.is_dir() {
            let parent = if depth == 0 {
                None
            } else {
                Some(
                    dir.strip_prefix(root)
                        .unwrap_or(dir)
                        .to_string_lossy()
                        .replace('\\', "/"),
                )
            };

            groups.push(GroupInfo {
                path: rel_path.clone(),
                name: name.clone(),
                parent_path: parent,
                depth,
                file_count: 0, // computed later
            });

            scan_dir(root, &path, files, groups, depth + 1);
        } else {
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_string());
            let group = dir
                .strip_prefix(root)
                .unwrap_or(dir)
                .to_string_lossy()
                .replace('\\', "/");
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);

            files.push(FileInfo {
                path: rel_path,
                name,
                extension: ext,
                group_path: if group.is_empty() { ".".to_string() } else { group },
                size_bytes: size,
                is_directory: false,
            });
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize SQLite database
    let db_path = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("hexis")
        .join("hexis.db");

    // Ensure directory exists
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }

    let conn = Connection::open(&db_path).expect("Failed to open SQLite database");
    db::initialize(&conn).expect("Failed to initialize database schema");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            db: Mutex::new(conn),
            project_path: Mutex::new(None),
        })
        .manage(lsp::LspState::default())
        .manage(fs_watcher::WatcherState::default())
        .invoke_handler(tauri::generate_handler![
            scan_project,
            get_files,
            get_groups,
            read_file,
            write_file,
            create_file,
            delete_file,
            rename_file,
            copy_external_file,
            create_folder,
            move_folder,
            delete_folder,
            reveal_in_explorer,
            search_workspace,
            get_initial_workspace,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            lsp::lsp_detect,
            fs_watcher::start_fs_watcher,
            fs_watcher::stop_fs_watcher,
            fs_watcher::fs_watcher_root,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Hexis");
}
