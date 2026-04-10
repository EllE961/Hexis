/**
 * Selection Store — tracks the set of selected files in the hex grid
 * for multi-select drag + bulk operations.
 *
 * Interactions:
 *   - Plain click → replaces selection with just the clicked file
 *   - Ctrl/Cmd+click → toggles the clicked file in/out of the set
 *   - Shift+click → range-select (reserved; v1 = add to set like Ctrl+click)
 *
 * Single-cell workflows (open file in editor, context menu on a cell)
 * still work — they use the LAST clicked file, or whatever cell the
 * event originated from.
 */

import { create } from 'zustand';

export const useSelectionStore = create((set, get) => ({
  selected: new Set(), // Set<filePath>
  lastClicked: null,   // path of the most recent click (primary)

  /** Replace the entire selection with just `path`. */
  replace: (path) => {
    set({
      selected: path ? new Set([path]) : new Set(),
      lastClicked: path || null,
    });
  },

  /** Toggle `path` in/out of the selection. */
  toggle: (path) => {
    set((s) => {
      const next = new Set(s.selected);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { selected: next, lastClicked: path };
    });
  },

  /** Add `path` to the selection (doesn't remove anything). */
  add: (path) => {
    set((s) => {
      const next = new Set(s.selected);
      next.add(path);
      return { selected: next, lastClicked: path };
    });
  },

  clear: () => set({ selected: new Set(), lastClicked: null }),

  has: (path) => get().selected.has(path),

  size: () => get().selected.size,

  toArray: () => [...get().selected],
}));
