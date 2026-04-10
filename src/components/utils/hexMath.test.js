import { describe, it, expect } from 'vitest';
import {
  hexToPixel,
  pixelToHex,
  hexNeighbors,
  hexDistance,
  hexVertices,
  getVisibleHexRange,
  isHexVisible,
  pointInHex,
  hexCellCount,
  cellsAtDistance,
  getHexDisk,
} from './hexMath.js';

const SQRT3 = Math.sqrt(3);
const SIZE = 40;

// ─── hexToPixel ───────────────────────────────────────────────────────────────

describe('hexToPixel', () => {
  it('returns (0, 0) for origin hex', () => {
    const { x, y } = hexToPixel(0, 0, SIZE);
    expect(x).toBeCloseTo(0, 5);
    expect(y).toBeCloseTo(0, 5);
  });

  it('applies no vertical offset for even columns', () => {
    // q=2 (even), r=0 → y should be 0
    const { y } = hexToPixel(2, 0, SIZE);
    expect(y).toBeCloseTo(0, 5);
  });

  it('applies 0.5 * SQRT3 * size vertical offset for odd columns', () => {
    // q=1 (odd), r=0 → y = size * SQRT3 * 0.5 * 1.06
    const { y } = hexToPixel(1, 0, SIZE);
    const expected = SIZE * SQRT3 * 0.5 * 1.06;
    expect(y).toBeCloseTo(expected, 5);
  });

  it('correct x spacing uses 1.5 * size * gap', () => {
    const { x } = hexToPixel(1, 0, SIZE);
    expect(x).toBeCloseTo(SIZE * 1.5 * 1.06, 5);
  });
});

// ─── pixelToHex round-trip ────────────────────────────────────────────────────

describe('pixelToHex ↔ hexToPixel round-trip', () => {
  it('recovers original (q, r) for all cells in [-3, 3] × [-3, 3]', () => {
    for (let q = -3; q <= 3; q++) {
      for (let r = -3; r <= 3; r++) {
        const { x, y } = hexToPixel(q, r, SIZE);
        const result = pixelToHex(x, y, SIZE);
        expect(result.q).toBe(q);
        expect(result.r).toBe(r);
      }
    }
  });
});

// ─── hexNeighbors + hexDistance ───────────────────────────────────────────────

describe('hexNeighbors', () => {
  it('returns exactly 6 neighbors for an even column', () => {
    expect(hexNeighbors(0, 0)).toHaveLength(6);
  });

  it('returns exactly 6 neighbors for an odd column', () => {
    expect(hexNeighbors(1, 0)).toHaveLength(6);
  });

  it('each neighbor of an even-q cell is distance 1 from center', () => {
    const center = { q: 0, r: 0 };
    for (const n of hexNeighbors(center.q, center.r)) {
      expect(hexDistance(center.q, center.r, n.q, n.r)).toBe(1);
    }
  });

  it('each neighbor of an odd-q cell is distance 1 from center', () => {
    const center = { q: 1, r: 0 };
    for (const n of hexNeighbors(center.q, center.r)) {
      expect(hexDistance(center.q, center.r, n.q, n.r)).toBe(1);
    }
  });
});

// ─── hexDistance ─────────────────────────────────────────────────────────────

describe('hexDistance', () => {
  it('distance from a cell to itself is 0', () => {
    expect(hexDistance(3, -2, 3, -2)).toBe(0);
  });

  it('is symmetric: distance(a,b) === distance(b,a)', () => {
    const pairs = [
      [0, 0, 2, 1],
      [1, 0, -1, 3],
      [-2, -2, 3, 3],
      [0, 5, 5, 0],
    ];
    for (const [q1, r1, q2, r2] of pairs) {
      expect(hexDistance(q1, r1, q2, r2)).toBe(hexDistance(q2, r2, q1, r1));
    }
  });
});

// ─── hexVertices ─────────────────────────────────────────────────────────────

describe('hexVertices', () => {
  it('returns exactly 6 vertices', () => {
    expect(hexVertices(0, 0, SIZE)).toHaveLength(6);
  });

  it('each vertex is at distance ~size from the center', () => {
    const cx = 100, cy = 200;
    for (const v of hexVertices(cx, cy, SIZE)) {
      const dist = Math.hypot(v.x - cx, v.y - cy);
      expect(dist).toBeCloseTo(SIZE, 5);
    }
  });
});

// ─── getVisibleHexRange + isHexVisible ────────────────────────────────────────

