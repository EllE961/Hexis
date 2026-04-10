/**
 * DiffOverlay — draws a visual diff layer on the hex grid canvas.
 *
 * When comparing branches or viewing a commit's changes, cells are colored:
 *   - Added files:     Green dashed outline + "+" badge
 *   - Modified files:  Amber pulsing border + "✎" badge
 *   - Deleted files:   Red ghost at 30% opacity + "×" in center
 *   - Unchanged files: Dimmed to 40% so diff changes pop
 *
 * At satellite/region zoom: simplified colored dots instead of full overlays.
 *
 * Usage: call drawDiffOverlay() AFTER drawCell() in the render loop
 * so the overlay composites on top of the base cells.
 */

import { hexPath, hexToPixel } from '../../utils/hexMath.js';

const HEX_SIZE = 50;

// ─── Diff palette ───

const DIFF_COLORS = {
  added:    '#22C55E',
  modified: '#F59E0B',
  deleted:  '#EF4444',
};

// ─── Helpers ───

/** Classify a file path into its diff status, or null if unchanged. */
function classifyFile(filePath, diffSets) {
  if (diffSets.added.has(filePath))    return 'added';
  if (diffSets.modified.has(filePath)) return 'modified';
  if (diffSets.deleted.has(filePath))  return 'deleted';
  return null;
}

/** Build Set objects once per frame for O(1) lookup. */
function buildDiffSets(diffData) {
  return {
    added:    new Set(diffData.added    || []),
    modified: new Set(diffData.modified || []),
    deleted:  new Set(diffData.deleted  || []),
  };
}

/** Animated pulse value (0.4 .. 1.0) for modified-file borders. */
function pulse() {
  return Math.sin(Date.now() * 0.004) * 0.3 + 0.7;
}

// ─── Satellite / Region: compact dot overlay ───

function drawDotOverlay(ctx, x, y, status, isLandmark) {
  const color = DIFF_COLORS[status];
  const radius = isLandmark ? 6 : 4;

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.globalAlpha = status === 'deleted' ? 0.4 : 0.9;
  ctx.fill();
  ctx.globalAlpha = 1;
}

// ─── Added overlay: dashed green hex outline + "+" badge ───

