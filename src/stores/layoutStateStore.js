/**
 * Layout State Store — per-workspace persistence of hex-grid layout.
 *
 * Stores the last successful layout's group positions + ring sizes so
 * subsequent computes can reuse them as hints (visual stability across
 * sessions and incremental tree changes). A hard refresh
 * (View → Re-optimize Hex Layout) clears this state to force an
 * optimal ground-up re-pack.
 *
 * On-disk shape:
 *   {
 *     version: 1,
 *     groupPositions: { [groupPath]: [cq, cr] },
 *     groupRings:     { [groupPath]: ring }
 *   }
 *
 * Two storage backends in parallel:
 *   1. localStorage['hexis-layout:' + workspacePath]   — fast, per-browser
 *   2. .hexis/layout.json in the workspace root        — portable, committed
 *
 * localStorage is read first; .hexis/layout.json is the fallback for
 * fresh machines.
 */

import { create } from 'zustand';

const STORAGE_PREFIX = 'hexis-layout:';
const DISK_PATH = '.hexis/layout.json';

function storageKey(workspace) {
  if (!workspace || workspace === '__server_locked__') {
    return STORAGE_PREFIX + 'default';
  }
  return STORAGE_PREFIX + workspace;
}

function loadFromLocalStorage(workspace) {
  try {
    const raw = localStorage.getItem(storageKey(workspace));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1) return null;
    return {
      version: 1,
      groupPositions: parsed.groupPositions || {},
      groupRings: parsed.groupRings || {},
    };
  } catch {
    return null;
  }
}

function saveToLocalStorage(workspace, state) {
  try {
    localStorage.setItem(storageKey(workspace), JSON.stringify(state));
  } catch {
    /* quota / private mode — drop silently */
  }
}

function removeFromLocalStorage(workspace) {
  try {
    localStorage.removeItem(storageKey(workspace));
  } catch {
    /* ignore */
  }
}

function isTauri() {
  return typeof window !== 'undefined' && window.__TAURI_INTERNALS__;
}

async function loadFromDisk() {
  try {
    if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core');
      try {
        const contents = await invoke('read_file', { path: DISK_PATH });
        if (typeof contents !== 'string' || !contents) return null;
        const parsed = JSON.parse(contents);
        return parsed?.version === 1 ? parsed : null;
      } catch {
        // File doesn't exist yet on fresh workspace — not an error
        return null;
      }
    }
    // Web dev: dedicated endpoint returns 200 with {state: null} on missing
    const res = await fetch('/api/layout-state');
    if (!res.ok) return null;
    const { state } = await res.json();
    return state?.version === 1 ? state : null;
  } catch {
    return null;
  }
}

async function saveToDisk(state) {
  try {
    if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core');
      // write_file creates parent dirs automatically
      await invoke('write_file', {
        path: DISK_PATH,
        content: JSON.stringify(state, null, 2),
      });
      return;
    }
    await fetch('/api/layout-state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    });
  } catch {
    /* best-effort — localStorage is the source of truth */
  }
}

async function removeFromDisk() {
  try {
    if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core');
      try {
        await invoke('delete_file', { path: DISK_PATH });
      } catch {
        /* already gone — fine */
      }
      return;
    }
    await fetch('/api/layout-state', { method: 'DELETE' });
  } catch {
    /* ignore */
  }
}

export const useLayoutStateStore = create((set, get) => ({
  currentWorkspace: null,
  state: null, // { version, groupPositions, groupRings } | null
  revision: 0, // bumped on every mutation — content-hash cache buster

  /** Switch workspace — loads state from localStorage, falls back to disk. */
  setWorkspace: async (workspace) => {
    if (get().currentWorkspace === workspace) return;
    let loaded = loadFromLocalStorage(workspace);
    if (!loaded) {
      loaded = await loadFromDisk();
      if (loaded) saveToLocalStorage(workspace, loaded);
    }
    set({
      currentWorkspace: workspace,
      state: loaded,
      revision: get().revision + 1,
    });
  },

  /** Persist the new state. Called by HexCanvas after a successful layout. */
  save: (newState) => {
    if (!newState) return;
    const s = get();
    // Cheap equality check on serialized size to avoid redundant writes
    const prevSize = s.state
      ? Object.keys(s.state.groupPositions || {}).length
      : 0;
    const newSize = Object.keys(newState.groupPositions || {}).length;
    const prevJson = JSON.stringify(s.state || {});
    const newJson = JSON.stringify(newState);
    if (prevSize === newSize && prevJson === newJson) return;

    saveToLocalStorage(s.currentWorkspace, newState);
    saveToDisk(newState); // fire-and-forget
    set({ state: newState, revision: s.revision + 1 });
  },

  /** Hard refresh: wipe state so the next compute runs from scratch. */
  clear: () => {
    const s = get();
    removeFromLocalStorage(s.currentWorkspace);
    removeFromDisk(); // fire-and-forget
    set({ state: null, revision: s.revision + 1 });
  },
}));
