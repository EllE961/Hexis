/**
 * GroupRenderer — Cushioned Topographic Hive.
 *
 * Each folder depth is a "floor" of the hive:
 * - Deeper = darker fill, warmer color, thinner ridge border
 * - Labels are nameplates etched into the top boundary edge
 * - Sub-folders glow to pop from parent territory
 * - Ridge borders: outer lip (light) + inner shadow (dark) = 3D contour
 *
 * HOVER ANCESTOR CHAIN SYSTEM:
 *   When a cell is hovered, its full ancestor chain (innermost → outermost)
 *   is highlighted with depth-ranked rings, fill wash, z-lift glow, and a
 *   cascading pulse animation. Non-chain regions dim away.
 */

import { hexToPixel, hexNeighbors } from '../utils/hexMath.js';

const HEX_SIZE = 30;
const NEIGHBOR_TO_EDGE = [5, 0, 1, 2, 3, 4];

// Pulse cascade: total duration for all rings to activate, outer → inner
const PULSE_TOTAL_MS = 520;

// Depth-based visual parameters
const DEPTH_CONFIG = [
  { fillOpacity: 0.15, outerWidth: 3.0, shadowWidth: 1.8, lipAlpha: 0.40, shadowAlpha: 0.50 },
  { fillOpacity: 0.28, outerWidth: 2.5, shadowWidth: 1.5, lipAlpha: 0.35, shadowAlpha: 0.45 },
  { fillOpacity: 0.38, outerWidth: 2.0, shadowWidth: 1.2, lipAlpha: 0.30, shadowAlpha: 0.40 },
  { fillOpacity: 0.45, outerWidth: 1.5, shadowWidth: 1.0, lipAlpha: 0.25, shadowAlpha: 0.35 },
];

function getDepthConfig(depth) {
  return DEPTH_CONFIG[Math.min(depth, DEPTH_CONFIG.length - 1)];
}

/** Lighten a hex color by amount (0-1) */
function lighten(hex, amount) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const nr = Math.min(255, Math.round(r + (255 - r) * amount));
  const ng = Math.min(255, Math.round(g + (255 - g) * amount));
  const nb = Math.min(255, Math.round(b + (255 - b) * amount));
  return `#${nr.toString(16).padStart(2, '0')}${ng.toString(16).padStart(2, '0')}${nb.toString(16).padStart(2, '0')}`;
}

/** Darken a hex color by amount (0-1) */
function darken(hex, amount) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const nr = Math.round(r * (1 - amount));
  const ng = Math.round(g * (1 - amount));
  const nb = Math.round(b * (1 - amount));
  return `#${nr.toString(16).padStart(2, '0')}${ng.toString(16).padStart(2, '0')}${nb.toString(16).padStart(2, '0')}`;
}

/** Convert float opacity (0-1) to hex alpha string */
function alphaHex(opacity) {
  return Math.round(opacity * 255).toString(16).padStart(2, '0');
}

