/**
 * Local History Store — JetBrains-style per-save snapshots.
 *
 * Every time a file is saved, we record a snapshot {path, content, t}.
 * History is bounded per-file (MAX_PER_FILE) and per-total (MAX_TOTAL)
 * to keep localStorage footprint reasonable.
 *
 * Per-workspace persistence at `localStorage['hexis-local-history:<workspace>']`
 * so snapshots from one project don't leak into another. Call
 * `setWorkspace(path)` on workspace switch.
 */

import { create } from 'zustand';

const STORAGE_PREFIX = 'hexis-local-history:';
const LEGACY_KEY = 'hexis-local-history'; // pre-namespace key — migrated once
const MAX_PER_FILE = 40;
const MAX_TOTAL = 400;

function storageKey(workspace) {
  return STORAGE_PREFIX + (workspace || 'default');
}

function loadFor(workspace) {
  try {
    const raw = localStorage.getItem(storageKey(workspace));
    if (raw) {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch { /* fall through */ }
  return [];
}

function saveFor(workspace, entries) {
  try {
    localStorage.setItem(storageKey(workspace), JSON.stringify(entries));
  } catch {
    // Quota exceeded — drop oldest half and retry once
    try {
      const trimmed = entries.slice(Math.floor(entries.length / 2));
      localStorage.setItem(storageKey(workspace), JSON.stringify(trimmed));
    } catch { /* give up */ }
  }
}

// One-shot migration into 'default' bucket so existing users keep their data.
function migrateLegacy() {
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy && !localStorage.getItem(storageKey('default'))) {
      localStorage.setItem(storageKey('default'), legacy);
    }
    if (legacy) localStorage.removeItem(LEGACY_KEY);
  } catch { /* ignore */ }
}
migrateLegacy();

export const useLocalHistoryStore = create((set, get) => ({
  workspace: null,
  entries: [],

  /** Switch workspace — loads that workspace's snapshot history. */
  setWorkspace: (workspace) => {
    if (get().workspace === workspace) return;
    set({ workspace, entries: loadFor(workspace) });
  },

  /** Record a new snapshot. Coalesces duplicates (same content as previous). */
  snapshot: (path, content) => {
    if (!path || content == null) return;
    set((s) => {
      const lastForFile = s.entries.findLast
        ? s.entries.findLast((e) => e.path === path)
        : [...s.entries].reverse().find((e) => e.path === path);
      if (lastForFile && lastForFile.content === content) return s;

      let next = [...s.entries, { path, content, t: Date.now() }];

      // Enforce per-file cap
      const byFile = new Map();
      for (let i = next.length - 1; i >= 0; i--) {
        const entry = next[i];
        const count = (byFile.get(entry.path) || 0) + 1;
        byFile.set(entry.path, count);
        if (count > MAX_PER_FILE) {
          next.splice(i, 1);
        }
      }

      // Enforce total cap
      if (next.length > MAX_TOTAL) next = next.slice(next.length - MAX_TOTAL);

      saveFor(s.workspace, next);
      return { entries: next };
    });
  },

  /** Get all snapshots for a specific file, newest-first. */
  forFile: (path) => {
    return get().entries
      .filter((e) => e.path === path)
      .sort((a, b) => b.t - a.t);
  },

  clearFile: (path) => {
    set((s) => {
      const next = s.entries.filter((e) => e.path !== path);
      saveFor(s.workspace, next);
      return { entries: next };
    });
  },

  clearAll: () => {
    const s = get();
    saveFor(s.workspace, []);
    set({ entries: [] });
  },
}));
