/**
 * Hexis Hex Math — flat-top hexagons, odd-q offset coordinates.
 *
 * Coordinate system:
 *   q = column, r = row
 *   Odd columns shifted down by half a hex height.
 *
 * All functions are pure — no state, no side effects.
 */

const SQRT3 = Math.sqrt(3);

// ─── Coordinate Conversions ───

/**
 * Converts odd-q offset hex coordinates to the pixel center of the hex using
 * a flat-top layout. A 1.06 gap multiplier adds 6% breathing room between
 * cells. Odd columns shift down by half a hex height (√3 × size / 2).
 *
 * @param {number} q - hex column (grid coordinate)
 * @param {number} r - hex row (grid coordinate)
 * @param {number} size - hex radius in pixels (center to vertex)
 * @returns {{x: number, y: number}} pixel center of the hex
 * @example
 * hexToPixel(0, 0, 40) // → { x: 0, y: 0 }
 */
export function hexToPixel(q, r, size) {
  const gap = 1.06; // 6% breathing room between cells
  const x = q * size * 1.5 * gap;
  const y = (r * size * SQRT3 + (q & 1 ? size * SQRT3 * 0.5 : 0)) * gap;
  return { x, y };
}

/**
 * Converts a pixel coordinate to the nearest hex cell in (q, r) offset
 * coordinates. The conversion first makes an approximate column/row estimate
 * from the pixel position, then scans the 3×3 neighborhood around that
 * candidate and picks the cell whose center is closest to (x, y). The
 * neighborhood scan guarantees correctness near seams between columns where
 * the simple rounding would otherwise return the wrong cell.
 *
 * @param {number} x - pixel x-coordinate
 * @param {number} y - pixel y-coordinate
 * @param {number} size - hex radius in pixels
 * @returns {{q: number, r: number}} offset coords of the nearest hex cell
 * @example
 * pixelToHex(0, 0, 40) // → { q: 0, r: 0 }
 */
export function pixelToHex(x, y, size) {
  const gap = 1.06;
  const colW = size * 1.5 * gap;
  const rowH = size * SQRT3 * gap;

  const qf = x / colW;
  const q0 = Math.round(qf);

  const yOffset = (q0 & 1) ? rowH * 0.5 : 0;
  const rf = (y - yOffset) / rowH;
  const r0 = Math.round(rf);

  // Check q0 and neighbors to find the actual closest hex center
  let bestQ = q0, bestR = r0, bestDist = Infinity;
  for (let dq = -1; dq <= 1; dq++) {
    for (let dr = -1; dr <= 1; dr++) {
      const tq = q0 + dq, tr = r0 + dr;
      const p = hexToPixel(tq, tr, size);
      const dist = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (dist < bestDist) {
        bestDist = dist;
        bestQ = tq;
        bestR = tr;
      }
    }
  }
  return { q: bestQ, r: bestR };
}

// ─── Neighbors ───

/**
 * Returns the 6 neighbor cells of (q, r) using odd-q offset parity.
 * The neighbor set differs for odd vs even columns because of the staggered
 * offset grid layout.
 * Order is not guaranteed; callers should treat the result as a set.
 *
 * @param {number} q — hex column
 * @param {number} r — hex row
 * @returns {Array<{q: number, r: number}>} array of 6 neighbor cells
 * @example hexNeighbors(0, 0).length // → 6
 */
export function hexNeighbors(q, r) {
  const odd = q & 1;
  return odd ? [
    { q: q + 1, r },     { q: q + 1, r: r + 1 },
    { q,     r: r + 1 }, { q: q - 1, r: r + 1 },
    { q: q - 1, r },     { q,     r: r - 1 },
  ] : [
    { q: q + 1, r: r - 1 }, { q: q + 1, r },
    { q,     r: r + 1 },    { q: q - 1, r },
    { q: q - 1, r: r - 1 }, { q,     r: r - 1 },
  ];
}

// ─── Distance ───

/**
 * Grid distance (minimum number of steps) between two hex cells.
 * Converts both cells from odd-q offset to cube coordinates, then takes the
 * Chebyshev distance (max of absolute axis differences).
 * Symmetric: `hexDistance(a, b) === hexDistance(b, a)`.
 * @param {number} q1 — first cell column
 * @param {number} r1 — first cell row
 * @param {number} q2 — second cell column
 * @param {number} r2 — second cell row
 * @returns {number} integer step distance (0 when cells are equal)
 * @example hexDistance(0, 0, 2, 1) // → 2
 */
export function hexDistance(q1, r1, q2, r2) {
  const ax = q1, az = r1 - (q1 - (q1 & 1)) / 2, ay = -ax - az;
  const bx = q2, bz = r2 - (q2 - (q2 & 1)) / 2, by = -bx - bz;
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by), Math.abs(az - bz));
}

