/**
 * HexCanvas — the core hex grid renderer.
 * Direct Canvas2D. Handles rendering, viewport, hit testing, interaction.
 */

import { useRef, useEffect, useCallback, useState, forwardRef, useImperativeHandle } from 'react';
import { Viewport } from './Viewport.js';
import { hexToPixel, pixelToHex, getVisibleHexRange, isHexVisible, hexNeighbors, hexPath } from '../utils/hexMath.js';
import { computeLayout } from '../utils/hexLayout.js';
import { drawCell, drawEmptyCell } from './CellRenderer.js';
import { drawGroups, drawGroupLabels, drawGroupHighlight, drawBreadcrumbSpine } from './GroupRenderer.js';
import { BeeSystem } from './BeeSystem.js';
import { CellAnimator } from './CellAnimator.js';
import { LayoutAnimator } from './LayoutAnimator.js';
import { makeCellDragState, computeDropTarget, computeDestinationPath } from './CellDrag.js';
import { useSearchStore } from '../../stores/searchStore.js';
import { useLayoutStateStore } from '../../stores/layoutStateStore.js';

const HEX_SIZE = 30; // global grid cell size
const BG_COLOR = '#0D1117';

// Top-level folder colors — saturated, high contrast on dark bg
const SECTION_PALETTE = [
  '#E07020', '#C0A020', '#D06030', '#D0A020', '#90A040',
  '#808A70', '#C08030', '#70A040', '#B06040', '#609060',
];

// Sub-folder color shifts — vary hue/brightness from parent
const SUB_SHIFTS = [
  { h: 15, s: -10, l: 8 },   // warmer + lighter
  { h: -20, s: 5, l: -5 },   // cooler + darker
  { h: 30, s: -5, l: 12 },   // much warmer + brighter
  { h: -10, s: 10, l: -10 }, // slightly cool + darker
  { h: 25, s: 0, l: 5 },     // warm shift
  { h: -30, s: -5, l: 8 },   // cool + lighter
];

/** Shift a hex color by HSL delta */
function shiftColor(hex, dh, ds, dl) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  h = ((h * 360 + dh) % 360 + 360) % 360 / 360;
  s = Math.max(0, Math.min(1, s + ds / 100));
  l = Math.max(0.1, Math.min(0.9, l + dl / 100));
  // HSL to RGB
  const hue2rgb = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1/6) return p + (q - p) * 6 * t; if (t < 1/2) return q; if (t < 2/3) return p + (q - p) * (2/3 - t) * 6; return p; };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ro = Math.round(hue2rgb(p, q, h + 1/3) * 255);
  const go2 = Math.round(hue2rgb(p, q, h) * 255);
  const bo = Math.round(hue2rgb(p, q, h - 1/3) * 255);
  return `#${ro.toString(16).padStart(2,'0')}${go2.toString(16).padStart(2,'0')}${bo.toString(16).padStart(2,'0')}`;
}

