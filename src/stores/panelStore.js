/**
 * Panel Store — centralized layout state for all dockable panels.
 *
 * Every panel has: mode (docked/floating), dock edge, position, size,
 * visibility, collapse state, z-index. Persists to localStorage.
 */

import { create } from 'zustand';

const STORAGE_KEY = 'hexis-panel-layout';

// Bump this number whenever DEFAULTS changes in a way that would
// break old persisted layouts (adding a panel, renaming one, changing
// a field shape). On load, if the saved `version` is older, the
// layout gets healed via the migration chain in `initPanels`. Old
// raw-dict layouts (pre-versioning) get wrapped transparently.
const LAYOUT_VERSION = 2;

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

// Load + unwrap the persisted layout. Handles three cases:
//   1. Envelope format `{version, layout}` — the current format
//   2. Raw dict (pre-version 2) — wrapped into envelope with version 1
//   3. Missing / malformed — returns null so initPanels uses defaults
// Returns `{ version, layout }` where layout is the panel dict.
function loadLayout() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.layout && typeof parsed.version === 'number') {
      return parsed;
    }
    // Legacy: raw dict of panel entries. Treat as version 1.
    if (parsed && typeof parsed === 'object') {
      return { version: 1, layout: parsed };
    }
    return null;
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: LAYOUT_VERSION,
      layout: slim,
    }));
  } catch { /* ignore */ }
}

// Migration chain: each entry takes an old-version layout dict and
// returns the next-version layout dict. Runs in order until we reach
// LAYOUT_VERSION. Add new migrations here whenever DEFAULTS changes
// in a breaking way.
const MIGRATIONS = {
  // v1 → v2: editor used to dock RIGHT and there was a standalone
  // `explorer` panel. v2 puts editor on the LEFT with embedded
  // explorer sidebar and drops the standalone panel.
  1: (layout) => {
    const next = { ...layout };
    if (next.editor && next.editor.dock === 'right') {
      next.editor = { ...next.editor, dock: 'left', order: 0 };
    }
    if (next.explorer) delete next.explorer;
    return next;
  },
};

function migrateLayout(saved) {
  if (!saved) return null;
  let layout = saved.layout;
  let version = saved.version || 1;
  while (version < LAYOUT_VERSION && MIGRATIONS[version]) {
    layout = MIGRATIONS[version](layout);
    version++;
  }
  return layout;
}

function initPanels() {
  const savedEnvelope = loadLayout();
  const saved = migrateLayout(savedEnvelope);

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

    // Panels whose DEFAULT is "floating" should never be persisted in a
    // docked state — if a user drags them to an edge, that's a session
    // thing, not a layout invariant. On reload, send them back to
    // floating so they can't accidentally hog dock space. This is what
    // broke round 2: the taskboard (default floating) somehow got
    // `dock: left` with `width: 1559` and pushed the hex grid off screen.
    if (def.mode === 'floating' && merged.mode === 'docked') {
      merged.mode = 'floating';
      merged.dock = null;
      merged.width = def.width;
      merged.height = def.height;
      merged.x = def.x;
      merged.y = def.y;
    }

    // Per-panel size heal: bad individual sizes (likely leaked maximize)
    if (def.width != null && merged.width > window.innerWidth * 0.9) merged.width = def.width;
    if (def.height != null && merged.height > window.innerHeight * 0.9) merged.height = def.height;
    panels[id] = merged;
  }

  // Edge-total healer: sum up the persisted widths of every panel docked
  // to `left` (or `right`). If they exceed 85% of window width the layout
  // has visually collapsed — the hex grid ends up pushed off-screen. When
  // that happens, reset every docked panel on that edge to its default
  // width so the user gets a usable layout back instead of an invisible
  // canvas. Same for bottom/height.
  const winW = window.innerWidth;
  const winH = window.innerHeight;
  for (const edge of ['left', 'right']) {
    const docked = Object.entries(panels)
      .filter(([, p]) => p.visible && p.mode === 'docked' && p.dock === edge);
    const totalW = docked.reduce((s, [, p]) => s + (p.width || 0), 0);
    if (totalW > winW * 0.85) {
      for (const [id] of docked) {
        const def = DEFAULTS[id];
        if (def?.width != null) panels[id].width = def.width;
      }
    }
  }
  const dockedBottom = Object.entries(panels)
    .filter(([, p]) => p.visible && p.mode === 'docked' && p.dock === 'bottom');
  const totalH = dockedBottom.reduce((s, [, p]) => s + (p.height || 0), 0);
  if (totalH > winH * 0.8) {
    for (const [id] of dockedBottom) {
      const def = DEFAULTS[id];
      if (def?.height != null) panels[id].height = def.height;
    }
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

  // Bring a docked panel to the front of its dock zone's tab strip.
  // Use this when you want to activate a panel that's already visible
  // but hidden behind another tab (e.g. chat sharing a right dock with
  // AI Agents). Also shows the panel if it was hidden.
  revealPanel: (id) => set(s => {
    const panel = s.panels[id];
    if (!panel) return s;
    const p = { ...s.panels };
    let nextActive = s.activeTab;
    if (!panel.visible) {
      p[id] = { ...panel, visible: true, zIndex: s.nextZIndex };
    } else {
      p[id] = { ...panel, zIndex: s.nextZIndex };
    }
    // If docked, make this panel the active tab in its dock zone
    const dock = panel.dock;
    if (panel.mode === 'docked' && (dock === 'left' || dock === 'right' || dock === 'bottom')) {
      nextActive = { ...s.activeTab, [dock]: id };
    }
    saveLayout(p);
    return {
      panels: p,
      nextZIndex: s.nextZIndex + 1,
      activeTab: nextActive,
      focusedPanel: id,
    };
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