export function drawGroups(ctx, groupRegions, occupancy, cells, getSectionColor, zoomLevel, folders, hoveredChain) {
  if (!groupRegions || groupRegions.size === 0) return;

  // Hover chain dimming: non-chain groups fade away
  const chainSet = (hoveredChain && hoveredChain.length > 0) ? new Set(hoveredChain) : null;
  const chainTop = chainSet ? hoveredChain[hoveredChain.length - 1]?.split('/')[0] : null;

  function hoverAlphaFor(groupPath) {
    if (!chainSet) return 1;
    if (chainSet.has(groupPath)) return 1;
    const top = groupPath.split('/')[0];
    return top === chainTop ? 0.32 : 0.12;
  }

  // Build lookup
  const cellToGroup = new Map();
  for (const [groupPath, groupCells] of groupRegions) {
    for (const c of groupCells) cellToGroup.set(`${c.q},${c.r}`, groupPath);
  }

  // Build child→parent set for border suppression
  const childCellSets = new Map();
  if (folders) {
    for (const [path, folder] of folders) {
      if (folder.depth > 0) {
        const cells = groupRegions.get(path);
        if (cells) childCellSets.set(path, new Set(cells.map(c => `${c.q},${c.r}`)));
      }
    }
  }

  // Sort: draw shallowest first (parents behind children)
  const sortedRegions = [...groupRegions.entries()].sort((a, b) => {
    const da = folders?.get(a[0])?.depth ?? 0;
    const db = folders?.get(b[0])?.depth ?? 0;
    return da - db;
  });

  // ─── 1. CUSHION FILLS ───
  for (const [groupPath, groupCells] of sortedRegions) {
    const folder = folders?.get(groupPath);
    const depth = folder?.depth ?? 0;
    const section = groupPath.split('/')[0] || groupPath;
    const color = getSectionColor(groupPath);
    const config = getDepthConfig(depth);
    const hAlpha = hoverAlphaFor(groupPath);

    // Compute centroid for cushion gradient
    let cx = 0, cy = 0;
    for (const c of groupCells) {
      const p = hexToPixel(c.q, c.r, HEX_SIZE);
      cx += p.x; cy += p.y;
    }
    cx /= groupCells.length;
    cy /= groupCells.length;

    // Compute extent for gradient radius
    let maxDist = 0;
    for (const c of groupCells) {
      const p = hexToPixel(c.q, c.r, HEX_SIZE);
      const d = Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2);
      if (d > maxDist) maxDist = d;
    }

    if (hAlpha < 1) { ctx.save(); ctx.globalAlpha = hAlpha; }

    // Draw cushion fill (brighter at center, darker at edge = pillow effect)
    for (const cell of groupCells) {
      const pos = hexToPixel(cell.q, cell.r, HEX_SIZE);
      const dist = Math.sqrt((pos.x - cx) ** 2 + (pos.y - cy) ** 2);
      const t = maxDist > 0 ? dist / maxDist : 0;

      // Cushion: center = fillOpacity * 1.4, edge = fillOpacity * 0.7
      const cellOpacity = config.fillOpacity * (1.4 - 0.7 * t);

      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 3) * i;
        const px = pos.x + HEX_SIZE * Math.cos(angle);
        const py = pos.y + HEX_SIZE * Math.sin(angle);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = color + alphaHex(cellOpacity);
      ctx.fill();
    }

    if (hAlpha < 1) ctx.restore();
  }


  // ─── 3. RIDGE BORDERS ───
  for (const [groupPath, groupCells] of sortedRegions) {
    const folder = folders?.get(groupPath);
    const depth = folder?.depth ?? 0;
    const color = getSectionColor(groupPath);
    const config = getDepthConfig(depth);
    const cellSet = new Set(groupCells.map(c => `${c.q},${c.r}`));
    const hAlpha = hoverAlphaFor(groupPath);
    if (hAlpha < 1) { ctx.save(); ctx.globalAlpha = hAlpha; }

    // Collect boundary edges
    const edges = [];

    for (const cell of groupCells) {
      const pos = hexToPixel(cell.q, cell.r, HEX_SIZE);
      const neighbors = hexNeighbors(cell.q, cell.r);

      for (let i = 0; i < 6; i++) {
        const n = neighbors[i];
        const nKey = `${n.q},${n.r}`;

        if (!cellSet.has(nKey)) {
          // Check if this edge is shared with a child group — if so, suppress parent border
          if (depth === 0) {
            let suppressedByChild = false;
            for (const [childPath, childSet] of childCellSets) {
              if (cellSet.has(`${cell.q},${cell.r}`) && childSet.has(`${cell.q},${cell.r}`)) {
                // This cell belongs to both parent and child — check if neighbor is also in child
                if (!childSet.has(nKey)) {
                  // Edge is child's boundary, not parent's — let child draw it
                  suppressedByChild = true;
                  break;
                }
              }
            }
            // Don't suppress — parent draws edges where child is NOT present on this cell
          }

          const ei = NEIGHBOR_TO_EDGE[i];
          const angle1 = (Math.PI / 3) * ei;
          const angle2 = (Math.PI / 3) * ((ei + 1) % 6);

          edges.push({
            x1: pos.x + HEX_SIZE * Math.cos(angle1),
            y1: pos.y + HEX_SIZE * Math.sin(angle1),
            x2: pos.x + HEX_SIZE * Math.cos(angle2),
            y2: pos.y + HEX_SIZE * Math.sin(angle2),
            cx: pos.x, cy: pos.y,
          });
        }
      }
    }

    if (edges.length === 0) { if (hAlpha < 1) ctx.restore(); continue; }

    // Draw outer lip (light)
    const lipColor = lighten(color, 0.35);
    ctx.beginPath();
    for (const e of edges) { ctx.moveTo(e.x1, e.y1); ctx.lineTo(e.x2, e.y2); }
    ctx.strokeStyle = lipColor + alphaHex(config.lipAlpha);
    ctx.lineWidth = config.outerWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    // Draw inner shadow (dark, slightly inset)
    const shadowColor = darken(color, 0.4);
    const inset = 1.5;
    ctx.beginPath();
    for (const e of edges) {
      // Inset toward cell center
      const mx = (e.x1 + e.x2) / 2;
      const my = (e.y1 + e.y2) / 2;
      const dx = (e.cx - mx);
      const dy = (e.cy - my);
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const nx = dx / d * inset;
      const ny = dy / d * inset;
      ctx.moveTo(e.x1 + nx, e.y1 + ny);
      ctx.lineTo(e.x2 + nx, e.y2 + ny);
    }
    ctx.strokeStyle = shadowColor + alphaHex(config.shadowAlpha);
    ctx.lineWidth = config.shadowWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    if (hAlpha < 1) ctx.restore();
  }

}

