/**
 * Bookmarks Store — cross-file bookmarks with optional notes.
 *
 * Persisted per-workspace to `localStorage['hexis-bookmarks:<workspace>']`
 * so bookmarks from Project A don't appear when you open Project B.
 * Call `setWorkspace(path)` on workspace switch to reload.
 *
 *   Ctrl+F2       toggle bookmark at cursor
 *   Ctrl+Shift+F2 next bookmark (wraps)
 *   Ctrl+Alt+F2   previous bookmark
 *
 * Each bookmark: { id, path, line, col, label, note, createdAt }
 */

import { create } from 'zustand';

const STORAGE_PREFIX = 'hexis-bookmarks:';
const LEGACY_KEY = 'hexis-bookmarks'; // pre-namespace key — migrated on first load

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

function saveFor(workspace, bookmarks) {
  try {
    localStorage.setItem(storageKey(workspace), JSON.stringify(bookmarks));
  } catch {
    /* storage full — drop silently */
  }
}

// One-shot migration: move pre-namespace data into the 'default' bucket so
// existing users don't lose bookmarks on upgrade. Runs once per browser.
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

export const useBookmarksStore = create((set, get) => ({
  workspace: null,
  bookmarks: [],
  currentIndex: -1,

  /** Switch to the bookmarks for a different workspace. */
  setWorkspace: (workspace) => {
    if (get().workspace === workspace) return;
    set({
      workspace,
      bookmarks: loadFor(workspace),
      currentIndex: -1,
    });
  },

  toggle: ({ path, line, col = 0, label = '' }) => {
    if (!path) return;
    set((s) => {
      const exists = s.bookmarks.findIndex((b) => b.path === path && b.line === line);
      let next;
      if (exists >= 0) {
        next = s.bookmarks.filter((_, i) => i !== exists);
      } else {
        next = [
          ...s.bookmarks,
          {
            id: `${path}:${line}:${Date.now()}`,
            path,
            line,
            col,
            label,
            note: '',
            createdAt: Date.now(),
          },
        ];
      }
      saveFor(s.workspace, next);
      return { bookmarks: next };
    });
  },

  setNote: (id, note) => {
    set((s) => {
      const next = s.bookmarks.map((b) => (b.id === id ? { ...b, note } : b));
      saveFor(s.workspace, next);
      return { bookmarks: next };
    });
  },

  remove: (id) => {
    set((s) => {
      const next = s.bookmarks.filter((b) => b.id !== id);
      saveFor(s.workspace, next);
      return { bookmarks: next };
    });
  },

  clear: () => {
    const s = get();
    saveFor(s.workspace, []);
    set({ bookmarks: [], currentIndex: -1 });
  },

  next: () => {
    const s = get();
    if (s.bookmarks.length === 0) return null;
    const idx = (s.currentIndex + 1) % s.bookmarks.length;
    set({ currentIndex: idx });
    return s.bookmarks[idx];
  },

  prev: () => {
    const s = get();
    if (s.bookmarks.length === 0) return null;
    const idx = (s.currentIndex - 1 + s.bookmarks.length) % s.bookmarks.length;
    set({ currentIndex: idx });
    return s.bookmarks[idx];
  },
}));