/** Get mouse position relative to canvas in CSS pixels */
function getMousePos(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

/** Draw flight plan lines from hive to target cells when plan is awaiting approval */
function drawFlightPlan(ctx, subtasks, layout, hiveX, hiveY) {
  const now = Date.now();
  const colors = ['#F59E0B', '#F0A030', '#D4760A', '#14B8A6', '#3B82F6', '#A855F7'];

  for (let i = 0; i < subtasks.length; i++) {
    const st = subtasks[i];
    const color = colors[i % colors.length];

    for (const filePath of (st.files || [])) {
      const cell = layout.cells.get(filePath);
      if (!cell) continue;

      // Dashed line from hive to cell
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = color + '40'; // 25% opacity
      ctx.lineWidth = 1.5;

      // Slight curve via bezier control point
      const midX = (hiveX + cell.x) / 2;
      const midY = (hiveY + cell.y) / 2;
      const dist = Math.hypot(cell.x - hiveX, cell.y - hiveY);
      const perpX = -(cell.y - hiveY) / dist * dist * 0.15;
      const perpY = (cell.x - hiveX) / dist * dist * 0.15;

      ctx.beginPath();
      ctx.moveTo(hiveX, hiveY);
      ctx.quadraticCurveTo(midX + perpX, midY + perpY, cell.x, cell.y);
      ctx.stroke();

      // Glow ring on target cell
      const pulse = Math.sin(now * 0.003 + i) * 0.3 + 0.7;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(cell.x, cell.y, 22, 0, Math.PI * 2);
      ctx.strokeStyle = color + Math.round(pulse * 60).toString(16).padStart(2, '0');
      ctx.lineWidth = 2 * pulse;
      ctx.stroke();

      ctx.restore();
    }
  }

  // Small hive indicator
  ctx.save();
  ctx.beginPath();
  ctx.arc(hiveX, hiveY, 6, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(240, 160, 48, 0.4)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(240, 160, 48, 0.6)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

const HexCanvas = forwardRef(function HexCanvas({ files, groups, onCellClick, onCellDoubleClick, onCellHover, onCellContextMenu, onCellDrop, onOSDrop, onBeeClick, selectedCell, selectedCells, cellActivity, activeAgents, pendingPlan }, ref) {
  const canvasRef = useRef(null);
  const viewportRef = useRef(null);
  const layoutRef = useRef(null);
  const animFrameRef = useRef(null);
  const hoveredCellRef = useRef(null);
  const sectionColorsRef = useRef({});
  const mouseDownRef = useRef(null); // { x, y, time }
  const initialFitDoneRef = useRef(false);
  const beeSystemRef = useRef(new BeeSystem());
  const cellAnimatorRef = useRef(new CellAnimator());
  const layoutAnimatorRef = useRef(new LayoutAnimator());
  const prevActivityRef = useRef(new Map());
  // Hover chain pulse state: which innermost group is active and when it started
  const hoverPulseRef = useRef({ innermost: null, startTime: 0 });
  // Search match cache — updated on every search store change; read by render loop
  const searchMatchesRef = useRef({ map: new Map(), startTime: 0 });
  // Recent drop glow — map<path, {startTime, kind}> for 5s landing glow
  const recentDropsRef = useRef(new Map());
  // Cell/group drag state. All drag coordinates + drop target live in
  // this ref so the render loop can read them each frame WITHOUT causing
  // React re-renders during drag. Populated by onPointerDown/Move/Up.
  const cellDragRef = useRef(makeCellDragState());
  const [, forceRender] = useState(0);

  // ── Camera focus helpers (used by double-click AND imperative handle) ──

  /**
   * Zoom the camera in on a file cell or group region with an elastic
   * bounce. Retries for up to ~500 ms if the target isn't in the layout
   * yet — lets callers fire-and-forget immediately after an optimistic
   * file/folder creation without waiting for React to commit the layout.
   *
   * If `opts.anchorSx` / `opts.anchorSy` are supplied (canvas-local screen
   * coords), the zoom keeps the target under THAT screen point instead of
   * centering on it — used for double-click where we want the clicked hex
   * to stay under the mouse as the camera zooms in around it.
   */
  const zoomToItemImpl = useCallback((path, kind = 'file', opts = {}) => {
    if (!path) return;
    const anchored = opts.anchorSx != null && opts.anchorSy != null;
    const attempt = (retries) => {
      const vp = viewportRef.current;
      const layout = layoutRef.current;
      if (!vp || !layout) return;

      if (kind === 'file') {
        const cell = layout.cells.get(path);
        if (!cell) {
          if (retries > 0) {
            requestAnimationFrame(() => attempt(retries - 1));
          }
          return;
        }
        if (opts.instant) {
          vp.x = vp.tx = cell.x;
          vp.y = vp.ty = cell.y;
          vp.zoom = vp.tz = 2.0;
        } else if (anchored) {
          // Keep the clicked cell under the mouse as the camera zooms in
          vp.zoomToAnchored(cell.x, cell.y, 2.0, opts.anchorSx, opts.anchorSy);
        } else {
          vp.centerOnWithOvershoot(cell.x, cell.y, 2.0);
        }
      } else {
        const folder = layout.folders.get(path);
        if (!folder) {
          if (retries > 0) {
            requestAnimationFrame(() => attempt(retries - 1));
          }
          return;
        }
        const padding = HEX_SIZE * 2;
        const extent = folder.ring * HEX_SIZE * 2 + padding;
        const minX = folder.x - extent;
        const maxX = folder.x + extent;
        const minY = folder.y - extent;
        const maxY = folder.y + extent;
        if (opts.instant) {
          vp.fitBounds(minX, minY, maxX, maxY, padding);
        } else if (anchored) {
          // Pick a zoom that fits the folder, then anchor it under the
          // mouse so the clicked region stays in place.
          const rangeX = (maxX - minX) + padding * 2;
          const rangeY = (maxY - minY) + padding * 2;
          const targetZoom = Math.min(vp.width / rangeX, vp.height / rangeY);
          vp.zoomToAnchored(folder.x, folder.y, targetZoom, opts.anchorSx, opts.anchorSy);
        } else {
          vp.fitBoundsAnimated(minX, minY, maxX, maxY, padding);
        }
      }
    };
    // Up to ~30 frames (~500 ms at 60fps) so optimistic creates land cleanly.
    attempt(30);
  }, []);

  /** If the item is offscreen, pan to it (no zoom change). */
  const ensureVisibleImpl = useCallback((path, kind = 'file') => {
    if (!path) return;
    const attempt = (retries) => {
      const vp = viewportRef.current;
      const layout = layoutRef.current;
      if (!vp || !layout) return;
      let wx, wy;
      if (kind === 'file') {
        const cell = layout.cells.get(path);
        if (!cell) {
          if (retries > 0) requestAnimationFrame(() => attempt(retries - 1));
          return;
        }
        wx = cell.x;
        wy = cell.y;
      } else {
        const folder = layout.folders.get(path);
        if (!folder) {
          if (retries > 0) requestAnimationFrame(() => attempt(retries - 1));
          return;
        }
        wx = folder.x;
        wy = folder.y;
      }
      if (!vp.isVisible(wx, wy, 60)) {
        vp.centerOn(wx, wy);
      }
    };
    attempt(30);
  }, []);

  /** Fit all content in view with a smooth animated transition. */
  const zoomToFitAll = useCallback(() => {
    const vp = viewportRef.current;
    const layout = layoutRef.current;
    if (!vp || !layout) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    if (layout.folders?.size > 0) {
      for (const f of layout.folders.values()) {
        minX = Math.min(minX, f.x - f.radius);
        minY = Math.min(minY, f.y - f.radius);
        maxX = Math.max(maxX, f.x + f.radius);
        maxY = Math.max(maxY, f.y + f.radius);
      }
    } else {
      for (const c of layout.cells.values()) {
        minX = Math.min(minX, c.x); minY = Math.min(minY, c.y);
        maxX = Math.max(maxX, c.x); maxY = Math.max(maxY, c.y);
      }
    }
    if (minX !== Infinity) vp.fitBoundsAnimated(minX, minY, maxX, maxY, HEX_SIZE * 3);
  }, []);

  // Expose imperative methods to App.jsx (drop glow trigger + hard refresh + camera)
  useImperativeHandle(ref, () => ({
    /**
     * Start a 5-second landing glow on the given file or group path.
     * Called after a successful drop so the user can see where the item
     * landed. White pulsing — distinct from search glow (amber) and
     * hover ring cascade (depth-ranked).
     */
    markRecentDrop: (path, kind = 'file') => {
      if (!path) return;
      recentDropsRef.current.set(path, { startTime: performance.now(), kind });
      forceRender(n => n + 1); // kick the render loop
    },
    /**
     * Invalidate the layout cache + force full recompute with no saved
     * hints. Called by the View → Re-optimize Hex Layout menu.
     */
    hardRefresh: () => {
      layoutHashRef.current = '';
      forceRender(n => n + 1);
    },
    /** Zoom in on a file or group with an elastic overshoot. */
    zoomToItem: (path, kind = 'file', opts = {}) => zoomToItemImpl(path, kind, opts),
    /** Pan to a file or group only if it's offscreen (no zoom change). */
    ensureVisible: (path, kind = 'file') => ensureVisibleImpl(path, kind),
    /** Fit the entire layout in view (smooth animated). */
    zoomToFitAll: () => zoomToFitAll(),
  }), [zoomToItemImpl, ensureVisibleImpl, zoomToFitAll]);

  // Neutral stone tone for root-level files — they are not a group,
  // so they should read visually distinct from any honey-colored cluster.
  const ROOT_FILE_COLOR = '#6C7680';

  let colorIdx = 0;
  let subColorCounters = {};
  function getSectionColor(groupPath) {
    if (sectionColorsRef.current[groupPath]) return sectionColorsRef.current[groupPath];

    // Root is not a group — ungrouped neutral.
    if (groupPath === '.' || !groupPath) {
      sectionColorsRef.current[groupPath] = ROOT_FILE_COLOR;
      return ROOT_FILE_COLOR;
    }

    const parts = groupPath.split('/');
    const section = parts[0] || groupPath;

    if (parts.length <= 1) {
      // Top-level: assign from palette
      sectionColorsRef.current[groupPath] = SECTION_PALETTE[colorIdx % SECTION_PALETTE.length];
      colorIdx++;
    } else {
      // Nested: inherit from parent + shift by depth
      const parentPath = parts.slice(0, -1).join('/');
      const parentColor = getSectionColor(parentPath || section);
      const depth = parts.length - 1;

      // Each sibling at same depth gets a different shift
      const counterKey = parentPath || section;
      if (!subColorCounters[counterKey]) subColorCounters[counterKey] = 0;
      const siblingIdx = subColorCounters[counterKey]++;

      // Shift: hue +8° per depth + sibling variation, saturation +5%, lightness -5%
      const hueShift = 15 * depth + siblingIdx * 25;
      const satShift = 8 * depth;
      const lightShift = -12 * depth;
      sectionColorsRef.current[groupPath] = shiftColor(parentColor, hueShift, satShift, lightShift);
    }

    return sectionColorsRef.current[groupPath];
  }

  // ─── Subscribe to workspace-search results so matched cells can glow ───
  useEffect(() => {
    const update = (results) => {
      const map = new Map();
      for (const r of results || []) {
        map.set(r.path, (map.get(r.path) || 0) + 1);
      }
      const previous = searchMatchesRef.current.map;
      // Reset startTime only when the set of matched files actually changes
      const sameKeys =
        previous.size === map.size &&
        [...map.keys()].every((k) => previous.has(k));
      searchMatchesRef.current = {
        map,
        startTime: sameKeys ? searchMatchesRef.current.startTime : performance.now(),
      };
    };
    // Seed with current
    update(useSearchStore.getState().results);
    const unsub = useSearchStore.subscribe((state) => update(state.results));
    return unsub;
  }, []);

  // ─── Canvas init + resize ───
  // Canvas pixel size = CSS size (no DPR scaling in JS — browser handles it)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    viewportRef.current = new Viewport(rect.width, rect.height);

    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        canvas.width = e.contentRect.width;
        canvas.height = e.contentRect.height;
        viewportRef.current?.resize(e.contentRect.width, e.contentRect.height);
      }
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  // ─── OS drag-in (files dropped from File Explorer / Finder) ───
  // Tauri v2 fires window-level drag-drop events with absolute paths.
  // Web mode uses native HTML DataTransfer. Both report the target
  // group via hitTestRich so files land in the group under the cursor.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !onOSDrop) return;

    const IS_TAURI = typeof window !== 'undefined' && window.__TAURI_INTERNALS__;

    // Helper: translate a screen coordinate to a target group path
    const groupAtScreen = (clientX, clientY) => {
      const vp = viewportRef.current;
      const layout = layoutRef.current;
      if (!vp || !layout) return '.';
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const world = vp.screenToWorld(x, y);
      const hex = pixelToHex(world.x, world.y, HEX_SIZE);
      const owner = layout.cellOwner?.get(`${hex.q},${hex.r}`);
      if (owner?.kind === 'empty') return owner.groupPath || '.';
      if (owner?.kind === 'file') {
        const file = layout._fileMap?.get(owner.filePath);
        return file?.group_path || '.';
      }
      return '.';
    };

    if (IS_TAURI) {
      // Tauri path: listen for onDragDropEvent
      let unlisten = null;
      (async () => {
        try {
          const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
          const win = getCurrentWebviewWindow();
          unlisten = await win.onDragDropEvent((event) => {
            if (event.payload.type !== 'drop') return;
            const paths = event.payload.paths || [];
            if (!paths.length) return;
            // Tauri drop positions are { x, y } in CSS pixels from the
            // window's top-left. Use them to find the target group.
            const pos = event.payload.position || { x: 0, y: 0 };
            const targetGroup = groupAtScreen(pos.x, pos.y);
            onOSDrop({ kind: 'tauri', paths, targetGroup });
          });
        } catch (err) {
          console.warn('[os-drop] Tauri listener failed:', err);
        }
      })();
      return () => { if (unlisten) { try { unlisten(); } catch {} } };
    }

    // Web path: DOM drag events on the canvas element
    const onDragOver = (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = async (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      const targetGroup = groupAtScreen(e.clientX, e.clientY);
      const files = Array.from(e.dataTransfer.files);
      onOSDrop({ kind: 'web', files, targetGroup });
    };
    canvas.addEventListener('dragover', onDragOver);
    canvas.addEventListener('drop', onDrop);
    return () => {
      canvas.removeEventListener('dragover', onDragOver);
      canvas.removeEventListener('drop', onDrop);
    };
  }, [onOSDrop]);

  // ─── Layout ───
  // Content-hash memoization: skip recompute when the file/group paths
  // + groupings are unchanged. Only structural changes invalidate the
  // layout — git status, modified time, etc. do NOT cause recompute.
  //
  // The hash is ORDER-INDEPENDENT (we sort path lists before hashing)
  // so a re-fetch that returns the same files in a different order
  // doesn't trigger a pointless rebuild.
  //
  // We deliberately DO NOT include layoutRevision in the hash:
  //   - Normal saves bump revision but leave paths unchanged — we want
  //     those to skip.
  //   - Hard-refresh calls `hexCanvasRef.current.hardRefresh()` which
  //     imperatively clears `layoutHashRef.current = ''`, so the next
  //     effect run ALWAYS recomputes regardless of the hash.
  const layoutHashRef = useRef('');
  // Still subscribe to revision — on hard-refresh, revision bumps and
  // re-runs this effect, which then trips the cleared hashRef.
  const layoutRevision = useLayoutStateStore(s => s.revision);
  useEffect(() => {
    if (files.length === 0) return;
    // Cheap content hash (order-independent)
    const fileKeys = files
      .map((f) => `${f.path}:${f.group_path || ''}${f.is_landmark ? '*' : ''}`)
      .sort();
    const groupKeys = groups
      .map((g) => `${g.path}:${g.parent_path || ''}`)
      .sort();
    let hash = `${files.length}|${groups.length}`;
    for (const k of fileKeys) hash += `|${k}`;
    for (const k of groupKeys) hash += `|${k}`;
    if (hash === layoutHashRef.current && layoutRef.current) {
      // Same inputs — nothing to do. Refresh _fileMap references
      // in case file objects themselves were mutated (git status enrichment).
      layoutRef.current._fileMap = new Map();
      for (const f of files) layoutRef.current._fileMap.set(f.path, f);
      return;
    }
    layoutHashRef.current = hash;
    // Snapshot OUTGOING positions so we can animate into the new layout
    layoutAnimatorRef.current.snapshot(layoutRef.current?.cells);
    // Pass saved state (if any) as hints for visual stability
    const savedState = useLayoutStateStore.getState().state;
    const layout = computeLayout(files, groups, HEX_SIZE, savedState);
    layoutRef.current = layout;
    // Persist the fresh state for next round-trip (fire-and-forget).
    // Using setTimeout avoids a render cycle inside this effect.
    if (layout._savedState) {
      setTimeout(() => {
        useLayoutStateStore.getState().save(layout._savedState);
      }, 0);
    }
    // Begin transitioning from old positions to new ones
    layoutAnimatorRef.current.transition(layout.cells, performance.now());
    // Pre-build file map
    layout._fileMap = new Map();
    for (const f of files) layout._fileMap.set(f.path, f);

    // Only fit bounds on first layout — don't reset camera on git status updates
    const vp = viewportRef.current;
    if (vp && !initialFitDoneRef.current) {
      initialFitDoneRef.current = true;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      // Use folder bounds (larger than individual cells)
      if (layout.folders?.size > 0) {
        for (const f of layout.folders.values()) {
          minX = Math.min(minX, f.x - f.radius);
          minY = Math.min(minY, f.y - f.radius);
          maxX = Math.max(maxX, f.x + f.radius);
          maxY = Math.max(maxY, f.y + f.radius);
        }
      } else {
        for (const c of layout.cells.values()) {
          minX = Math.min(minX, c.x); minY = Math.min(minY, c.y);
          maxX = Math.max(maxX, c.x); maxY = Math.max(maxY, c.y);
        }
      }
      if (minX !== Infinity) vp.fitBounds(minX, minY, maxX, maxY, HEX_SIZE * 2);
    }
    forceRender(n => n + 1);
  }, [files, groups, layoutRevision]);

  // ─── Sync bees with agents + activity ───
  useEffect(() => {
    const bees = beeSystemRef.current;
    const layout = layoutRef.current;
    if (!layout) return;

    // Build set of active agent IDs (not done/error/cancelled)
    const activeAgentMap = new Map();
    if (activeAgents) {
      for (const agent of activeAgents) {
        if (agent.status !== 'done' && agent.status !== 'error' && agent.status !== 'cancelled') {
          activeAgentMap.set(agent.id, agent);
        }
      }
    }

    // Build latest file-per-agent map from cellActivity
    const agentToFile = new Map();
    if (cellActivity) {
      for (const [filePath, activity] of cellActivity) {
        const cell = layout.cells.get(filePath);
        if (!cell) continue;
        const existing = agentToFile.get(activity.agentId);
        if (!existing || (activity.since || 0) > (existing.activity.since || 0)) {
          agentToFile.set(activity.agentId, { file: filePath, activity, cell });
        }
      }
    }

    // 1. Spawn bees for newly active agents — they enter from screen edge
    for (const [agentId, agent] of activeAgentMap) {
      if (!bees.bees.has(agentId)) {
        bees.spawn(agentId, agent.role || 'coder');
      }
    }

    // 2. Move bees to their current file target (but don't interrupt a drag)
    for (const [agentId, { cell, file }] of agentToFile) {
      let bee = bees.bees.get(agentId);
      if (!bee) {
        const role = agentId.includes('writer') ? 'writer'
          : agentId.includes('planner') ? 'planner'
          : agentId.includes('reviewer') ? 'reviewer'
          : agentId.includes('tester') ? 'tester'
          : agentId.includes('documenter') ? 'documenter'
          : 'coder';
        bees.spawn(agentId, role);
        bee = bees.bees.get(agentId);
      }
      if (bee.state === 'dragging') {
        // Update the stored target so on drop the bee flies to the new file
        bee.workTargetX = cell.x;
        bee.workTargetY = cell.y - 30; // WORK_HOVER_OFFSET
        bee.currentFile = file;
      } else {
        bees.flyTo(agentId, cell.x, cell.y, file);
      }
    }

    // 3. Bees whose agent is done → fly off-screen (unless being dragged)
    for (const beeId of Array.from(bees.bees.keys())) {
      const bee = bees.bees.get(beeId);
      if (bee.state === 'dragging') continue;  // Don't touch dragged bees
      if (!activeAgentMap.has(beeId)) {
        if (bee.state !== 'leaving') {
          bees.flyAway(beeId);
        }
      } else {
        // Agent is active but no current file → wander until next file arrives
        if (!agentToFile.has(beeId) && bee.state === 'working') {
          bees.returnToHive(beeId);
        }
      }
    }
  }, [cellActivity, activeAgents]);

  // ─── Render loop ───
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let dirty = true;

    function render() {
      const vp = viewportRef.current;
      const layout = layoutRef.current;
      if (!vp || !layout) { animFrameRef.current = requestAnimationFrame(render); return; }

      vp.update(); // animate viewport toward target
      // Always render — 36 cells is cheap. Dirty tracking adds complexity for no gain.

      // Clear
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = BG_COLOR;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Apply viewport — everything in CSS pixel space, no DPR
      ctx.save();
      vp.apply(ctx);

      const zoomLevel = vp.getZoomLevel();
      const bounds = vp.getVisibleBounds();
      const hexRange = getVisibleHexRange(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY, HEX_SIZE);

      // Determine hovered group for focus effect — focus on the EXACT sub-group
      const hoveredPath = hoveredCellRef.current;
      const hoveredFile = hoveredPath ? layout._fileMap?.get(hoveredPath) : null;
      const hoveredGroup = hoveredFile ? (hoveredFile.group_path || '.') : null;

      // Build ancestor chain: innermost group → outermost. Only real named
      // folders — root '.' is the workspace, not a containment level, so we
      // skip it (otherwise every file would look like it's "inside root").
      const hoveredChain = [];
      if (hoveredGroup && hoveredGroup !== '.' && layout.folders) {
        const parts = hoveredGroup.split('/');
        while (parts.length > 0) {
          const p = parts.join('/');
          if (p !== '.' && layout.folders.has(p)) hoveredChain.push(p);
          parts.pop();
        }
      }

      // Track pulse timing — reset when the innermost group changes
      const innermost = hoveredChain[0] || null;
      if (innermost !== hoverPulseRef.current.innermost) {
        hoverPulseRef.current = { innermost, startTime: performance.now() };
      }
      const pulseElapsed = innermost ? performance.now() - hoverPulseRef.current.startTime : 0;

      // 1. Group territories (folder regions + labels)
      drawGroups(ctx, layout.groupRegions, layout.occupancy, layout.cells, getSectionColor, zoomLevel, layout.folders, hoveredChain);

      // 1b. Hover ancestor chain highlight — additive fill wash + depth-ranked
      //     ring borders with cascading pulse from outer → inner.
      if (hoveredChain.length > 0) {
        drawGroupHighlight(ctx, hoveredChain, layout.groupRegions, getSectionColor, pulseElapsed);
      }

      // 2. Update cell animations
      const animator = cellAnimatorRef.current;
      const agentFileSet = cellActivity ? new Set(cellActivity.keys()) : null;
      animator.update(hoveredCellRef.current, selectedCell, null, agentFileSet);

      // 3. Cells — draw with chain-depth dim effect
      // Precompute: chain alpha by position (innermost=1.0, each step out dims more)
      // and a fast lookup of the chain top-level for "same branch" fallback dim.
      const chainAlphaByDepth = [1.0, 0.72, 0.52, 0.40, 0.34];
      const chainTopLevel = hoveredChain.length > 0 ? hoveredChain[hoveredChain.length - 1].split('/')[0] : null;

      // Returns chain index (0 = innermost containment) or -1 if not in chain
      function chainIndexForFile(fileGroup) {
        for (let i = 0; i < hoveredChain.length; i++) {
          const c = hoveredChain[i];
          if (fileGroup === c || fileGroup.startsWith(c + '/')) return i;
        }
        return -1;
      }

      const nowMs = performance.now();
      const layoutAnim = layoutAnimatorRef.current;

      for (const [filePath, cell] of layout.cells) {
        if (!isHexVisible(cell.q, cell.r, hexRange)) continue;
        const file = layout._fileMap?.get(filePath);
        if (!file) continue;
        const color = getSectionColor(file.group_path || '.');
        const agentState = cellActivity?.get(filePath);
        const anim = animator.get(filePath);

        // Interpolated position for reflow animation
        const pos = layoutAnim.positionFor(filePath, cell, nowMs);
        const drawX = pos.x;
        const drawY = pos.y;

        // Chain-depth dimming: cells in the innermost focused group stay full
        // bright; each containing ancestor dims a step; unrelated cells fade hard.
        const fileGroup = file.group_path || '.';
        if (hoveredChain.length > 0) {
          const cIdx = chainIndexForFile(fileGroup);
          if (cIdx >= 0) {
            ctx.globalAlpha = chainAlphaByDepth[Math.min(cIdx, chainAlphaByDepth.length - 1)];
          } else {
            const fileTop = fileGroup.split('/')[0];
            ctx.globalAlpha = (fileTop === chainTopLevel) ? 0.18 : 0.08;
          }
        }

        // Apply scale animation
        if (anim.scale !== 1) {
          ctx.save();
          ctx.translate(drawX, drawY);
          ctx.scale(anim.scale, anim.scale);
          ctx.translate(-drawX, -drawY);
        }

        drawCell(ctx, file, drawX, drawY, color, zoomLevel, {
          selected: selectedCell === filePath,
          hovered: hoveredCellRef.current === filePath,
          gitStatus: file.gitStatus || null,
          testStatus: null,
          aiStatus: agentState?.action || null,
          animHover: anim.hover,
          animSelect: anim.select,
          animSaveFlash: anim.saveFlash,
        });

        if (anim.scale !== 1) ctx.restore();
        ctx.globalAlpha = 1;

        // Save flash overlay
        if (anim.saveFlash > 0.01) {
          hexPath(ctx, drawX, drawY, HEX_SIZE * 0.92);
          ctx.fillStyle = `rgba(107, 142, 35, ${anim.saveFlash * 0.25})`;
          ctx.fill();
        }

        // Multi-select highlight ring
        if (selectedCells && selectedCells.has && selectedCells.has(filePath) && selectedCells.size > 1) {
          const pulse = Math.sin(nowMs * 0.004) * 0.2 + 0.8;
          hexPath(ctx, drawX, drawY, HEX_SIZE * 1.02);
          ctx.strokeStyle = `rgba(88, 166, 255, ${pulse})`;
          ctx.lineWidth = 2.2;
          ctx.setLineDash([]);
          ctx.stroke();
          // Small badge showing selection count — only on the first one drawn
        }
      }


      // 3b. Empty-cell placeholders — walk cellOwner for kind:'empty'.
      //     These are the drag-drop targets inside partially-filled groups
      //     and the "always-hex" filler that keeps every group a full ring.
      //     Skipped at satellite zoom; drawEmptyCell handles region/city
      //     visual levels internally.
      if (layout.cellOwner && zoomLevel !== 'satellite') {
        const dropTarget = cellDragRef.current?.active ? cellDragRef.current.dropTarget : null;
        for (const [key, owner] of layout.cellOwner) {
          if (owner.kind !== 'empty') continue;
          const [q, r] = key.split(',').map(Number);
          if (!isHexVisible(q, r, hexRange)) continue;
          const pos = hexToPixel(q, r, HEX_SIZE);
          const color = getSectionColor(owner.groupPath);
          // Apply same chain-depth dimming as files so non-chain groups'
          // empty cells fade the same way during hover focus.
          let alpha = 1;
          if (hoveredChain.length > 0) {
            const cIdx = chainIndexForFile(owner.groupPath);
            if (cIdx >= 0) {
              alpha = chainAlphaByDepth[Math.min(cIdx, chainAlphaByDepth.length - 1)];
            } else {
              const top = owner.groupPath.split('/')[0];
              alpha = (top === chainTopLevel) ? 0.18 : 0.08;
            }
          }
          const isDrop =
            dropTarget &&
            dropTarget.q === q &&
            dropTarget.r === r &&
            dropTarget.kind !== 'invalid';
          ctx.globalAlpha = alpha;
          drawEmptyCell(ctx, pos.x, pos.y, color, zoomLevel, { dropTarget: isDrop });
          ctx.globalAlpha = 1;
        }
      }

      // 4. Group labels (ON TOP of cells) — show ancestor chain labels with
      //    cascading fade-in (outer first, inner last).
      drawGroupLabels(ctx, getSectionColor, zoomLevel, layout.folders, hoveredChain, pulseElapsed);

      // 4b. Breadcrumb spine near hovered cell — vertical stack D › C › B
      if (hoveredChain.length > 0 && hoveredPath) {
        const hoveredCell = layout.cells.get(hoveredPath);
        if (hoveredCell) {
          drawBreadcrumbSpine(ctx, hoveredChain, { x: hoveredCell.x, y: hoveredCell.y },
            layout.folders, getSectionColor, pulseElapsed);
        }
      }

      // 4c. Workspace-search glow — cells containing search matches
      //     get a pulsing amber halo + match-count badge. This is Hexis's
      //     spatial heatmap: you SEE where the query lives across the
      //     whole project at once, no list required.
      const searchState = searchMatchesRef.current;
      if (searchState.map.size > 0) {
        const elapsed = performance.now() - searchState.startTime;
        // Gentle breathing pulse — ~2.5s period
        const pulse = 0.75 + 0.25 * Math.sin(elapsed * 0.0025);
        for (const [filePath, matchCount] of searchState.map) {
          const cell = layout.cells.get(filePath);
          if (!cell) continue;
          if (!isHexVisible(cell.q, cell.r, hexRange)) continue;

          // Multi-ring glow
          ctx.save();
          ctx.shadowBlur = 20 * pulse;
          ctx.shadowColor = `rgba(255, 200, 80, ${0.85 * pulse})`;

          hexPath(ctx, cell.x, cell.y, HEX_SIZE * 1.04);
          ctx.strokeStyle = `rgba(255, 210, 100, ${0.95 * pulse})`;
          ctx.lineWidth = 2.5;
          ctx.stroke();

          // Inner amber wash
          ctx.shadowBlur = 0;
          hexPath(ctx, cell.x, cell.y, HEX_SIZE * 0.95);
          ctx.fillStyle = `rgba(255, 180, 60, ${0.12 * pulse})`;
          ctx.fill();
          ctx.restore();

          // Match-count badge — top-right of hex
          const badgeX = cell.x + HEX_SIZE * 0.7;
          const badgeY = cell.y - HEX_SIZE * 0.7;
          const badgeR = matchCount > 99 ? 11 : matchCount > 9 ? 10 : 9;

          ctx.beginPath();
          ctx.arc(badgeX, badgeY, badgeR, 0, Math.PI * 2);
          ctx.fillStyle = '#0D1117';
          ctx.fill();
          ctx.strokeStyle = '#F0A030';
          ctx.lineWidth = 1.5;
          ctx.stroke();

          ctx.font = '700 10px Inter, system-ui, sans-serif';
          ctx.fillStyle = '#F0A030';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(
            matchCount > 99 ? '99+' : String(matchCount),
            badgeX,
            badgeY + 0.5,
          );
        }
      }

      // 4d. Recent drop glow — after a successful drop, the dropped
      //     file or group pulses bright white for 5 seconds so the user
      //     can see exactly where it landed. Distinct from search glow
      //     (amber), hover cascade (depth rings), and selection (accent).
      const recentDrops = recentDropsRef.current;
      if (recentDrops.size > 0) {
        const now = performance.now();
        const expired = [];
        for (const [path, meta] of recentDrops) {
          const elapsed = now - meta.startTime;
          if (elapsed >= 5000) { expired.push(path); continue; }
          const fade = 1 - (elapsed / 5000);
          const pulse = 0.6 + 0.4 * Math.sin(elapsed * 0.006);
          const alpha = fade * pulse;

          if (meta.kind === 'file') {
            const cell = layout.cells.get(path);
            if (!cell) continue;
            if (!isHexVisible(cell.q, cell.r, hexRange)) continue;
            // Glow the actual cell border (not an oversized halo): trace
            // the cell's own hex outline with a strong shadow blur. Two
            // passes — outer soft halo + sharp inner stroke — give a
            // clean "lit from within" look.
            ctx.save();
            ctx.shadowBlur = 28 * pulse;
            ctx.shadowColor = `rgba(255, 255, 255, ${0.95 * alpha})`;
            hexPath(ctx, cell.x, cell.y, HEX_SIZE);
            ctx.strokeStyle = `rgba(255, 255, 255, ${0.9 * alpha})`;
            ctx.lineWidth = 3.2;
            ctx.lineJoin = 'round';
            ctx.stroke();
            // Second crisp pass on top (no shadow) for sharp contour
            ctx.shadowBlur = 0;
            ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
            ctx.lineWidth = 1.6;
            ctx.stroke();
            ctx.restore();
          } else {
            // Glow the ACTUAL group boundary by tracing the edges between
            // cells that belong to the group and cells that don't. This
            // matches the ridge border drawn by GroupRenderer, not a
            // single oversized hex.
            const regionCells = layout.groupRegions?.get(path);
            if (!regionCells || regionCells.length === 0) continue;
            const cellSet = new Set(regionCells.map(c => `${c.q},${c.r}`));
            const NEIGHBOR_TO_EDGE = [5, 0, 1, 2, 3, 4];
            ctx.save();
            ctx.shadowBlur = 34 * pulse;
            ctx.shadowColor = `rgba(255, 255, 255, ${0.95 * alpha})`;
            ctx.strokeStyle = `rgba(255, 255, 255, ${0.9 * alpha})`;
            ctx.lineWidth = 3.6;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.beginPath();
            for (const c of regionCells) {
              if (!isHexVisible(c.q, c.r, hexRange)) continue;
              const pos = hexToPixel(c.q, c.r, HEX_SIZE);
              const neighbors = hexNeighbors(c.q, c.r);
              for (let i = 0; i < 6; i++) {
                const n = neighbors[i];
                if (cellSet.has(`${n.q},${n.r}`)) continue;
                const ei = NEIGHBOR_TO_EDGE[i];
                const a1 = (Math.PI / 3) * ei;
                const a2 = (Math.PI / 3) * ((ei + 1) % 6);
                ctx.moveTo(
                  pos.x + HEX_SIZE * Math.cos(a1),
                  pos.y + HEX_SIZE * Math.sin(a1),
                );
                ctx.lineTo(
                  pos.x + HEX_SIZE * Math.cos(a2),
                  pos.y + HEX_SIZE * Math.sin(a2),
                );
              }
            }
            ctx.stroke();
            // Sharp overlay
            ctx.shadowBlur = 0;
            ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
            ctx.lineWidth = 1.8;
            ctx.stroke();
            ctx.restore();
          }
        }
        for (const p of expired) recentDrops.delete(p);
      }

      // 4e. Drag ghost — if a cell/group is being dragged, draw a
      //     semi-transparent copy of the source at the cursor position.
      //     The drop target highlight is already handled above in the
      //     empty-cell pass (via cellDragRef.current.dropTarget).
      const drag = cellDragRef.current;
      if (drag.active) {
        ctx.save();
        ctx.globalAlpha = 0.75;
        const file = layout._fileMap?.get(drag.path);
        if (file) {
          const color = getSectionColor(file.group_path || '.');
          drawCell(ctx, file, drag.currentX, drag.currentY, color, zoomLevel, {
            hovered: true, selected: false, gitStatus: null,
          });
        } else if (drag.kind === 'group') {
          // Group drag — draw a labelled hex indicator at the cursor
          const color = getSectionColor(drag.path);
          hexPath(ctx, drag.currentX, drag.currentY, HEX_SIZE * 0.95);
          ctx.fillStyle = color + '55';
          ctx.fill();
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.fillStyle = '#E6EDF3';
          ctx.font = '600 11px Inter, system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const label = drag.path.split('/').pop() || drag.path;
          ctx.fillText(label, drag.currentX, drag.currentY);
        }
        ctx.globalAlpha = 1;
        ctx.restore();
      }

      // 5. Update bee viewport bounds + render
      const bees = beeSystemRef.current;
      bees.setViewBounds(bounds);

      if (pendingPlan?.length > 0) {
        drawFlightPlan(ctx, pendingPlan, layout, (bounds.minX + bounds.maxX) / 2, bounds.minY - 60);
      }

      // 6. Bees (above cells, in world space)
      bees.update();
      bees.draw(ctx);

      ctx.restore();


      animFrameRef.current = requestAnimationFrame(render);
    }

    animFrameRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [files, groups, selectedCell, cellActivity, pendingPlan]);

  // ─── Hit test helper (grid-based) ───
  function hitTest(e) {
    const canvas = canvasRef.current;
    const vp = viewportRef.current;
    const layout = layoutRef.current;
    if (!canvas || !vp || !layout) return null;
    const pos = getMousePos(e, canvas);
    const world = vp.screenToWorld(pos.x, pos.y);
    const hex = pixelToHex(world.x, world.y, HEX_SIZE);
    return layout.occupancy.get(`${hex.q},${hex.r}`) || null;
  }

  // Rich hit test — returns the FULL hit shape for right-click menus
  // and drag-and-drop. Kinds:
  //   - 'file'  → a file cell at (q,r) with filePath + its groupPath
  //   - 'empty' → an empty slot inside a group at (q,r) with groupPath
  //   - 'group' → a point inside a group's region but on its LABEL area
  //              (same as empty for now; reserved for future)
  //   - 'none'  → outside all groups and not on any cell
  function hitTestRich(e) {
    const canvas = canvasRef.current;
    const vp = viewportRef.current;
    const layout = layoutRef.current;
    if (!canvas || !vp || !layout) return { kind: 'none' };
    const pos = getMousePos(e, canvas);
    const world = vp.screenToWorld(pos.x, pos.y);

    // First, check group LABEL rects (in world space). Labels are drawn
    // ABOVE each group hex so they're typically outside any cell, but we
    // check them first so a click on a label doesn't get stolen by a
    // neighboring cell. Iterate deepest-depth-first so nested labels win.
    if (layout.folders) {
      const foldersByDepth = [...layout.folders.values()].sort((a, b) => (b.depth || 0) - (a.depth || 0));
      for (const folder of foldersByDepth) {
        const r = folder.labelRect;
        if (!r) continue;
        if (world.x >= r.x && world.x <= r.x + r.w &&
            world.y >= r.y && world.y <= r.y + r.h) {
          return {
            kind: 'group',
            groupPath: folder.path,
            q: folder.cq,
            r: folder.cr,
            fromLabel: true,
          };
        }
      }
    }

    const hex = pixelToHex(world.x, world.y, HEX_SIZE);
    const key = `${hex.q},${hex.r}`;
    const owner = layout.cellOwner?.get(key);
    if (owner?.kind === 'file') {
      // Resolve owning group from the file metadata
      const file = layout._fileMap?.get(owner.filePath);
      return {
        kind: 'file',
        filePath: owner.filePath,
        groupPath: file?.group_path || '.',
        q: hex.q,
        r: hex.r,
      };
    }
    if (owner?.kind === 'empty') {
      return {
        kind: 'empty',
        groupPath: owner.groupPath,
        q: hex.q,
        r: hex.r,
      };
    }
    return { kind: 'none', q: hex.q, r: hex.r };
  }

  // Hit test for a bee at screen coords
  function hitTestBee(e) {
    const canvas = canvasRef.current;
    const vp = viewportRef.current;
    if (!canvas || !vp) return null;
    const pos = getMousePos(e, canvas);
    const world = vp.screenToWorld(pos.x, pos.y);
    // Scale the hit radius with zoom so it's roughly constant on screen
    const screenRadius = 22;
    const worldRadius = screenRadius / vp.zoom;
    return beeSystemRef.current?.hitTest(world.x, world.y, worldRadius) || null;
  }

  // ─── Event handlers (React synthetic — simpler, works with HMR) ───
  // Wheel: native listener with { passive: false } to allow preventDefault
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    function onWheel(e) {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      viewportRef.current?.zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY);
    }
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  const draggedBeeRef = useRef(null);  // { agentId, startedDragging: bool }

  const onPointerDown = useCallback((e) => {
    if (e.button !== 0) return;

    // Check if we're grabbing a bee
    const beeId = hitTestBee(e);
    if (beeId) {
      draggedBeeRef.current = { agentId: beeId, startedDragging: false };
      mouseDownRef.current = {
        startX: e.clientX, startY: e.clientY,
        lastX: e.clientX, lastY: e.clientY,
        dragged: false,
        beeMode: true,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
      if (canvasRef.current) canvasRef.current.style.cursor = 'grabbing';
      return;
    }

    // Check if we're grabbing a cell. Modifier rules:
    //   - plain click → file drag (if on a file) — wait for threshold
    //   - Alt+click on file/empty → GROUP drag (drags the group containing the cell)
    //   - Ctrl/Cmd → reserved for go-to-def, no drag
    //   - Shift → reserved for future multi-select
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
      const hit = hitTestRich(e);
      // Label click on a group header → direct group drag
      const labelGroup = !e.altKey && hit?.kind === 'group' && hit.fromLabel && hit.groupPath && hit.groupPath !== '.';
      // Plain click on an EMPTY cell inside a real group → group drag.
      // This lets users grab a group from anywhere in its territory, not
      // just the tiny label. Empty cells can still be used for right-click
      // context menu (New File Here etc).
      const emptyGroupDrag = !e.altKey && hit?.kind === 'empty' && hit.groupPath && hit.groupPath !== '.';
      // Alt+click inside a group → group drag (legacy fallback, kept for muscle memory)
      const altGroup = e.altKey && (hit?.kind === 'file' || hit?.kind === 'empty') && hit.groupPath && hit.groupPath !== '.';
      const fileDrag = !e.altKey && hit?.kind === 'file';
      if (labelGroup || emptyGroupDrag || altGroup || fileDrag) {
        const canvas = canvasRef.current;
        const vp = viewportRef.current;
        if (canvas && vp) {
          const pos = getMousePos(e, canvas);
          const world = vp.screenToWorld(pos.x, pos.y);
          const isGroupDrag = labelGroup || altGroup || emptyGroupDrag;
          cellDragRef.current = {
            active: false, // not yet active — waits for threshold
            kind: isGroupDrag ? 'group' : 'file',
            path: isGroupDrag ? hit.groupPath : hit.filePath,
            sourceGroupPath: hit.groupPath,
            startX: world.x,
            startY: world.y,
            currentX: world.x,
            currentY: world.y,
            dropTarget: null,
            screenStartX: e.clientX,
            screenStartY: e.clientY,
          };
          mouseDownRef.current = {
            startX: e.clientX, startY: e.clientY,
            lastX: e.clientX, lastY: e.clientY,
            dragged: false,
            beeMode: false,
            cellMode: true, // potential cell drag (activates on threshold)
          };
          e.currentTarget.setPointerCapture(e.pointerId);
          return;
        }
      }
    }

    // Otherwise, normal pan/click behavior
    mouseDownRef.current = {
      startX: e.clientX, startY: e.clientY,
      lastX: e.clientX, lastY: e.clientY,
      dragged: false,
      beeMode: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    if (canvasRef.current) canvasRef.current.style.cursor = 'grabbing';
  }, []);

  const onPointerMove = useCallback((e) => {
    const down = mouseDownRef.current;

    // Cell drag mode — 4px threshold, then track cursor + compute drop target.
    // All state lives in cellDragRef so the render loop can read it without
    // any React re-renders during the drag.
    if (down && down.cellMode && e.buttons === 1) {
      const drag = cellDragRef.current;
      if (!drag.active) {
        const dx = e.clientX - down.startX;
        const dy = e.clientY - down.startY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
          drag.active = true;
          if (canvasRef.current) canvasRef.current.style.cursor = 'grabbing';
        }
      }
      if (drag.active) {
        const canvas = canvasRef.current;
        const vp = viewportRef.current;
        if (canvas && vp) {
          const pos = getMousePos(e, canvas);
          const world = vp.screenToWorld(pos.x, pos.y);
          drag.currentX = world.x;
          drag.currentY = world.y;
          drag.dropTarget = computeDropTarget(layoutRef.current, drag, world.x, world.y);
        }
        return;
      }
      // Not yet past threshold — fall through to normal hover updates
    }

    // Bee drag mode
    if (down && down.beeMode && draggedBeeRef.current && e.buttons === 1) {
      const totalDx = e.clientX - down.startX;
      const totalDy = e.clientY - down.startY;
      if (Math.abs(totalDx) > 3 || Math.abs(totalDy) > 3) {
        if (!draggedBeeRef.current.startedDragging) {
          // Initiate the drag on first real movement
          beeSystemRef.current?.beginDrag(draggedBeeRef.current.agentId);
          draggedBeeRef.current.startedDragging = true;
        }
        down.dragged = true;
      }

      if (draggedBeeRef.current.startedDragging) {
        // Update bee world position from cursor
        const canvas = canvasRef.current;
        const vp = viewportRef.current;
        if (canvas && vp) {
          const pos = getMousePos(e, canvas);
          const world = vp.screenToWorld(pos.x, pos.y);
          beeSystemRef.current?.updateDrag(draggedBeeRef.current.agentId, world.x, world.y);
        }
      }
      return;
    }

    // Pan: drag to move camera
    if (down && e.buttons === 1) {
      const totalDx = e.clientX - down.startX;
      const totalDy = e.clientY - down.startY;
      if (Math.abs(totalDx) > 5 || Math.abs(totalDy) > 5) {
        down.dragged = true;
      }

      if (down.dragged) {
        const frameDx = e.clientX - down.lastX;
        const frameDy = e.clientY - down.lastY;
        viewportRef.current?.pan(frameDx, frameDy);
        down.lastX = e.clientX;
        down.lastY = e.clientY;
      }
    }

    // Hover: highlight bee first, then cell
    const beeId = hitTestBee(e);
    const fp = hitTest(e);
    if (fp !== hoveredCellRef.current) {
      hoveredCellRef.current = fp;
      onCellHover?.(fp);
    }
    if (canvasRef.current && !down?.dragged) {
      canvasRef.current.style.cursor = (beeId || fp) ? 'pointer' : 'grab';
    }
  }, [onCellHover]);

  const lastClickInfo = useRef({ key: null, time: 0, lastClickKey: null, lastClickTime: 0 });

  const onPointerUp = useCallback((e) => {
    const down = mouseDownRef.current;
    mouseDownRef.current = null;
    if (canvasRef.current) canvasRef.current.style.cursor = 'grab';

    // End cell drag (if any). If there's a valid drop target, dispatch.
    // If we never passed the threshold, fall through to treat as a click.
    if (down && down.cellMode) {
      const drag = cellDragRef.current;
      if (drag.active) {
        const dt = drag.dropTarget;
        if (dt && dt.status === 'valid') {
          const destPath = computeDestinationPath(drag, dt);
          if (destPath) {
            onCellDrop?.({
              kind: drag.kind,
              from: drag.path,
              to: destPath,
              dropTarget: dt,
            });
          }
        }
        // Reset drag state
        cellDragRef.current = makeCellDragState();
        return;
      }
      // No threshold crossed — reset and continue to click handling below
      cellDragRef.current = makeCellDragState();
    }

    // End bee drag (if any)
    if (draggedBeeRef.current) {
      const { agentId, startedDragging } = draggedBeeRef.current;
      draggedBeeRef.current = null;

      if (startedDragging) {
        // Release the bee — it'll fly back to its work target
        beeSystemRef.current?.endDrag(agentId);
        return;
      }
      // If no drag happened, treat as click
      if (e.button === 0) {
        onBeeClick?.(agentId);
        return;
      }
    }

    if (!down || down.dragged || e.button !== 0) return;

    const rich = hitTestRich(e);
    const fp = rich?.kind === 'file' ? rich.filePath : null;
    const now = Date.now();
    const prev = lastClickInfo.current;

    // Double-click → zoom. Same target within 500ms toggles between
    // "zoom in to item" and "zoom out to fit-all".
    // Key identifies the target: file path, or 'group:<path>' for groups.
    const targetKey = fp || (rich?.kind === 'group' || rich?.kind === 'empty'
      ? `group:${rich.groupPath || ''}`
      : null);

    if (targetKey && targetKey === prev.key && now - prev.time < 500) {
      lastClickInfo.current = { key: null, time: 0 };
      // Repeat double-click on same target → zoom out to fit everything
      const layout = layoutRef.current;
      if (layout && viewportRef.current) {
        zoomToFitAll();
      }
      hoveredCellRef.current = null;
      if (fp) onCellDoubleClick?.(fp);
      return;
    }

    if (targetKey && prev.key === targetKey && now - prev.time < 500) {
      // (unreachable but keep for clarity)
    }

    // First double-click: detect via simple "same cell within 500ms" rule
    // against the LAST single click.
    if (targetKey && targetKey === prev.lastClickKey && now - prev.lastClickTime < 500) {
      lastClickInfo.current = { key: targetKey, time: now, lastClickKey: null, lastClickTime: 0 };
      // Capture the mouse position so the zoom anchors the clicked hex
      // under the cursor (VS Code / Google Maps style) instead of teleporting
      // the camera to put the hex in the dead center of the screen.
      const canvas = canvasRef.current;
      const anchorPos = canvas ? getMousePos(e, canvas) : null;
      const anchorOpts = anchorPos
        ? { anchorSx: anchorPos.x, anchorSy: anchorPos.y }
        : {};
      if (fp) {
        zoomToItemImpl(fp, 'file', anchorOpts);
        onCellDoubleClick?.(fp);
      } else if (rich?.groupPath) {
        zoomToItemImpl(rich.groupPath, 'group', anchorOpts);
      }
      hoveredCellRef.current = null;
      return;
    }

    // Single click — record for potential double-click on next event
    lastClickInfo.current = {
      key: null, time: 0,
      lastClickKey: targetKey,
      lastClickTime: now,
    };
    if (fp) {
      onCellClick?.(fp, { ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey });
    }
  }, [onCellClick, onCellDoubleClick, onBeeClick]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full"
      style={{ cursor: 'grab', touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={(e) => {
        e.preventDefault();
        if (!onCellContextMenu) return;
        const target = hitTestRich(e);
        onCellContextMenu({ x: e.clientX, y: e.clientY, target });
      }}
    />
  );
});

export default HexCanvas;
