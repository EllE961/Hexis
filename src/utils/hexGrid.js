/**
 * Hexis Hex Grid Math — flat-top hexagons using offset coordinates (odd-q).
 *
 * Coordinate system:
 *   q = column, r = row
 *   Odd columns are shifted down by half a hex height.
 *
 * Hex dimensions from size S (center to vertex):
 *   width  = S * √3
 *   height = S * 2
 *   Column spacing = width
 *   Row spacing    = height * 0.75
 */

const SQRT3 = Math.sqrt(3);

/** Convert hex grid (q, r) to pixel (x, y) center. Flat-top, odd-q offset. */
export function hexToPixel(q, r, size) {
  const x = q * size * SQRT3;
  const y = r * size * 1.5 + (q % 2 !== 0 ? size * 0.75 : 0);
  return { x, y };
}

/** Convert pixel (x, y) to nearest hex grid (q, r). */
export function pixelToHex(x, y, size) {
  // Fractional hex coords
  const q = x / (size * SQRT3);
  const rBase = (y - (Math.round(q) % 2 !== 0 ? size * 0.75 : 0)) / (size * 1.5);

  // Round to nearest cell — check this cell and its neighbors
  const q0 = Math.round(q);
  const r0 = Math.round(rBase);

  let bestQ = q0, bestR = r0, bestDist = Infinity;
  for (let dq = -1; dq <= 1; dq++) {
    for (let dr = -1; dr <= 1; dr++) {
      const tq = q0 + dq, tr = r0 + dr;
      const p = hexToPixel(tq, tr, size);
      const dist = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (dist < bestDist) { bestDist = dist; bestQ = tq; bestR = tr; }
    }
  }
  return { q: bestQ, r: bestR };
}

/** Get the 6 neighbors of a hex cell. */
export function hexNeighbors(q, r) {
  const isOdd = q % 2 !== 0;
  if (isOdd) {
    return [
      { q: q + 1, r: r },     // right-top
      { q: q + 1, r: r + 1 }, // right-bottom
      { q: q, r: r + 1 },     // bottom
      { q: q - 1, r: r + 1 }, // left-bottom
      { q: q - 1, r: r },     // left-top
      { q: q, r: r - 1 },     // top
    ];
  }
  return [
    { q: q + 1, r: r - 1 }, // right-top
    { q: q + 1, r: r },     // right-bottom
    { q: q, r: r + 1 },     // bottom
    { q: q - 1, r: r },     // left-bottom
    { q: q - 1, r: r - 1 }, // left-top
    { q: q, r: r - 1 },     // top
  ];
}

/** Grid distance between two hex cells. */
export function hexDistance(q1, r1, q2, r2) {
  // Convert offset to cube coords
  const toCube = (q, r) => {
    const x = q;
    const z = r - (q - (q & 1)) / 2;
    const y = -x - z;
    return { x, y, z };
  };
  const a = toCube(q1, r1);
  const b = toCube(q2, r2);
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));
}

/** Get all cells within radius of a center cell. */
export function hexRing(cq, cr, radius) {
  const cells = [];
  for (let q = cq - radius; q <= cq + radius; q++) {
    for (let r = cr - radius; r <= cr + radius; r++) {
      if (hexDistance(cq, cr, q, r) <= radius) {
        cells.push({ q, r });
      }
    }
  }
  return cells;
}

/** Draw a single flat-top hexagon on canvas at pixel center (cx, cy). */
export function drawHexCell(ctx, cx, cy, size, fill, stroke, lineWidth = 1) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i;
    const px = cx + size * Math.cos(angle);
    const py = cy + size * Math.sin(angle);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.stroke(); }
}

/** Draw hex grid lines for cells near occupied positions. */
export function drawHexGrid(ctx, occupiedCells, size, gridColor = 'rgba(212,165,68,0.08)', fadeRadius = 2) {
  const occupied = new Set(occupiedCells.map(c => `${c.q},${c.r}`));
  const drawn = new Set();

  for (const cell of occupiedCells) {
    // Draw this cell and neighbors within fadeRadius
    const nearby = hexRing(cell.q, cell.r, fadeRadius);
    for (const n of nearby) {
      const key = `${n.q},${n.r}`;
      if (drawn.has(key)) continue;
      drawn.add(key);

      const p = hexToPixel(n.q, n.r, size);
      const dist = hexDistance(cell.q, cell.r, n.q, n.r);
      const alpha = Math.max(0, 1 - dist / (fadeRadius + 1));
      const isOccupied = occupied.has(key);

      // Faint grid line, stronger for occupied cells
      const lineAlpha = isOccupied ? alpha * 0.15 : alpha * 0.06;
      if (lineAlpha > 0.01) {
        drawHexCell(ctx, p.x, p.y, size * 0.98, null, `rgba(212,165,68,${lineAlpha})`, 0.5);
      }
    }
  }
}
