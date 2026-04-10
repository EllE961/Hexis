//! LSP bridge — Tauri side.
//!
//! Spawns a language-server subprocess (e.g. `rust-analyzer`), frames
//! outgoing messages with LSP `Content-Length:` headers, un-frames
//! incoming bytes from the server's stdout, and emits each complete
//! JSON message to the webview as a Tauri event.
//!
//! Commands:
//!   lsp_start(server_id, command, args, workspace) -> Ok
//!   lsp_send(server_id, message)                   -> Ok (raw JSON, no framing)
//!   lsp_stop(server_id)                            -> Ok
//!   lsp_detect(server_name)                        -> Option<String>  (system binary path or None)
//!
//! Events:
//!   "lsp://<server_id>/message"  — full JSON message as a String
//!   "lsp://<server_id>/exit"     — server exited (exit code or None)
//!   "lsp://<server_id>/error"    — transport or spawn error (String)

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::mpsc;

/// Shared state for all running language servers, keyed by server_id.
/// A server_id is a client-chosen string like "rust-analyzer" — one
/// per language per workspace.
#[derive(Default)]
pub struct LspState {
    servers: Mutex<HashMap<String, LspServer>>,
}

struct LspServer {
    /// Sender into the writer task — each message is raw JSON,
    /// the writer frames it with Content-Length before hitting stdin.
    tx: mpsc::UnboundedSender<String>,
    /// Kept so we can kill the child on lsp_stop.
    child: Child,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LspDetectResult {
    pub found: bool,
    pub path: Option<String>,
}

/// Try to find a language server binary on the system PATH.
#[tauri::command]
pub fn lsp_detect(server_name: String) -> LspDetectResult {
    match which::which(&server_name) {
        Ok(path) => LspDetectResult {
            found: true,
            path: Some(path.to_string_lossy().into_owned()),
        },
        Err(_) => LspDetectResult { found: false, path: None },
    }
}

/// Start a language server. Spawns the child, sets up the reader/writer
/// tasks, and stores the handle in LspState. Subsequent `lsp_send` calls
/// push JSON into the writer; the reader emits messages via Tauri events.
#[tauri::command]
pub async fn lsp_start(
    app: AppHandle,
    server_id: String,
    command: String,
    args: Vec<String>,
    workspace: Option<String>,
    state: State<'_, LspState>,
) -> Result<(), String> {
    // Already running? Reject — client must lsp_stop first.
    {
        let guard = state.servers.lock().unwrap();
        if guard.contains_key(&server_id) {
            return Err(format!("server '{}' already running", server_id));
        }
    }

    let mut cmd = Command::new(&command);
    cmd.args(&args);
    if let Some(ws) = &workspace {
        cmd.current_dir(ws);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    #[cfg(windows)]
    {
        // Prevent a console window from flashing when spawning
        // child processes on Windows (CREATE_NO_WINDOW = 0x08000000).
        cmd.creation_flags(0x08000000);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn '{}': {}", command, e))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "no stdin on spawned lsp server".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "no stdout on spawned lsp server".to_string())?;
    let stderr = child.stderr.take();

    // Writer task: receive JSON strings, frame them, write to stdin.
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        let mut stdin: ChildStdin = stdin;
        while let Some(json) = rx.recv().await {
            let header = format!("Content-Length: {}\r\n\r\n", json.len());
            if stdin.write_all(header.as_bytes()).await.is_err() { break; }
            if stdin.write_all(json.as_bytes()).await.is_err() { break; }
            if stdin.flush().await.is_err() { break; }
        }
    });

    // Reader task: un-frame server stdout into JSON messages and emit
    // them to the webview via `lsp://<id>/message` events.
    let app_for_reader = app.clone();
    let id_for_reader = server_id.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut buf: Vec<u8> = Vec::new();
        let mut tmp = [0u8; 8192];

        loop {
            match reader.read(&mut tmp).await {
                Ok(0) => break, // EOF
                Ok(n) => buf.extend_from_slice(&tmp[..n]),
                Err(e) => {
                    let _ = app_for_reader.emit(
                        &format!("lsp://{}/error", id_for_reader),
                        format!("read error: {}", e),
                    );
                    break;
                }
            }

            // Try to extract as many complete messages as we can
            loop {
                let Some(header_end) = find_header_end(&buf) else { break };
                let header_str = match std::str::from_utf8(&buf[..header_end]) {
                    Ok(s) => s,
                    Err(_) => break,
                };
                let Some(len) = parse_content_length(header_str) else { break };
                let body_start = header_end + 4; // skip CRLFCRLF
                if buf.len() < body_start + len { break; }

                let body = &buf[body_start..body_start + len];
                if let Ok(s) = std::str::from_utf8(body) {
                    let _ = app_for_reader.emit(
                        &format!("lsp://{}/message", id_for_reader),
                        s.to_string(),
                    );
                }
                // Drain consumed bytes
                buf.drain(..body_start + len);
            }
        }

        let _ = app_for_reader.emit(
            &format!("lsp://{}/exit", id_for_reader),
            "EOF".to_string(),
        );
    });

    // Drain stderr into error events — keeps the child from blocking on a
    // full pipe and gives us diagnostic visibility in the UI.
    if let Some(stderr) = stderr {
        let app_for_err = app.clone();
        let id_for_err = server_id.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if let Ok(s) = std::str::from_utf8(&buf[..n]) {
                            let _ = app_for_err.emit(
                                &format!("lsp://{}/stderr", id_for_err),
                                s.to_string(),
                            );
                        }
                    }
                }
            }
        });
    }

    // Store the server handle
    state.servers.lock().unwrap().insert(
        server_id.clone(),
        LspServer { tx, child },
    );

    Ok(())
}

/// Send a raw JSON message to the server's stdin (framing is applied
/// internally by the writer task).
#[tauri::command]
pub fn lsp_send(
    server_id: String,
    message: String,
    state: State<'_, LspState>,
) -> Result<(), String> {
    let guard = state.servers.lock().unwrap();
    let server = guard
        .get(&server_id)
        .ok_or_else(|| format!("server '{}' not running", server_id))?;
    server
        .tx
        .send(message)
        .map_err(|e| format!("send failed: {}", e))
}

/// Stop a running server. Kills the child; reader/writer tasks exit on
/// their own via EOF / closed channel.
#[tauri::command]
pub async fn lsp_stop(
    server_id: String,
    state: State<'_, LspState>,
) -> Result<(), String> {
    let server = {
        let mut guard = state.servers.lock().unwrap();
        guard.remove(&server_id)
    };
    if let Some(mut server) = server {
        let _ = server.child.start_kill();
        let _ = server.child.wait().await;
    }
    Ok(())
}

// ─── Helpers ───

fn find_header_end(buf: &[u8]) -> Option<usize> {
    // Look for CRLFCRLF terminator
    for i in 0..buf.len().saturating_sub(3) {
        if &buf[i..i + 4] == b"\r\n\r\n" {
            return Some(i);
        }
    }
    None
}

fn parse_content_length(header: &str) -> Option<usize> {
    for line in header.split("\r\n") {
        if let Some(rest) = line.strip_prefix("Content-Length:") {
            return rest.trim().parse().ok();
        }
    }
    None
}