// ═════════════════════════════════════════════════════════════════════
// HOVER HIGHLIGHT SYSTEM
// ═════════════════════════════════════════════════════════════════════

/** Compute boundary edges for a set of hex cells. */
function computeBoundaryEdges(groupCells) {
  const cellSet = new Set(groupCells.map(c => `${c.q},${c.r}`));
  const edges = [];
  for (const cell of groupCells) {
    const pos = hexToPixel(cell.q, cell.r, HEX_SIZE);
    const neighbors = hexNeighbors(cell.q, cell.r);
    for (let k = 0; k < 6; k++) {
      const n = neighbors[k];
      if (!cellSet.has(`${n.q},${n.r}`)) {
        const ei = NEIGHBOR_TO_EDGE[k];
        const a1 = (Math.PI / 3) * ei;
        const a2 = (Math.PI / 3) * ((ei + 1) % 6);
        edges.push({
          x1: pos.x + HEX_SIZE * Math.cos(a1),
          y1: pos.y + HEX_SIZE * Math.sin(a1),
          x2: pos.x + HEX_SIZE * Math.cos(a2),
          y2: pos.y + HEX_SIZE * Math.sin(a2),
        });
      }
    }
  }
  return edges;
}

/** easeOutCubic */
function easeOut(t) { return 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3); }

/**
 * Draw the hover highlight for the full ancestor chain.
 *
 * chain is ordered innermost → outermost: [b, c, d, ...] where b = most specific.
 * - Additive fill wash: each ancestor tints its cells, so cells in all layers
 *   stack brightest (innermost = hottest).
 * - Depth-ranked ring borders: each ancestor's boundary gets a glow whose
 *   width, saturation, and blur increase from outer → inner.
 * - Cascading pulse: on hover enter, rings ignite outer → inner over ~520ms.
 * - Innermost ring breathes subtly in steady state.
 */
