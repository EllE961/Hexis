/**
 * Local History Store — JetBrains-style per-save snapshots.
 *
 * Every time a file is saved, we record a snapshot {path, content, t}.
 * History is bounded per-file (MAX_PER_FILE) and per-total (MAX_TOTAL)
 * to keep localStorage footprint reasonable.
 *
 * The UI lists snapshots for the current file with timestamps; clicking
 * one restores that version into the editor (as a dirty edit the user
 * can still undo).
 *
 * Storage strategy: IndexedDB would be better, but localStorage keeps
 * us dependency-free. We compress by storing only diffs vs the previous
 * snapshot when possible — but that's premature; start simple.
 */

import { create } from 'zustand';

const STORAGE_KEY = 'hexis-local-history';
const MAX_PER_FILE = 40;
const MAX_TOTAL = 400;

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function save(entries) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Quota exceeded — drop oldest half and retry once
    try {
      const trimmed = entries.slice(Math.floor(entries.length / 2));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    } catch { /* give up */ }
  }
}

export const useLocalHistoryStore = create((set, get) => ({
  entries: load(),

  /** Record a new snapshot. Coalesces duplicates (same content as previous). */
  snapshot: (path, content) => {
    if (!path || content == null) return;
    set((s) => {
      // Don't record if identical to the most recent snapshot for this file
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

      save(next);
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
      save(next);
      return { entries: next };
    });
  },

  clearAll: () => {
    save([]);
    set({ entries: [] });
  },
}));
