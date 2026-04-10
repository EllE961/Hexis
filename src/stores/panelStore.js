/**
 * Panel Store — centralized layout state for all dockable panels.
 *
 * Every panel has: mode (docked/floating), dock edge, position, size,
 * visibility, collapse state, z-index. Persists to localStorage.
 */

import { create } from 'zustand';

const STORAGE_KEY = 'hexis-panel-layout';

const DEFAULTS = {
  // The editor docks to the LEFT now; the hex grid fills the remaining
  // center area. This matches VS Code's muscle memory and lets the
  // embedded file tree sidebar share the same left half.
  editor:    { mode: 'docked', dock: 'left',   width: 820, height: null, x: 0, y: 0, visible: false, zIndex: 30, order: 0, minWidth: 350, minHeight: 200, maximized: false, preMaxState: null, edgeCollapsed: false },
  // Secondary panels dock to the RIGHT so they don't fight the editor
  // for real estate.
  ai:        { mode: 'docked', dock: 'right',  width: 480, height: null, x: 0, y: 0, visible: false, zIndex: 30, order: 0, minWidth: 320, minHeight: 200, maximized: false, preMaxState: null, edgeCollapsed: false },
  // Chat mode: "Claude Code directly inside Hexis" — one-shot conversational
  // agent. Defaults to visible because it's the primary day-to-day interface.
  chat:      { mode: 'docked', dock: 'right',  width: 520, height: null, x: 0, y: 0, visible: true,  zIndex: 30, order: 0, minWidth: 360, minHeight: 240, maximized: false, preMaxState: null, edgeCollapsed: false },
  git:       { mode: 'docked', dock: 'right',  width: 360, height: null, x: 0, y: 0, visible: false, zIndex: 30, order: 1, minWidth: 280, minHeight: 200, maximized: false, preMaxState: null, edgeCollapsed: false },
  search:    { mode: 'docked', dock: 'right',  width: 420, height: null, x: 0, y: 0, visible: false, zIndex: 30, order: 2, minWidth: 280, minHeight: 200, maximized: false, preMaxState: null, edgeCollapsed: false },
  bookmarks: { mode: 'docked', dock: 'right',  width: 340, height: null, x: 0, y: 0, visible: false, zIndex: 30, order: 3, minWidth: 260, minHeight: 200, maximized: false, preMaxState: null, edgeCollapsed: false },
  history:   { mode: 'docked', dock: 'right',  width: 340, height: null, x: 0, y: 0, visible: false, zIndex: 30, order: 4, minWidth: 260, minHeight: 200, maximized: false, preMaxState: null, edgeCollapsed: false },
  terminal:  { mode: 'docked', dock: 'bottom', width: null, height: 260, x: 0, y: 0, visible: false, zIndex: 30, order: 0, minWidth: 300, minHeight: 120, maximized: false, preMaxState: null, edgeCollapsed: false },
  timeline:  { mode: 'docked', dock: 'bottom', width: null, height: 80,  x: 0, y: 0, visible: false, zIndex: 30, order: 1, minWidth: 300, minHeight: 60,  maximized: false, preMaxState: null, edgeCollapsed: false },
  taskboard: { mode: 'floating', dock: null,   width: 1050, height: 650, x: 'center', y: 'center', visible: false, zIndex: 30, order: 0, minWidth: 600, minHeight: 400, maximized: false, preMaxState: null, edgeCollapsed: false },
};