export function drawGroupHighlight(ctx, hoveredChain, groupRegions, getSectionColor, pulseElapsed) {
  if (!hoveredChain || hoveredChain.length === 0) return;

  const n = hoveredChain.length;
  const stepDur = PULSE_TOTAL_MS / Math.max(1, n);

  // Precompute per-level activity (pulse cascade) and chainPos (0=outer, 1=inner)
  const levels = hoveredChain.map((path, i) => {
    // i=0 innermost, i=n-1 outermost. Outer activates first.
    const delay = (n - 1 - i) * stepDur;
    const pulseT = (pulseElapsed - delay) / stepDur;
    const eased = easeOut(pulseT);
    // Chain position: 0 = outermost, 1 = innermost
    const chainPos = n === 1 ? 1 : 1 - (i / (n - 1));
    // Breathing on innermost only, subtle slow sine
    const breathing = i === 0 ? (Math.sin(pulseElapsed * 0.003) * 0.12 + 0.88) : 1;
    const activity = eased * breathing;
    return { path, i, chainPos, activity };
  });

  // ─── 1. ADDITIVE FILL WASH ───
  // Draw from outermost to innermost; all levels contribute to cells where
  // they overlap, so innermost cells (contained in every ancestor) end up
  // with the most stacked tint — brightest visual peak.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let idx = n - 1; idx >= 0; idx--) {
    const lv = levels[idx];
    if (lv.activity <= 0.01) continue;
    const cells = groupRegions.get(lv.path);
    if (!cells) continue;
    const base = getSectionColor(lv.path);
    const tint = lighten(base, 0.2);
    const opacity = (0.09 + lv.chainPos * 0.07) * lv.activity;

    for (const cell of cells) {
      const pos = hexToPixel(cell.q, cell.r, HEX_SIZE);
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = (Math.PI / 3) * k;
        const px = pos.x + HEX_SIZE * Math.cos(a);
        const py = pos.y + HEX_SIZE * Math.sin(a);
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = tint + alphaHex(opacity);
      ctx.fill();
    }
  }
  ctx.restore();

  // ─── 2. DEPTH-RANKED RING BORDERS + Z-LIFT GLOW ───
  // Outer rings first (behind), inner rings last (on top).
  for (let idx = n - 1; idx >= 0; idx--) {
    const lv = levels[idx];
    if (lv.activity <= 0.01) continue;
    const cells = groupRegions.get(lv.path);
    if (!cells) continue;
    const edges = computeBoundaryEdges(cells);
    if (edges.length === 0) continue;

    const base = getSectionColor(lv.path);
    const coreColor = lighten(base, 0.55);  // near-white-hot core
    const glowColor = lighten(base, 0.35);  // halo

    // Inner layers get larger glow, thicker lines → visible "z-lift"
    const glowBlur = (8 + lv.chainPos * 22) * lv.activity;
    const haloWidth = (1.8 + lv.chainPos * 3.2);
    const coreWidth = (0.8 + lv.chainPos * 1.4);

    // ── Outer halo (wide, soft, shadowBlur simulates elevation) ──
    ctx.save();
    ctx.shadowBlur = glowBlur;
    ctx.shadowColor = glowColor + alphaHex(0.85 * lv.activity);
    ctx.beginPath();
    for (const e of edges) { ctx.moveTo(e.x1, e.y1); ctx.lineTo(e.x2, e.y2); }
    ctx.strokeStyle = glowColor + alphaHex(0.6 * lv.activity);
    ctx.lineWidth = haloWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();

    // ── Bright core line (crisp, no blur) ──
    ctx.beginPath();
    for (const e of edges) { ctx.moveTo(e.x1, e.y1); ctx.lineTo(e.x2, e.y2); }
    ctx.strokeStyle = coreColor + alphaHex(lv.activity);
    ctx.lineWidth = coreWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
  }
}

/**
 * Draw a floating breadcrumb spine near the hovered cell.
 * Stack: [outer] D › C › B [inner], colored per group.
 */
