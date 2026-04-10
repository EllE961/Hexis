/**
 * Bookmarks Store — cross-file bookmarks with optional notes.
 *
 * Persisted to localStorage per workspace. Keys:
 *   Ctrl+F2      toggle bookmark at cursor
 *   Ctrl+Shift+F2 next bookmark (wraps)
 *   Ctrl+Alt+F2   previous bookmark
 *
 * Each bookmark: { id, path, line, col, label, note, createdAt }
 */

import { create } from 'zustand';

const STORAGE_KEY = 'hexis-bookmarks';

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

function save(bookmarks) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bookmarks));
  } catch {
    // Storage full or disabled — drop silently
  }
}

export const useBookmarksStore = create((set, get) => ({
  bookmarks: load(),
  currentIndex: -1,

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
      save(next);
      return { bookmarks: next };
    });
  },

  setNote: (id, note) => {
    set((s) => {
      const next = s.bookmarks.map((b) => (b.id === id ? { ...b, note } : b));
      save(next);
      return { bookmarks: next };
    });
  },

  remove: (id) => {
    set((s) => {
      const next = s.bookmarks.filter((b) => b.id !== id);
      save(next);
      return { bookmarks: next };
    });
  },

  clear: () => {
    save([]);
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
