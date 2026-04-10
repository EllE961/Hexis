/**
 * Layout Anchors Store — per-workspace persistence of user-chosen
 * group positions on the hex grid.
 *
 * Every time the user drags a group and drops it at a new location,
 * we record the destination hex coordinates `(cq, cr)` against that
 * group's path. The freeform layout engine then honors these anchors
 * on subsequent computeLayout runs: anchored groups are placed at
 * their remembered positions, non-anchored groups are auto-placed
 * adjacent to already-placed groups, and collisions/containment are
 * resolved by growing parents and pushing neighbors.
 *
 * Anchors are scoped per-workspace and persisted in localStorage
 * under the key `hexis-anchors-<workspacePath>`. The shape on disk
 * is `{ [groupPath]: [cq, cr] }`.
 */

import { create } from 'zustand';

function storageKey(workspace) {
  if (!workspace || workspace === '__server_locked__') return 'hexis-anchors-default';
  return 'hexis-anchors-' + workspace;
}

function loadFromStorage(workspace) {
  try {
    const raw = localStorage.getItem(storageKey(workspace));
    if (!raw) return new Map();
    const parsed = JSON.parse(raw);
    const out = new Map();
    for (const [path, coords] of Object.entries(parsed)) {
      if (Array.isArray(coords) && coords.length === 2) {
        out.set(path, [Number(coords[0]), Number(coords[1])]);
      }
    }
    return out;
  } catch {
    return new Map();
  }
}

function saveToStorage(workspace, anchors) {
  try {
    const obj = {};
    for (const [path, coords] of anchors) obj[path] = coords;
    localStorage.setItem(storageKey(workspace), JSON.stringify(obj));
  } catch { /* quota exceeded or private mode — drop silently */ }
}

export const useLayoutAnchorsStore = create((set, get) => ({
  /** Which workspace's anchors are currently loaded. */
  currentWorkspace: null,

  /** Map<groupPath, [cq, cr]> — the loaded anchors. */
  anchors: new Map(),

  /** Monotonic revision number — bumped on every mutation so the
      layout memo can cheaply include it in its content hash. */
  revision: 0,

  /** Switch to a different workspace — loads that workspace's anchors
      from localStorage. Call when the user opens a new folder. */
  setWorkspace: (workspace) => {
    if (get().currentWorkspace === workspace) return;
    set({
      currentWorkspace: workspace,
      anchors: loadFromStorage(workspace),
      revision: get().revision + 1,
    });
  },

  /** Remember a group's position. Persists immediately. */
  setAnchor: (groupPath, cq, cr) => {
    if (!groupPath) return;
    const s = get();
    const next = new Map(s.anchors);
    next.set(groupPath, [cq | 0, cr | 0]);
    saveToStorage(s.currentWorkspace, next);
    set({ anchors: next, revision: s.revision + 1 });
  },

  /** Forget a group's anchor (e.g. after it's deleted or the user
      wants the auto-packer to re-place it). */
  clearAnchor: (groupPath) => {
    const s = get();
    if (!s.anchors.has(groupPath)) return;
    const next = new Map(s.anchors);
    next.delete(groupPath);
    saveToStorage(s.currentWorkspace, next);
    set({ anchors: next, revision: s.revision + 1 });
  },

  /** Clear every anchor for the current workspace. */
  clearAll: () => {
    saveToStorage(get().currentWorkspace, new Map());
    set({ anchors: new Map(), revision: get().revision + 1 });
  },

  /** Lookup — returns `[cq, cr] | null`. */
  getAnchor: (groupPath) => {
    const a = get().anchors.get(groupPath);
    return a ? [a[0], a[1]] : null;
  },
}));