// ─── Drawing ───

/**
 * Draws a flat-top hexagonal path onto a Canvas2D context centered at (cx, cy)
 * with the given radius. Issues `beginPath` / `moveTo` / `lineTo` / `closePath`
 * only — caller is responsible for calling `stroke()` or `fill()`.
 *
 * @param {CanvasRenderingContext2D} ctx — Canvas2D rendering context
 * @param {number} cx — center x in pixels
 * @param {number} cy — center y in pixels
 * @param {number} size — hex radius in pixels
 * @example hexPath(ctx, 100, 100, 40); ctx.fill();
 */
export function hexPath(ctx, cx, cy, size) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i;
    const px = cx + size * Math.cos(angle);
    const py = cy + size * Math.sin(angle);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/**
 * Returns the 6 flat-top vertex positions of a hex centered at (cx, cy).
 * Each vertex lies exactly `size` pixels from the center.
 * @param {number} cx — center x in pixels
 * @param {number} cy — center y in pixels
 * @param {number} size — hex radius in pixels
 * @returns {Array<{x: number, y: number}>} array of 6 vertex coordinates starting at angle 0 and rotating counter-clockwise in canvas space
 * @example
 * hexVertices(0, 0, 40).length // → 6
 */
export function hexVertices(cx, cy, size) {
  const verts = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i;
    verts.push({
      x: cx + size * Math.cos(angle),
      y: cy + size * Math.sin(angle),
    });
  }
  return verts;
}

// ─── Viewport Culling ───

/**
 * Computes the inclusive (q, r) bounding box of hex cells that may overlap a
 * rectangular viewport. Adds a 2-cell buffer — a margin of `size * 2` pixels
 * expanded outward from each viewport edge, plus a ±1 cell pad on each side —
 * so cells straddling the viewport boundary are still drawn.
 * Result is used by the renderer for viewport culling.
 *
 * @param {number} viewMinX — viewport left edge in world pixels
 * @param {number} viewMinY — viewport top edge in world pixels
 * @param {number} viewMaxX — viewport right edge in world pixels
 * @param {number} viewMaxY — viewport bottom edge in world pixels
 * @param {number} size — hex radius in pixels
 * @returns {{minQ: number, maxQ: number, minR: number, maxR: number}} inclusive cell bounds
 * @example getVisibleHexRange(-200, -200, 200, 200, 40)
 */
export function getVisibleHexRange(viewMinX, viewMinY, viewMaxX, viewMaxY, size) {
  const margin = size * 2; // extra buffer
  const tl = pixelToHex(viewMinX - margin, viewMinY - margin, size);
  const br = pixelToHex(viewMaxX + margin, viewMaxY + margin, size);
  return {
    minQ: tl.q - 1,
    maxQ: br.q + 1,
    minR: tl.r - 1,
    maxR: br.r + 1,
  };
}

/**
 * AABB test — returns true if (q, r) falls within the inclusive bounds
 * produced by `getVisibleHexRange`.
 *
 * @param {number} q — hex column to test
 * @param {number} r — hex row to test
 * @param {{minQ: number, maxQ: number, minR: number, maxR: number}} range — bounds from getVisibleHexRange
 * @returns {boolean} true if the cell is inside the range
 * @example isHexVisible(0, 0, { minQ: -5, maxQ: 5, minR: -5, maxR: 5 }) // → true
 */
export function isHexVisible(q, r, range) {
  return q >= range.minQ && q <= range.maxQ && r >= range.minR && r <= range.maxR;
}

// ─── Hit Testing ───

/**
 * Point-in-hex hit test for flat-top hexagons. First does an AABB reject
 * (half-width `size`, half-height `size * √3/2`), then checks the sloped
 * edges via `dx + dy/√3 <= size`. Used for click/hover hit detection.
 *
 * @param {number} px — test point x in pixels
 * @param {number} py — test point y in pixels
 * @param {number} cx — hex center x in pixels
 * @param {number} cy — hex center y in pixels
 * @param {number} size — hex radius in pixels
 * @returns {boolean} true when (px, py) lies inside the hex
 * @example pointInHex(0, 0, 0, 0, 40) // → true
 */
export function pointInHex(px, py, cx, cy, size) {
  const dx = Math.abs(px - cx);
  const dy = Math.abs(py - cy);
  // Quick AABB reject — flat-top: half-width = size, half-height = size * √3/2
  if (dx > size || dy > size * SQRT3 / 2) return false;
  // Sloped edge: line from (size, 0) to (size/2, size*√3/2)
  return dx + dy / SQRT3 <= size;
}