function drawAddedOverlay(ctx, x, y, cellSize) {
  const color = DIFF_COLORS.added;

  // Green glow
  ctx.save();
  ctx.shadowColor = color + '66';
  ctx.shadowBlur = 14;

  // Dashed hex outline
  hexPath(ctx, x, y, cellSize);
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.restore();

  // "+" badge — top-right of cell
  const badgeX = x + cellSize * 0.52;
  const badgeY = y - cellSize * 0.52;
  const badgeR = 7;

  ctx.beginPath();
  ctx.arc(badgeX, badgeY, badgeR, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  ctx.font = '700 10px Inter, system-ui, sans-serif';
  ctx.fillStyle = '#0A2010';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('+', badgeX, badgeY + 0.5);
}

// ─── Modified overlay: pulsing amber border + "✎" badge ───

function drawModifiedOverlay(ctx, x, y, cellSize) {
  const color = DIFF_COLORS.modified;
  const p = pulse();

  // Pulsing amber glow
  ctx.save();
  ctx.shadowColor = color + Math.round(p * 128).toString(16).padStart(2, '0');
  ctx.shadowBlur = 12 * p;

  // Solid hex outline that pulses in width
  hexPath(ctx, x, y, cellSize);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5 + p * 1.2;
  ctx.stroke();

  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.restore();

  // Split-color fill: left half old (dimmed amber), right half new (brighter amber)
  ctx.save();
  hexPath(ctx, x, y, cellSize);
  ctx.clip();

  // Left half — slightly darker tint
  ctx.fillStyle = 'rgba(245, 158, 11, 0.08)';
  ctx.fillRect(x - cellSize, y - cellSize, cellSize, cellSize * 2);

  // Right half — slightly brighter tint
  ctx.fillStyle = 'rgba(245, 158, 11, 0.16)';
  ctx.fillRect(x, y - cellSize, cellSize, cellSize * 2);

  ctx.restore();

  // "✎" badge — top-right of cell
  const badgeX = x + cellSize * 0.52;
  const badgeY = y - cellSize * 0.52;
  const badgeR = 7;

  ctx.beginPath();
  ctx.arc(badgeX, badgeY, badgeR, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  ctx.font = '600 8px Inter, system-ui, sans-serif';
  ctx.fillStyle = '#2A1800';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('\u270E', badgeX, badgeY + 0.5); // ✎
}

// ─── Deleted overlay: red ghost hex + "×" in center ───

function drawDeletedOverlay(ctx, x, y, cellSize) {
  const color = DIFF_COLORS.deleted;

  // Ghost hex: full cell at 30% opacity with red tint
  ctx.save();
  ctx.globalAlpha = 0.3;

  hexPath(ctx, x, y, cellSize);
  ctx.fillStyle = color + '30';
  ctx.fill();

  hexPath(ctx, x, y, cellSize);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.globalAlpha = 1;
  ctx.restore();

  // Red "×" in center
  ctx.font = '700 18px Inter, system-ui, sans-serif';
  ctx.fillStyle = color + 'AA';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('\u00D7', x, y); // ×
}

// ─── Unchanged dimming: reduce to 40% opacity ───

function drawUnchangedDim(ctx, x, y, cellSize) {
  // Semi-opaque dark overlay to visually push unchanged cells back
  hexPath(ctx, x, y, cellSize);
  ctx.fillStyle = 'rgba(26, 20, 8, 0.60)';
  ctx.fill();
}

// ─── Main export ───

/**
 * Draw the diff overlay on top of the existing hex grid.
 *
 * Call this AFTER all base cells have been drawn so it composites cleanly.
 *
 * @param {CanvasRenderingContext2D} ctx — canvas 2D context (already transformed by viewport)
 * @param {Object} layout — the layout object from computeLayout()
 *   layout.cells: Map<filePath, { q, r, x, y }>
 *   layout._fileMap: Map<filePath, fileObj>
 * @param {Object} diffData — { added: string[], modified: string[], deleted: string[] }
 * @param {string} zoomLevel — 'satellite' | 'region' | 'city' | 'street' | 'interior'
 */
export function drawDiffOverlay(ctx, layout, diffData, zoomLevel) {
  if (!layout || !diffData) return;
  if (!layout.cells || layout.cells.size === 0) return;

  const diffSets = buildDiffSets(diffData);
  const hasDiff = diffSets.added.size + diffSets.modified.size + diffSets.deleted.size > 0;
  if (!hasDiff) return;

  const isMiniZoom = zoomLevel === 'satellite' || zoomLevel === 'region';

  // ─── Pass 1: dim all unchanged cells ───
  for (const [filePath, cell] of layout.cells) {
    const status = classifyFile(filePath, diffSets);
    if (status !== null) continue; // skip diff targets — they get overlays

    const file = layout._fileMap?.get(filePath);
    const isLandmark = file?.is_landmark;
    const cellSize = isLandmark ? HEX_SIZE * 0.96 : HEX_SIZE * 0.92;

    if (isMiniZoom) {
      // At far zoom, just reduce the dot opacity
      ctx.save();
      ctx.globalAlpha = 0.4;
      ctx.beginPath();
      ctx.arc(cell.x, cell.y, isLandmark ? 5 : 3.5, 0, Math.PI * 2);
      // Overdraw with background to simulate dimming
      ctx.fillStyle = 'rgba(26, 20, 8, 0.55)';
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.restore();
    } else {
      drawUnchangedDim(ctx, cell.x, cell.y, cellSize);
    }
  }

  // ─── Pass 2: draw diff overlays on changed cells ───
  for (const [filePath, cell] of layout.cells) {
    const status = classifyFile(filePath, diffSets);
    if (status === null) continue;

    const file = layout._fileMap?.get(filePath);
    const isLandmark = file?.is_landmark;
    const cellSize = isLandmark ? HEX_SIZE * 0.96 : HEX_SIZE * 0.92;

    if (isMiniZoom) {
      drawDotOverlay(ctx, cell.x, cell.y, status, isLandmark);
      continue;
    }

    switch (status) {
      case 'added':
        drawAddedOverlay(ctx, cell.x, cell.y, cellSize);
        break;
      case 'modified':
        drawModifiedOverlay(ctx, cell.x, cell.y, cellSize);
        break;
      case 'deleted':
        drawDeletedOverlay(ctx, cell.x, cell.y, cellSize);
        break;
    }
  }

  // ─── Pass 3: draw deleted files that may not be in the current layout ───
  // Deleted files might not exist in layout.cells (they were removed).
  // If diffData.deleted contains paths not in layout, we draw ghost hexes
  // at the nearest available position. In practice the caller should
  // pre-compute positions for deleted files and include them in layout,
  // but as a fallback we skip unknowns gracefully.
  for (const deletedPath of diffSets.deleted) {
    if (layout.cells.has(deletedPath)) continue; // already drawn above

    // No position data — the file doesn't exist in the current tree.
    // Without a known hex position we can't place it. The caller should
    // provide ghost positions in layout.cells for deleted files.
    // This is left as a no-op to avoid visual noise at unknown coordinates.
  }
}
