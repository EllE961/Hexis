/**
 * Jumplist Store — a ring buffer of {file, line, col} entries the user
 * has visited. Alt+Left goes back, Alt+Right goes forward. Standard
 * JetBrains/neovim staple.
 *
 * Pushed on: tab change, go-to-definition, search-result click,
 * outline-item click. NOT pushed on every cursor move (that would
 * flood the buffer).
 *
 * The active index points to the "current" position. Going back
 * decrements it; jumping to a new location truncates anything after
 * the current index (so forward navigation only exists along a
 * single branch of history).
 */

import { create } from 'zustand';

const MAX_ENTRIES = 100;

export const useJumplistStore = create((set, get) => ({
  entries: [], // [{ path, line, col, name }]
  index: -1,   // -1 = empty; otherwise 0..entries.length-1

  /**
   * Push a new jump location. If the active index is not at the tail,
   * entries after it are discarded — jumping creates a new branch.
   */
  push: ({ path, line = 0, col = 0, label = null }) => set((s) => {
    if (!path) return s;
    // Coalesce: if this push matches the current entry, don't duplicate
    const cur = s.entries[s.index];
    if (cur && cur.path === path && cur.line === line) return s;

    const head = s.entries.slice(0, s.index + 1);
    head.push({ path, line, col, label, t: Date.now() });
    const trimmed = head.length > MAX_ENTRIES ? head.slice(head.length - MAX_ENTRIES) : head;
    return { entries: trimmed, index: trimmed.length - 1 };
  }),

  /** Go to previous entry. Returns the entry or null. */
  back: () => {
    const s = get();
    if (s.index <= 0) return null;
    const nextIdx = s.index - 1;
    set({ index: nextIdx });
    return s.entries[nextIdx];
  },

  /** Go to next entry. Returns the entry or null. */
  forward: () => {
    const s = get();
    if (s.index >= s.entries.length - 1) return null;
    const nextIdx = s.index + 1;
    set({ index: nextIdx });
    return s.entries[nextIdx];
  },

  canBack: () => get().index > 0,
  canForward: () => get().index < get().entries.length - 1,

  clear: () => set({ entries: [], index: -1 }),
}));
