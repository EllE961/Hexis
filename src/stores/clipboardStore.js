/**
 * Clipboard Store — internal workspace clipboard for Cut/Copy/Paste
 * file and folder operations.
 *
 * This is a Hexis-internal clipboard. It does NOT interact with the
 * OS clipboard (that would require native code + introduces conflicts
 * with regular text cut/copy in the editor). Instead, it tracks a
 * set of paths the user has cut or copied, and pastes them into a
 * target group via create + move ops.
 *
 * Shape:
 *   items: Array<{ kind: 'file'|'folder', path: string }>
 *   mode: 'cut' | 'copy' | null
 *
 * After a cut-paste, the originals are moved (deleted from source).
 * After a copy-paste, the originals stay and new copies are created.
 *
 * Paste conflict resolution: if the target group already contains a
 * file/folder with the same leaf name, append " (copy)" / " (2)" etc.
 */

import { create } from 'zustand';

export const useClipboardStore = create((set, get) => ({
  items: [],
  mode: null, // 'cut' | 'copy' | null

  /** True if there's something pastable. */
  hasContent: () => get().items.length > 0,

  /** Put items on the clipboard in cut mode (paste MOVES). */
  cut: (items) => {
    set({ items: [...items], mode: 'cut' });
  },

  /** Put items on the clipboard in copy mode (paste DUPLICATES). */
  copy: (items) => {
    set({ items: [...items], mode: 'copy' });
  },

  /** Clear the clipboard. */
  clear: () => set({ items: [], mode: null }),

  /**
   * Apply the current clipboard to a target group.
   *
   * deps: {
   *   getAllFiles:   () => Array<file>   // for collision detection
   *   renameFile:    async (from, to) => { ok, error? }
   *   createFile:    async (path, content) => { ok, error? }
   *   readFile:      async (path) => string|null
   *   moveFolder:    async (from, to) => { ok, error? }
   *   createFolder:  async (path) => { ok, error? }
   * }
   *
   * Returns an array of { from, to, ok, error? } so callers can report
   * partial failures.
   */
  paste: async (targetGroup, deps) => {
    const { items, mode } = get();
    if (!items.length || !mode) return [];
    const results = [];

    const existingPaths = new Set((deps.getAllFiles() || []).map(f => f.path));

    for (const item of items) {
      const leaf = item.path.split('/').pop();
      let destName = leaf;
      const parent = targetGroup && targetGroup !== '.' ? targetGroup : '';
      let destPath = parent ? `${parent}/${destName}` : destName;

      // Collision: append ` (copy)`, ` (2)`, ` (3)`, etc.
      let n = 0;
      while (existingPaths.has(destPath) && item.path !== destPath) {
        n++;
        const base = destName.replace(/\.[^.]+$/, '');
        const ext = destName.includes('.') ? destName.slice(destName.lastIndexOf('.')) : '';
        const suffix = n === 1 ? ' (copy)' : ` (${n})`;
        const newLeaf = `${base}${suffix}${ext}`;
        destPath = parent ? `${parent}/${newLeaf}` : newLeaf;
      }
      existingPaths.add(destPath); // pre-reserve for next loop iter

      if (item.path === destPath) {
        // Same location — skip (cut was a no-op drop)
        results.push({ from: item.path, to: destPath, ok: true, skipped: true });
        continue;
      }

      try {
        if (item.kind === 'file') {
          if (mode === 'cut') {
            const r = await deps.renameFile(item.path, destPath);
            results.push({ from: item.path, to: destPath, ok: r?.ok !== false, error: r?.error });
          } else {
            // copy: read → create at dest
            const content = await deps.readFile(item.path);
            if (content == null) {
              results.push({ from: item.path, to: destPath, ok: false, error: 'read failed' });
              continue;
            }
            const r = await deps.createFile(destPath, content);
            results.push({ from: item.path, to: destPath, ok: r?.ok !== false, error: r?.error });
          }
        } else if (item.kind === 'folder') {
          if (mode === 'cut') {
            const r = await deps.moveFolder(item.path, destPath);
            results.push({ from: item.path, to: destPath, ok: r?.ok !== false, error: r?.error });
          } else {
            // copy of a folder is a deep recursive operation — defer to v2.
            // For now report not-implemented so the caller can surface it.
            results.push({ from: item.path, to: destPath, ok: false, error: 'folder copy not supported yet' });
          }
        }
      } catch (err) {
        results.push({ from: item.path, to: destPath, ok: false, error: err.message || String(err) });
      }
    }

    // Cut is consumed on paste — clear the clipboard
    if (mode === 'cut') set({ items: [], mode: null });

    return results;
  },
}));
