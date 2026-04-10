/**
 * Workspace Store — which directory Hexis is currently looking at.
 *
 * Resolution order on startup (Tauri desktop):
 *   1. CLI arg from `argv` (e.g. `hexis-app C:\my\repo`)
 *   2. HEXIS_TARGET environment variable
 *   3. Last-opened workspace from localStorage
 *   4. Nothing → show the welcome screen and let the user pick
 *
 * In web/dev mode, the server already locks itself to a single repo
 * (via `cli.js` or `HEXIS_TARGET`), so the workspace is fixed and this
 * store just mirrors that.
 *
 * Switching workspaces in Tauri tears down LSP servers, clears the
 * symbol index and outline caches, scans the new directory, and
 * persists it as "most recent".
 */

import { create } from 'zustand';

const STORAGE_KEY = 'hexis-workspaces';
const MAX_RECENT = 8;

const IS_TAURI = typeof window !== 'undefined' && window.__TAURI_INTERNALS__;

function loadPersisted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { current: null, recent: [] };
    const parsed = JSON.parse(raw);
    return {
      current: parsed.current || null,
      recent: Array.isArray(parsed.recent) ? parsed.recent : [],
    };
  } catch {
    return { current: null, recent: [] };
  }
}

function persist(state) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ current: state.current, recent: state.recent }),
    );
  } catch { /* storage full or disabled */ }
}

const persisted = loadPersisted();

export const useWorkspaceStore = create((set, get) => ({
  /** The currently-open workspace path, or null if none. */
  current: persisted.current,
  /** Recently opened paths, most-recent first. */
  recent: persisted.recent,
  /** Initial resolution has finished — false until startup probes complete. */
  resolved: false,

  /**
   * Resolve the initial workspace path on app startup. Reads CLI args
   * and env vars from the Tauri Rust side, then falls back to the most
   * recent persisted workspace, then null.
   */
  resolveInitial: async () => {
    if (!IS_TAURI) {
      // Web/dev mode: server is locked to one repo by cli.js. We don't
      // know the actual path on the client side; mark as resolved with
      // a sentinel so the file picker is hidden.
      set({ current: '__server_locked__', resolved: true });
      return '__server_locked__';
    }
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const initial = await invoke('get_initial_workspace');
      // Initial may be from CLI/env (highest priority) or null. If null,
      // fall back to the most recently used persisted workspace.
      const target = initial || get().current || null;
      set({ current: target, resolved: true });
      return target;
    } catch (err) {
      console.error('[workspace] resolveInitial failed:', err);
      set({ resolved: true });
      return get().current;
    }
  },

  /** Set the active workspace and add it to recents. Persists. */
  setWorkspace: (path) => {
    if (!path) return;
    set((s) => {
      const recent = [path, ...s.recent.filter((p) => p !== path)].slice(0, MAX_RECENT);
      const next = { ...s, current: path, recent };
      persist(next);
      return { current: path, recent };
    });
  },

  /** Remove a path from the recents list. */
  forget: (path) => {
    set((s) => {
      const recent = s.recent.filter((p) => p !== path);
      const next = { ...s, recent };
      persist(next);
      return { recent };
    });
  },

  /** Pop the native folder picker (Tauri) and return the chosen path. */
  pickFolder: async () => {
    if (!IS_TAURI) return null;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Open project folder',
      });
      return typeof selected === 'string' ? selected : null;
    } catch (err) {
      console.error('[workspace] pickFolder failed:', err);
      return null;
    }
  },
}));
