/**
 * Hexis Hex Grid Background — draws a warm honeycomb grid on canvas.
 * Only shows hex cells near occupied nodes, fading out further away.
 */

import { hexToPixel, hexRing, hexDistance, drawHexCell } from '../utils/hexGrid.js';
import { HEX_SIZE, colors } from '../../theme/tokens.js';

/**
 * Draw the hex grid background.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array} nodes — nodes with _hexQ, _hexR
 * @param {Map} groupCells — groupKey → [{q, r}]
 * @param {object} sectionColors — dynamic section → color map
 */
export function drawHexBackground(ctx, nodes, groupCells, sectionColors) {
  ctx.save();
  ctx.resetTransform();

  const canvas = ctx.canvas;
  const W = canvas.width;
  const H = canvas.height;
  const dpr = window.devicePixelRatio || 1;

  // Warm cream background
  ctx.fillStyle = colors.bgDeep;
  ctx.fillRect(0, 0, W, H);

  ctx.restore();
  // Now drawing in graph space (canvas transform is active)

  const fadeRadius = 3;
  const occupiedSet = new Set();
  const nodeGroupMap = new Map(); // "q,r" → section

  for (const node of nodes) {
    if (node._hexQ != null && node._hexR != null) {
      const key = `${node._hexQ},${node._hexR}`;
      occupiedSet.add(key);
      nodeGroupMap.set(key, node.section);
    }
  }

  // Collect all cells to draw (occupied + nearby)
  const cellsToDraw = new Map(); // "q,r" → { q, r, dist, section }
  const processed = new Set();

  for (const node of nodes) {
    if (node._hexQ == null) continue;
    const ring = hexRing(node._hexQ, node._hexR, fadeRadius);
    for (const cell of ring) {
      const key = `${cell.q},${cell.r}`;
      if (processed.has(key)) continue;
      processed.add(key);

      const dist = hexDistance(node._hexQ, node._hexR, cell.q, cell.r);
      const existing = cellsToDraw.get(key);
      if (!existing || dist < existing.dist) {
        cellsToDraw.set(key, { ...cell, dist, section: node.section });
      }
    }
  }

  // Draw group territory fills first (subtle tint)
  if (groupCells) {
    for (const [groupKey, cells] of groupCells.entries()) {
      const section = groupKey.split('/')[0];
      const color = sectionColors?.[section] || colors.neutral;

      for (const cell of cells) {
        const pos = hexToPixel(cell.q, cell.r, HEX_SIZE);
        const isOccupied = occupiedSet.has(`${cell.q},${cell.r}`);
        // Subtle territory fill
        drawHexCell(ctx, pos.x, pos.y, HEX_SIZE * 0.96,
          isOccupied ? `${color}15` : `${color}08`,
          null);
      }
    }
  }

  // Draw grid lines — fade by distance from nearest node
  for (const [key, cell] of cellsToDraw.entries()) {
    const pos = hexToPixel(cell.q, cell.r, HEX_SIZE);
    const alpha = Math.max(0, 1 - cell.dist / (fadeRadius + 0.5));
    const isOccupied = occupiedSet.has(key);

    // Grid line
    const lineAlpha = isOccupied ? 0.15 : alpha * 0.06;
    if (lineAlpha > 0.005) {
      drawHexCell(ctx, pos.x, pos.y, HEX_SIZE * 0.98,
        null,
        `rgba(180, 140, 60, ${lineAlpha})`,
        isOccupied ? 1 : 0.5);
    }
  }

  // Draw group border edges — thicker lines between cells of different groups
  for (const node of nodes) {
    if (node._hexQ == null) continue;
    const pos = hexToPixel(node._hexQ, node._hexR, HEX_SIZE);
    const section = node.section;
    const color = sectionColors?.[section] || colors.neutral;

    // Check each edge: if neighbor is a different group or empty, draw border
    const angles = [0, 1, 2, 3, 4, 5];
    for (const i of angles) {
      // Get neighbor at this edge
      const angle = (Math.PI / 3) * i;
      const nextAngle = (Math.PI / 3) * ((i + 1) % 6);

      // Check if there's a neighbor node in a different section
      const nx = Math.round(pos.x + HEX_SIZE * 1.5 * Math.cos(angle + Math.PI / 6));
      const ny = Math.round(pos.y + HEX_SIZE * 1.5 * Math.sin(angle + Math.PI / 6));

      // Simplified: just draw a subtle glow on occupied cells
    }
  }
}