describe('getVisibleHexRange / isHexVisible', () => {
  const range = getVisibleHexRange(-200, -200, 200, 200, SIZE);

  it('minQ <= maxQ', () => {
    expect(range.minQ).toBeLessThanOrEqual(range.maxQ);
  });

  it('minR <= maxR', () => {
    expect(range.minR).toBeLessThanOrEqual(range.maxR);
  });

  it('origin cell (0,0) is visible inside the viewport range', () => {
    expect(isHexVisible(0, 0, range)).toBe(true);
  });

  it('a cell far outside the viewport is not visible', () => {
    expect(isHexVisible(1000, 1000, range)).toBe(false);
  });
});

// ─── pointInHex ──────────────────────────────────────────────────────────────

describe('pointInHex', () => {
  it('returns true at the center of the hex', () => {
    expect(pointInHex(0, 0, 0, 0, SIZE)).toBe(true);
  });

  it('returns true for a point clearly inside the hex', () => {
    // Small offset — well within bounds
    expect(pointInHex(5, 5, 0, 0, SIZE)).toBe(true);
  });

  it('returns false for a point well outside the hex', () => {
    // Two radii away — clearly outside
    expect(pointInHex(SIZE * 2, SIZE * 2, 0, 0, SIZE)).toBe(false);
  });

  it('returns false beyond the half-width boundary', () => {
    // dx > size → AABB reject
    expect(pointInHex(SIZE + 1, 0, 0, 0, SIZE)).toBe(false);
  });

  it('returns false beyond the half-height boundary', () => {
    // dy > size * SQRT3/2 → AABB reject
    expect(pointInHex(0, SIZE * SQRT3 / 2 + 1, 0, 0, SIZE)).toBe(false);
  });
});

// ─── hexCellCount ─────────────────────────────────────────────────────────────

describe('hexCellCount', () => {
  it('ring 0 → 1 cell', () => {
    expect(hexCellCount(0)).toBe(1);
  });

  it('follows 3r² + 3r + 1 for rings 1-5', () => {
    expect(hexCellCount(1)).toBe(7);
    expect(hexCellCount(2)).toBe(19);
    expect(hexCellCount(3)).toBe(37);
    expect(hexCellCount(4)).toBe(61);
    expect(hexCellCount(5)).toBe(91);
  });
});

// ─── cellsAtDistance ──────────────────────────────────────────────────────────

describe('cellsAtDistance', () => {
  it('distance 0 → exactly one cell at origin', () => {
    const cells = cellsAtDistance(0, 0, 0);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toEqual({ q: 0, r: 0 });
  });

  it('distance d → exactly 6d cells for d = 1..5', () => {
    for (let d = 1; d <= 5; d++) {
      expect(cellsAtDistance(0, 0, d)).toHaveLength(6 * d);
    }
  });

  it('every returned cell is at exactly distance d', () => {
    for (let d = 1; d <= 4; d++) {
      for (const c of cellsAtDistance(0, 0, d)) {
        expect(hexDistance(0, 0, c.q, c.r)).toBe(d);
      }
    }
  });

  it('works with non-origin centers', () => {
    const cells = cellsAtDistance(5, 3, 2);
    expect(cells).toHaveLength(12);
    for (const c of cells) {
      expect(hexDistance(5, 3, c.q, c.r)).toBe(2);
    }
  });

  it('produces no duplicates', () => {
    const cells = cellsAtDistance(0, 0, 3);
    const keys = new Set(cells.map(c => `${c.q},${c.r}`));
    expect(keys.size).toBe(cells.length);
  });
});

// ─── getHexDisk ───────────────────────────────────────────────────────────────

describe('getHexDisk', () => {
  it('ring 0 → just the center cell', () => {
    expect(getHexDisk(0, 0, 0)).toHaveLength(1);
  });

  it('produces hexCellCount(r) cells for ring r', () => {
    for (let r = 0; r <= 5; r++) {
      expect(getHexDisk(0, 0, r)).toHaveLength(hexCellCount(r));
    }
  });

  it('every cell has distance ≤ r from center', () => {
    for (const c of getHexDisk(0, 0, 3)) {
      expect(hexDistance(0, 0, c.q, c.r)).toBeLessThanOrEqual(3);
    }
  });

  it('contains all cells from cellsAtDistance(0..r)', () => {
    const disk = new Set(getHexDisk(0, 0, 2).map(c => `${c.q},${c.r}`));
    for (let d = 0; d <= 2; d++) {
      for (const c of cellsAtDistance(0, 0, d)) {
        expect(disk.has(`${c.q},${c.r}`)).toBe(true);
      }
    }
  });
});
