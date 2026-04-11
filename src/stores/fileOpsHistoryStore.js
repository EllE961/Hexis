/**
 * File Ops History Store — undo/redo for file-system operations.
 *
 * Every reversible file operation (move, rename, create, delete of
 * trashed items) pushes a record onto the undoStack. Ctrl+Z applies
 * the inverse and moves the record to the redoStack. Ctrl+Shift+Z /
 * Ctrl+Y replays it back.
 *
 * Operation shapes:
 *   { kind: 'move',   fromPath, toPath, entity: 'file'|'folder' }
 *   { kind: 'create', path, entity: 'file'|'folder', content? }
 *   { kind: 'delete', path, entity: 'file'|'folder', content? }
 *   { kind: 'batch',  ops: [ ... ] }  // paste / multi-move / delete-folder
 *
 * The inverse of:
 *   move   → move(to → from)
 *   create → delete(path)
 *   delete → create(path, content)  // only if content was captured
 *   batch  → reverse each op in reverse order
 *
 * Persistence:
 *   Per-workspace undo/redo stacks are saved to localStorage under
 *   `hexis-history:<workspace>`. Total serialized size capped at ~5 MB.
 *   When persisting would exceed the cap, we drop oldest entries until
 *   it fits. This means Ctrl+Z survives reloads (a VS-Code feature that
 *   doesn't even exist in VS Code for file ops — Hexis goes further).
 *
 * Delete-content capture:
 *   The App.jsx delete paths read file content BEFORE unlinking and
 *   pass it here via `push({kind:'delete', content, ...})`. Content
 *   larger than MAX_CONTENT_BYTES is stored as `null` with an
 *   `unrestorable: true` flag — undo of those ops shows a toast and
 *   skips the restoration.
 *
 * Folder deletes:
 *   A folder delete is pushed as a `batch` containing a `delete` for
 *   every file in the subtree, so one Ctrl+Z restores the whole tree.
 *   The folder itself is not in the batch — directories are implicit
 *   from file paths (create-file mkdir -p's the parent).
 */

import { create } from 'zustand';

const MAX_HISTORY = 200;
const STORAGE_PREFIX = 'hexis-history:';
const MAX_STORAGE_BYTES = 5 * 1024 * 1024; // 5 MB total cap per workspace
export const MAX_CONTENT_BYTES = 1 * 1024 * 1024; // 1 MB per file for content capture

function storageKey(workspace) {
  return STORAGE_PREFIX + (workspace || 'default');
}

function loadFromStorage(workspace) {
  try {
    const raw = localStorage.getItem(storageKey(workspace));
    if (!raw) return { undoStack: [], redoStack: [] };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { undoStack: [], redoStack: [] };
    return {
      undoStack: Array.isArray(parsed.undoStack) ? parsed.undoStack : [],
      redoStack: Array.isArray(parsed.redoStack) ? parsed.redoStack : [],
    };
  } catch {
    return { undoStack: [], redoStack: [] };
  }
}

function saveToStorage(workspace, undoStack, redoStack) {
  try {
    // Serialize and drop oldest entries until we fit under the cap
    let u = [...undoStack];
    let r = [...redoStack];
    for (let tries = 0; tries < 50; tries++) {
      const json = JSON.stringify({ undoStack: u, redoStack: r });
      if (json.length <= MAX_STORAGE_BYTES) {
        localStorage.setItem(storageKey(workspace), json);
        return;
      }
      // Drop the oldest entry (undo-stack front) first, then redo-stack front
      if (u.length > 0) u = u.slice(1);
      else if (r.length > 0) r = r.slice(1);
      else break;
    }
  } catch {
    /* quota exceeded or private mode — drop silently */
  }
}

function removeFromStorage(workspace) {
  try { localStorage.removeItem(storageKey(workspace)); } catch {}
}

