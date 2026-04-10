/**
 * HexCanvas — the core hex grid renderer.
 * Direct Canvas2D. Handles rendering, viewport, hit testing, interaction.
 */

import { useRef, useEffect, useCallback, useState } from 'react';
import { Viewport } from './Viewport.js';
import { hexToPixel, pixelToHex, getVisibleHexRange, isHexVisible, hexNeighbors, hexPath } from '../../utils/hexMath.js';
import { computeLayout } from '../../utils/hexLayout.js';
import { drawCell } from './CellRenderer.js';
import { drawGroups, drawGroupLabels, drawGroupHighlight, drawBreadcrumbSpine } from './GroupRenderer.js';
import { BeeSystem } from './BeeSystem.js';
import { CellAnimator } from './CellAnimator.js';
import { useSearchStore } from '../../stores/searchStore.js';

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

export default function HexCanvas({ files, groups, onCellClick, onCellDoubleClick, onCellHover, onBeeClick, selectedCell, cellActivity, activeAgents, pendingPlan }) {
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
  const prevActivityRef = useRef(new Map());
  // Hover chain pulse state: which innermost group is active and when it started
  const hoverPulseRef = useRef({ innermost: null, startTime: 0 });
  // Search match cache — updated on every search store change; read by render loop
  const searchMatchesRef = useRef({ map: new Map(), startTime: 0 });
  const [, forceRender] = useState(0);

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

  // ─── Layout ───
  useEffect(() => {
    if (files.length === 0) return;
    const layout = computeLayout(files, groups, HEX_SIZE);
    layoutRef.current = layout;
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
  }, [files, groups]);

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

      for (const [filePath, cell] of layout.cells) {
        if (!isHexVisible(cell.q, cell.r, hexRange)) continue;
        const file = layout._fileMap?.get(filePath);
        if (!file) continue;
        const color = getSectionColor(file.group_path || '.');
        const agentState = cellActivity?.get(filePath);
        const anim = animator.get(filePath);

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
          ctx.translate(cell.x, cell.y);
          ctx.scale(anim.scale, anim.scale);
          ctx.translate(-cell.x, -cell.y);
        }

        drawCell(ctx, file, cell.x, cell.y, color, zoomLevel, {
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
          hexPath(ctx, cell.x, cell.y, HEX_SIZE * 0.92);
          ctx.fillStyle = `rgba(107, 142, 35, ${anim.saveFlash * 0.25})`;
          ctx.fill();
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

  const lastClickInfo = useRef({ path: null, time: 0 });

  const onPointerUp = useCallback((e) => {
    const down = mouseDownRef.current;
    mouseDownRef.current = null;
    if (canvasRef.current) canvasRef.current.style.cursor = 'grab';

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

    const fp = hitTest(e);
    const now = Date.now();
    const prev = lastClickInfo.current;

    // Check for double-click (same cell, within 500ms)
    if (fp && fp === prev.path && now - prev.time < 500) {
      lastClickInfo.current = { path: null, time: 0 };
      const layout = layoutRef.current;
      const cell = layout?.cells.get(fp);
      if (cell && viewportRef.current) {
        const newZoom = Math.min(2.0, viewportRef.current.zoom * 1.5);
        viewportRef.current.centerOn(cell.x, cell.y, newZoom);
        hoveredCellRef.current = null;
      }
      onCellDoubleClick?.(fp);
    } else {
      lastClickInfo.current = { path: fp, time: now };
      onCellClick?.(fp);
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
      onContextMenu={e => e.preventDefault()}
    />
  );
}