function loadLayout() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function saveLayout(panels) {
  try {
    // Only persist layout-relevant fields, not minWidth/minHeight or transient maximize state
    const slim = {};
    for (const [id, p] of Object.entries(panels)) {
      // If maximized, persist the preMaxState dimensions, not the current (screen-sized) ones
      const effective = p.maximized && p.preMaxState
        ? { ...p, ...p.preMaxState, maximized: false, preMaxState: null }
        : p;
      slim[id] = {
        mode: effective.mode, dock: effective.dock,
        width: effective.width, height: effective.height,
        x: effective.x, y: effective.y,
        visible: effective.visible, order: effective.order,
      };
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
  } catch { /* ignore */ }
}

function initPanels() {
  const saved = loadLayout();

  // One-shot migration: the editor used to dock RIGHT and the explorer
  // was a standalone left panel. The new layout puts the editor on the
  // LEFT (with the embedded explorer sidebar inside) and drops the
  // stand-alone `explorer` panel. Heal both on first load after upgrade.
  const MIGRATION_KEY = 'hexis-editor-migrated-to-left';
  let didMigrate = false;
  try { didMigrate = localStorage.getItem(MIGRATION_KEY) === '1'; } catch {}
  if (!didMigrate && saved) {
    if (saved.editor && saved.editor.dock === 'right') {
      saved.editor = { ...saved.editor, dock: 'left', order: 0 };
    }
    // Drop stale `explorer` entry — it lives inside the editor now
    if (saved.explorer) delete saved.explorer;
    try { localStorage.setItem(MIGRATION_KEY, '1'); } catch {}
  }

  const panels = {};
  for (const [id, def] of Object.entries(DEFAULTS)) {
    const merged = { ...def, ...(saved?.[id] || {}) };
    // Always start runtime-only flags fresh
    merged.maximized = false;
    merged.preMaxState = null;
    // Default missing flags
    if (merged.edgeCollapsed === undefined) merged.edgeCollapsed = false;
    // Drop legacy flags
    delete merged.collapsed;
    // Heal bad sizes: if persisted size is near screen dimensions (likely leaked maximize),
    // reset to the default for that panel
    if (def.width != null && merged.width > window.innerWidth * 0.9) merged.width = def.width;
    if (def.height != null && merged.height > window.innerHeight * 0.9) merged.height = def.height;
    panels[id] = merged;
  }
  return panels;
}

export const usePanelStore = create((set, get) => ({
  panels: initPanels(),
  nextZIndex: 40,
  dockPreview: null, // { edge, panelId } during drag
  // Active tab per dock zone (for tab support when 2+ panels share a zone)
  activeTab: { left: null, right: null, bottom: null },
  setActiveTab: (zone, panelId) => set(s => ({
    activeTab: { ...s.activeTab, [zone]: panelId },
  })),

  // ─── Visibility ───
  toggleVisible: (id) => set(s => {
    const p = { ...s.panels };
    p[id] = { ...p[id], visible: !p[id].visible };
    if (p[id].visible) p[id].zIndex = s.nextZIndex;
    saveLayout(p);
    return { panels: p, nextZIndex: p[id].visible ? s.nextZIndex + 1 : s.nextZIndex };
  }),

  showPanel: (id) => set(s => {
    if (s.panels[id]?.visible) return s;
    const p = { ...s.panels };
    p[id] = { ...p[id], visible: true, zIndex: s.nextZIndex };
    saveLayout(p);
    return { panels: p, nextZIndex: s.nextZIndex + 1 };
  }),

  hidePanel: (id) => set(s => {
    if (!s.panels[id]?.visible) return s;
    const p = { ...s.panels };
    p[id] = { ...p[id], visible: false };
    saveLayout(p);
    return { panels: p };
  }),

  // ─── Focus ───
  focusedPanel: null,
  focusPanel: (id) => set(s => {
    const p = { ...s.panels };
    p[id] = { ...p[id], zIndex: s.nextZIndex };
    return { panels: p, nextZIndex: s.nextZIndex + 1, focusedPanel: id };
  }),

  // ─── Edge collapse (collapse docked panel to a narrow strip on its dock side) ───
  toggleEdgeCollapse: (id) => set(s => {
    const panel = s.panels[id];
    if (!panel) return s;
    const p = { ...s.panels };
    p[id] = { ...panel, edgeCollapsed: !panel.edgeCollapsed };
    saveLayout(p);
    return { panels: p };
  }),

  // ─── Maximize ───
  toggleMaximize: (id) => set(s => {
    const panel = s.panels[id];
    if (!panel) return s;
    const p = { ...s.panels };
    if (panel.maximized) {
      // Restore from preMaxState
      const pre = panel.preMaxState || {};
      p[id] = { ...panel, ...pre, maximized: false, preMaxState: null };
    } else {
      // Save current state and go fullscreen floating
      p[id] = {
        ...panel,
        maximized: true,
        preMaxState: {
          mode: panel.mode, dock: panel.dock,
          x: panel.x, y: panel.y,
          width: panel.width, height: panel.height,
        },
        mode: 'floating',
        dock: null,
      };
    }
    saveLayout(p);
    return { panels: p, focusedPanel: id };
  }),

  // ─── Update position/size ───
  updatePanel: (id, updates) => set(s => {
    const p = { ...s.panels };
    p[id] = { ...p[id], ...updates };
    saveLayout(p);
    return { panels: p };
  }),

  // ─── Docking ───
  dockPanel: (id, edge) => set(s => {
    const p = { ...s.panels };
    // Find max order at this edge
    let maxOrder = -1;
    let hadSiblings = false;
    for (const [pid, panel] of Object.entries(p)) {
      if (panel.dock === edge && panel.visible && pid !== id) {
        maxOrder = Math.max(maxOrder, panel.order);
        hadSiblings = true;
      }
    }
    p[id] = { ...p[id], mode: 'docked', dock: edge, order: maxOrder + 1 };
    saveLayout(p);
    // If joining an existing zone, auto-activate this panel as the visible tab
    const next = { panels: p };
    if (hadSiblings && (edge === 'left' || edge === 'right' || edge === 'bottom')) {
      next.activeTab = { ...s.activeTab, [edge]: id };
    }
    return next;
  }),

  undockPanel: (id, x, y) => set(s => {
    const p = { ...s.panels };
    p[id] = { ...p[id], mode: 'floating', dock: null, x: x || 100, y: y || 100 };
    saveLayout(p);
    return { panels: p };
  }),

  // ─── Dock preview ───
  setDockPreview: (preview) => set({ dockPreview: preview }),

  // ─── Selectors ───
  getDockedPanels: (edge) => {
    const { panels } = get();
    return Object.entries(panels)
      .filter(([, p]) => p.visible && p.mode === 'docked' && p.dock === edge)
      .sort((a, b) => a[1].order - b[1].order)
      .map(([id, p]) => ({ id, ...p }));
  },

  getFloatingPanels: () => {
    const { panels } = get();
    return Object.entries(panels)
      .filter(([, p]) => p.visible && p.mode === 'floating')
      .sort((a, b) => a[1].zIndex - b[1].zIndex)
      .map(([id, p]) => ({ id, ...p }));
  },

  // ─── Reset ───
  resetLayout: () => {
    localStorage.removeItem(STORAGE_KEY);
    set({ panels: { ...DEFAULTS }, nextZIndex: 40 });
  },
}));