/** Label an op for the UI (menu items, history panel). */
export function labelForOp(op) {
  if (!op) return '';
  if (op.kind === 'batch') {
    const first = op.ops?.[0];
    const n = op.ops?.length || 0;
    return `${n} item${n === 1 ? '' : 's'}${first ? ' — ' + labelForOp(first) : ''}`;
  }
  const leaf = (p) => (p || '').split('/').pop() || p;
  switch (op.kind) {
    case 'move': {
      const fromLeaf = leaf(op.fromPath);
      const toLeaf = leaf(op.toPath);
      return fromLeaf === toLeaf
        ? `Move ${fromLeaf}`
        : `Rename ${fromLeaf} → ${toLeaf}`;
    }
    case 'create': return `Create ${leaf(op.path)}`;
    case 'delete': return `Delete ${leaf(op.path)}`;
    default: return op.kind;
  }
}

export const useFileOpsHistoryStore = create((set, get) => ({
  workspace: null,
  undoStack: [],
  redoStack: [],
  revision: 0, // bumped on every mutation so UI selectors recompute

  /** Load persisted history when workspace changes. */
  setWorkspace: (workspace) => {
    if (get().workspace === workspace) return;
    const { undoStack, redoStack } = loadFromStorage(workspace);
    set({ workspace, undoStack, redoStack, revision: get().revision + 1 });
  },

  /** Push a new op. Clears redo (new branch). Persists. */
  push: (op) => {
    if (!op || op.kind === 'nop') return;
    set((s) => {
      const next = [...s.undoStack, op];
      const trimmed = next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
      saveToStorage(s.workspace, trimmed, []);
      return { undoStack: trimmed, redoStack: [], revision: s.revision + 1 };
    });
  },

  /**
   * Undo the most recent op. `deps` exposes the backend FS operations
   * the apply layer uses to execute inverses. Returns true on success.
   */
  undo: async (deps) => {
    const s = get();
    if (!s.undoStack.length) return false;
    const op = s.undoStack[s.undoStack.length - 1];
    const inverse = invertOp(op);
    if (inverse.kind === 'nop') {
      // Non-restorable — pop it so user can move past, but warn
      if (typeof deps.onUnrestorable === 'function') {
        deps.onUnrestorable(op);
      } else if (typeof window !== 'undefined' && window.console) {
        console.warn('[history] cannot undo unrestorable op', op);
      }
      set((st) => {
        const nextUndo = st.undoStack.slice(0, -1);
        saveToStorage(st.workspace, nextUndo, st.redoStack);
        return { undoStack: nextUndo, revision: st.revision + 1 };
      });
      return false;
    }
    const ok = await apply(inverse, deps);
    if (!ok) return false;
    set((st) => {
      const nextUndo = st.undoStack.slice(0, -1);
      const nextRedo = [...st.redoStack, op];
      saveToStorage(st.workspace, nextUndo, nextRedo);
      return {
        undoStack: nextUndo,
        redoStack: nextRedo,
        revision: st.revision + 1,
      };
    });
    return true;
  },

  /** Redo the most recent undone op. */
  redo: async (deps) => {
    const s = get();
    if (!s.redoStack.length) return false;
    const op = s.redoStack[s.redoStack.length - 1];
    const ok = await apply(op, deps);
    if (!ok) return false;
    set((st) => {
      const nextUndo = [...st.undoStack, op];
      const nextRedo = st.redoStack.slice(0, -1);
      saveToStorage(st.workspace, nextUndo, nextRedo);
      return {
        undoStack: nextUndo,
        redoStack: nextRedo,
        revision: st.revision + 1,
      };
    });
    return true;
  },

  canUndo: () => get().undoStack.length > 0,
  canRedo: () => get().redoStack.length > 0,

  /** Label of the most recent undoable op, e.g. "Undo Create foo.js". */
  getUndoLabel: () => {
    const op = get().undoStack[get().undoStack.length - 1];
    return op ? `Undo ${labelForOp(op)}` : 'Undo';
  },
  getRedoLabel: () => {
    const op = get().redoStack[get().redoStack.length - 1];
    return op ? `Redo ${labelForOp(op)}` : 'Redo';
  },

  clear: () => set((s) => {
    removeFromStorage(s.workspace);
    return { undoStack: [], redoStack: [], revision: s.revision + 1 };
  }),
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
        : { kind: 'nop', unrestorable: true, reason: `Cannot restore ${op.path}` };
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