export function drawBreadcrumbSpine(ctx, hoveredChain, hoveredCellPos, folders, getSectionColor, pulseElapsed) {
  if (!hoveredChain || hoveredChain.length === 0 || !hoveredCellPos) return;

  const n = hoveredChain.length;
  const stepDur = PULSE_TOTAL_MS / Math.max(1, n);

  // Position: above-right of the cell, offset so it clears the hex
  const baseX = hoveredCellPos.x + HEX_SIZE * 1.4;
  const baseY = hoveredCellPos.y - HEX_SIZE * 1.8;

  ctx.save();
  ctx.font = '600 11px Inter, system-ui, sans-serif';
  ctx.textBaseline = 'middle';

  // Measure all labels first
  const items = [];
  // Render in visual order: outermost on TOP (biggest container), innermost at bottom
  for (let idx = n - 1; idx >= 0; idx--) {
    const path = hoveredChain[idx];
    const folder = folders?.get(path);
    const rawName = folder?.name === '.' || path === '.' ? 'root'
      : (folder?.name || path.split('/').pop() || path);
    const name = rawName.charAt(0).toUpperCase() + rawName.slice(1);
    const color = getSectionColor(path);
    const w = ctx.measureText(name).width;
    items.push({ path, idx, name, color, w });
  }

  const rowH = 22;
  const padX = 10;
  const gap = 4;
  const maxW = Math.max(...items.map(it => it.w), 40) + padX * 2 + 18;

  // Draw connector line from cell to first crumb
  const firstCrumbY = baseY;
  ctx.beginPath();
  ctx.moveTo(hoveredCellPos.x + HEX_SIZE * 0.9, hoveredCellPos.y);
  ctx.lineTo(baseX - 6, firstCrumbY + (items.length - 1) * (rowH + gap) + rowH / 2);
  ctx.strokeStyle = 'rgba(240, 200, 120, 0.55)';
  ctx.lineWidth = 1.2;
  ctx.setLineDash([3, 3]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Draw each crumb
  items.forEach((it, rowIdx) => {
    // Pulse delay matches ring cascade: outer first
    const delay = rowIdx * stepDur;
    const t = easeOut((pulseElapsed - delay) / (stepDur * 1.2));
    if (t <= 0.01) return;

    const y = baseY + rowIdx * (rowH + gap);
    const x = baseX;

    ctx.globalAlpha = t;

    // Plate background (rounded if supported, else rect)
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, maxW, rowH, 4);
    } else {
      ctx.rect(x, y, maxW, rowH);
    }
    ctx.fillStyle = 'rgba(13, 17, 23, 0.88)';
    ctx.fill();

    // Border in group color
    ctx.strokeStyle = it.color + 'C0';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Left color bar
    ctx.fillStyle = it.color;
    ctx.fillRect(x, y + 3, 3, rowH - 6);

    // Depth badge (left side number)
    ctx.fillStyle = it.color + 'DD';
    ctx.font = '700 10px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    // chain depth label: 1 = innermost, n = outermost
    const depthLabel = (it.idx + 1).toString();
    ctx.fillText(depthLabel, x + 14, y + rowH / 2);

    // Name
    ctx.font = '600 11px Inter, system-ui, sans-serif';
    ctx.fillStyle = '#E6EDF3';
    ctx.textAlign = 'left';
    ctx.fillText(it.name, x + 24, y + rowH / 2);

    // Chevron if not last (not innermost)
    if (rowIdx < items.length - 1) {
      ctx.strokeStyle = 'rgba(240, 200, 120, 0.5)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      const cx = x + maxW / 2;
      const cy = y + rowH + gap / 2;
      ctx.moveTo(cx - 3, cy - 2);
      ctx.lineTo(cx, cy + 1);
      ctx.lineTo(cx + 3, cy - 2);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
  });

  ctx.restore();
}

