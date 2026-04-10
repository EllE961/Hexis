//! File-system watcher — Tauri side.
//!
//! Watches the currently-open workspace directory and emits
//! `hexis://fs_change` events to the webview whenever files or folders
//! are created, renamed, or deleted. The frontend listens to this and
//! triggers a debounced `refreshWorkspace()` so the hex grid stays in
//! sync with external edits (another editor saving, git operations,
//! build scripts writing output, etc).
//!
//! Powered by `notify` + `notify-debouncer-full` so we get
//! platform-native file-system events (ReadDirectoryChangesW on
//! Windows, FSEvents on macOS, inotify on Linux) coalesced into clean
//! batches with a 250 ms debounce window.
//!
//! The watcher is restarted whenever the workspace changes. A global
//! handle lives in `WatcherState` so the frontend can call
//! `start_fs_watcher(path)` / `stop_fs_watcher()` as the user switches
//! projects.

use notify::{RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, Debouncer, FileIdMap};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

/// One element of the emitted batch.
#[derive(Debug, Serialize, Clone)]
pub struct FsChange {
    pub action: String, // "add" | "change" | "remove" | "rename"
    pub path: String,   // path RELATIVE to workspace root, forward slashes
}

#[derive(Debug, Serialize, Clone)]
pub struct FsChangeBatch {
    #[serde(rename = "type")]
    pub kind: &'static str, // always "fs_change"
    pub changes: Vec<FsChange>,
}

/// Shared state: the currently-active debouncer and the watched root.
/// Wrapped in a Mutex so we can stop + restart when the workspace changes.
pub struct WatcherState {
    inner: Mutex<Option<WatcherHandle>>,
}

impl Default for WatcherState {
    fn default() -> Self {
        WatcherState { inner: Mutex::new(None) }
    }
}

struct WatcherHandle {
    root: PathBuf,
    // Keeps the debouncer alive; dropping it tears the watcher down.
    _debouncer: Debouncer<notify::RecommendedWatcher, FileIdMap>,
}

/// Start watching a workspace directory. If a watcher is already
/// running, it's stopped first.
#[tauri::command]
pub fn start_fs_watcher(
    app: AppHandle,
    path: String,
    state: State<'_, WatcherState>,
) -> Result<(), String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    // Tear down any previous watcher first
    {
        let mut guard = state.inner.lock().unwrap();
        *guard = None;
    }

    let root_for_events = root.clone();
    let app_for_events = app.clone();

    // 250ms debounce — coalesces rapid bursts (git checkout, npm install,
    // save-all) into a single batch emission.
    let mut debouncer = new_debouncer(
        Duration::from_millis(250),
        None,
        move |result: notify_debouncer_full::DebounceEventResult| {
            match result {
                Ok(events) => {
                    let mut changes: Vec<FsChange> = Vec::new();
                    for ev in events {
                        for path in &ev.paths {
                            let rel = match path.strip_prefix(&root_for_events) {
                                Ok(p) => p.to_string_lossy().replace('\\', "/"),
                                Err(_) => continue, // outside workspace; skip
                            };
                            if should_ignore(&rel) { continue; }

                            use notify::EventKind;
                            let action = match ev.kind {
                                EventKind::Create(_) => "add",
                                EventKind::Remove(_) => "remove",
                                EventKind::Modify(notify::event::ModifyKind::Name(_)) => "rename",
                                EventKind::Modify(_) => "change",
                                _ => "change",
                            };

                            changes.push(FsChange {
                                action: action.to_string(),
                                path: rel,
                            });
                        }
                    }
                    if !changes.is_empty() {
                        let batch = FsChangeBatch { kind: "fs_change", changes };
                        let _ = app_for_events.emit("hexis://fs_change", batch);
                    }
                }
                Err(errors) => {
                    for err in errors {
                        eprintln!("[fs_watcher] error: {:?}", err);
                    }
                }
            }
        },
    )
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    debouncer
        .watcher()
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch {}: {}", path, e))?;

    let mut guard = state.inner.lock().unwrap();
    *guard = Some(WatcherHandle {
        root,
        _debouncer: debouncer,
    });

    Ok(())
}

/// Stop the current watcher (if any). Idempotent.
#[tauri::command]
pub fn stop_fs_watcher(state: State<'_, WatcherState>) -> Result<(), String> {
    let mut guard = state.inner.lock().unwrap();
    *guard = None;
    Ok(())
}

/// Return the path currently being watched, or None.
#[tauri::command]
pub fn fs_watcher_root(state: State<'_, WatcherState>) -> Option<String> {
    let guard = state.inner.lock().unwrap();
    guard.as_ref().map(|h| h.root.to_string_lossy().replace('\\', "/"))
}

/// Filter list — mirror of the frontend scanner's ignore list.
/// We DON'T want to fire refreshes for these (would flood the UI
/// during `npm install`, `cargo build`, etc).
fn should_ignore(rel_path: &str) -> bool {
    const IGNORED: &[&str] = &[
        ".git/",
        "node_modules/",
        "target/",
        "dist/",
        "build/",
        ".next/",
        ".nuxt/",
        ".cache/",
        "__pycache__/",
        ".claude/",
        ".hexis/",
        ".vscode/",
        ".idea/",
    ];
    for prefix in IGNORED {
        if rel_path.starts_with(prefix) || rel_path.contains(&format!("/{}", prefix)) {
            return true;
        }
    }
    // Single dotfile (but NOT .env etc at root)
    if let Some(first) = rel_path.split('/').next() {
        if first.starts_with('.') && first != ".env" && first != ".gitignore" {
            return true;
        }
    }
    false
}
