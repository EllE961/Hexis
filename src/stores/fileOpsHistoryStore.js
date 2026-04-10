/**
 * File Ops History Store — undo/redo for file-system operations.
 *
 * Every reversible file operation (move, rename, create, delete of
 * trashed items) pushes a record onto the undoStack. Ctrl+Z applies
 * the inverse and moves the record to the redoStack. Ctrl+Y replays
 * it back.
 *
 * Operation shapes:
 *   { kind: 'move',   fromPath, toPath, entity: 'file'|'folder' }
 *   { kind: 'create', path, entity: 'file'|'folder', content? }
 *   { kind: 'delete', path, entity: 'file'|'folder', content? }
 *   { kind: 'batch',  ops: [ ... ] }  // paste / multi-move
 *
 * The inverse of:
 *   move   → move(to → from)
 *   create → delete(path)
 *   delete → create(path, content)  // only if content was captured
 *   batch  → reverse each op in reverse order
 *
 * Deletes of untrashed files can be undone ONLY if we captured the
 * content before deletion. That's the `deleteRecoverable` path — we
 * read the file content before unlinking. For folders or untrusted
 * (binary) files we push a non-undoable sentinel that blocks undo
 * past that point (same behavior as VS Code).
 */

import { create } from 'zustand';

const MAX_HISTORY = 100;

export const useFileOpsHistoryStore = create((set, get) => ({
  undoStack: [],
  redoStack: [],

  /** Push a new op. Clears redo (new branch). */
  push: (op) => {
    set((s) => {
      const next = [...s.undoStack, op];
      const trimmed = next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
      return { undoStack: trimmed, redoStack: [] };
    });
  },

  /**
   * Undo the most recent op. deps = the same shape as clipboardStore.paste
   * plus readFile, writeFile, etc. Returns true on success.
   */
  undo: async (deps) => {
    const s = get();
    if (!s.undoStack.length) return false;
    const op = s.undoStack[s.undoStack.length - 1];
    const ok = await apply(invertOp(op), deps);
    if (!ok) return false;
    set((st) => ({
      undoStack: st.undoStack.slice(0, -1),
      redoStack: [...st.redoStack, op],
    }));
    return true;
  },

  /** Redo the most recent undone op. */
  redo: async (deps) => {
    const s = get();
    if (!s.redoStack.length) return false;
    const op = s.redoStack[s.redoStack.length - 1];
    const ok = await apply(op, deps);
    if (!ok) return false;
    set((st) => ({
      undoStack: [...st.undoStack, op],
      redoStack: st.redoStack.slice(0, -1),
    }));
    return true;
  },

  canUndo: () => get().undoStack.length > 0,
  canRedo: () => get().redoStack.length > 0,

  clear: () => set({ undoStack: [], redoStack: [] }),
}));

function invertOp(op) {
  switch (op.kind) {
    case 'move':
      return { kind: 'move', fromPath: op.toPath, toPath: op.fromPath, entity: op.entity };
    case 'create':
      return { kind: 'delete', path: op.path, entity: op.entity, content: null };
    case 'delete':
      return op.content != null
        ? { kind: 'create', path: op.path, entity: op.entity, content: op.content }
        : { kind: 'nop' };
    case 'batch':
      return { kind: 'batch', ops: [...op.ops].reverse().map(invertOp) };
    default:
      return { kind: 'nop' };
  }
}

async function apply(op, deps) {
  switch (op.kind) {
    case 'move':
      if (op.entity === 'folder') {
        const r = await deps.moveFolder(op.fromPath, op.toPath);
        return r?.ok !== false;
      }
      const rf = await deps.renameFile(op.fromPath, op.toPath);
      return rf?.ok !== false;
    case 'create':
      if (op.entity === 'folder') {
        const r = await deps.createFolder(op.path);
        return r?.ok !== false;
      }
      const rc = await deps.createFile(op.path, op.content || '');
      return rc?.ok !== false;
    case 'delete':
      if (op.entity === 'folder') {
        const r = await deps.deleteFolder(op.path);
        return r?.ok !== false;
      }
      const rd = await deps.deleteFile(op.path);
      return rd?.ok !== false;
    case 'batch': {
      for (const sub of op.ops) {
        const ok = await apply(sub, deps);
        if (!ok) return false;
      }
      return true;
    }
    case 'nop':
      return true;
    default:
      return false;
  }
}