/** Draw group labels ON TOP of cells. Call this AFTER drawCell loop. */
export function drawGroupLabels(ctx, getSectionColor, zoomLevel, folders, hoveredChain, pulseElapsed) {
  if (!folders) return;

  const hovering = hoveredChain && hoveredChain.length > 0;
  const chainIndex = hovering ? new Map(hoveredChain.map((p, i) => [p, i])) : null;
  const chainLen = hovering ? hoveredChain.length : 0;
  const stepDur = PULSE_TOTAL_MS / Math.max(1, chainLen);

  for (const [folderPath, folder] of folders) {
    const depth = folder.depth ?? 0;
    const color = getSectionColor(folderPath);

    // When hovering: only show labels for groups in the ancestor chain
    if (hovering) {
      if (!chainIndex.has(folderPath)) continue;
    }

    if (zoomLevel === 'satellite' && depth > 0) continue;
    if (zoomLevel === 'region' && depth > 1) continue;
    // Always draw the label, even for empty groups — the user needs to see
    // the group name above its always-hex ring to know what it is.

    const { name, labelX, labelY, x, y } = folder;
    const rawName = name === '.' ? 'root' : (name.charAt(0).toUpperCase() + name.slice(1));

    // Config by depth — bigger, bolder, more contrast
    const fontSize = depth === 0 ? 15 : depth === 1 ? 11 : 9;
    const fontWeight = depth === 0 ? 800 : depth === 1 ? 700 : 600;
    const showCount = depth < 2;
    const plateH = depth === 0 ? 26 : depth === 1 ? 20 : 14;

    const lx = labelX || x;
    const ly = (labelY || y) - HEX_SIZE * 0.7;

    // Measure
    ctx.font = `${fontWeight} ${fontSize}px Inter, system-ui, sans-serif`;
    const nameW = ctx.measureText(rawName).width;
    const countStr = showCount ? `${folder.totalFiles}` : '';
    ctx.font = `600 ${fontSize - 2}px Inter, system-ui, sans-serif`;
    const countW = showCount ? ctx.measureText(countStr).width + 8 : 0;

    const totalW = nameW + countW + 24;
    const pX = lx - totalW / 2;
    const pY = ly - plateH / 2;

    // Background: hex-cornered shape (angled cuts on left/right)
    ctx.save();

    // Cascading fade-in for chain labels (outer first, inner last)
    if (hovering) {
      const i = chainIndex.get(folderPath);
      const delay = (chainLen - 1 - i) * stepDur;
      const fade = easeOut((pulseElapsed - delay) / (stepDur * 1.1));
      ctx.globalAlpha = Math.max(0, Math.min(1, fade));
    }

    const cut = plateH * 0.4; // hex corner cut size

    function hexPlate() {
      ctx.beginPath();
      ctx.moveTo(pX + cut, pY);                    // top-left after cut
      ctx.lineTo(pX + totalW - cut, pY);           // top-right before cut
      ctx.lineTo(pX + totalW, pY + plateH / 2);    // right point
      ctx.lineTo(pX + totalW - cut, pY + plateH);  // bottom-right after cut
      ctx.lineTo(pX + cut, pY + plateH);            // bottom-left before cut
      ctx.lineTo(pX, pY + plateH / 2);              // left point
      ctx.closePath();
    }

    // Solid dark background
    hexPlate();
    ctx.fillStyle = depth === 0 ? 'rgba(13, 17, 23, 0.92)' : 'rgba(22, 27, 34, 0.88)';
    ctx.fill();

    // Colored left accent triangle
    ctx.beginPath();
    ctx.moveTo(pX + cut, pY);
    ctx.lineTo(pX + cut + 3, pY);
    ctx.lineTo(pX + 3, pY + plateH / 2);
    ctx.lineTo(pX + cut + 3, pY + plateH);
    ctx.lineTo(pX + cut, pY + plateH);
    ctx.lineTo(pX, pY + plateH / 2);
    ctx.closePath();
    ctx.fillStyle = color + (depth === 0 ? 'DD' : 'AA');
    ctx.fill();

    // Border
    hexPlate();
    ctx.strokeStyle = color + '50';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Name text — bright white-ish for maximum contrast
    ctx.font = `${fontWeight} ${fontSize}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = depth === 0 ? '#E6EDF3' : '#8B949E';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(rawName, pX + 12, pY + plateH / 2);

    // Count — plain text, dimmer color, no background
    if (showCount && countStr) {
      ctx.font = `600 ${fontSize - 2}px Inter, system-ui, sans-serif`;
      ctx.fillStyle = color + '99';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(countStr, pX + 14 + nameW + 6, pY + plateH / 2);
    }

    ctx.restore();
  }
}
