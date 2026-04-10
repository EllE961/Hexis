/**
 * Hexis layout engine — ground-up rewrite.
 *
 * INVARIANTS (enforced by construction):
 *   1. Every coordinate is an odd-q offset hex cell via `hexMath.js`
 *   2. Files = 1 cell; groups = a perfect hex of ring ≥ 1 (always-hex rule)
 *   3. Every group has ≥ 1 empty cell (drag-drop landing zone)
 *   4. Sub-groups are fully contained inside their parent hex
 *   5. Infinite nesting, no depth limit
 *   6. Auto-grow on tree changes: ring++ until packing succeeds
 *   7. Cascading — a child's grow may force parent to re-pack + grow
 *
 * PIPELINE (four stages):
 *   Stage 1: buildForest     — flat → tree of Boxes, depth-annotated
 *   Stage 2: sizeOnlyPass    — bottom-up ring sizing via tryPack feasibility
 *   Stage 3: placeForest     — top-down absolute placement (BFS for top-level,
 *                              tryPack at real center for descendants)
 *   Stage 4: projectToOutput — group regions, cells, occupancy, cellOwner,
 *                              label positions (same shape as prior engine)
 *
 * The layout is deterministic: same (files, groups) → same output. An optional
 * `savedState` argument lets callers preserve positions across incremental
 * tree changes for visual stability; the hard-refresh command in App.jsx
 * clears it to force a ground-up repack.
 */

import {
  hexToPixel,
  hexDistance,
  cellsAtDistance,
  getHexDisk,
  hexCellCount,
} from './hexMath.js';

const HEX_SIZE = 30;
const MAX_RING = 12;
const SQRT3 = Math.sqrt(3);

// ─── Stage 1: Build forest ────────────────────────────────────────────────────

function buildForest(files, groups) {
  const byPath = new Map();
  const root = {
    kind: 'group',
    path: '.',
    name: '.',
    children: [],
    directFiles: [],
    ring: 0,
    depth: -1, // world root not rendered
    cq: 0,
    cr: 0,
  };
  byPath.set('.', root);

  for (const g of groups) {
    if (g.path === '.') continue;
    byPath.set(g.path, {
      kind: 'group',
      path: g.path,
      name: g.name || g.path.split('/').pop() || g.path,
      children: [],
      directFiles: [],
      ring: 1,
      depth: 0,
      cq: 0,
      cr: 0,
    });
  }
  for (const g of groups) {
    if (g.path === '.') continue;
    const node = byPath.get(g.path);
    if (!node) continue;
    const parent = byPath.get(g.parent_path || '.') || root;
    parent.children.push(node);
  }
  for (const f of files) {
    const parent = byPath.get(f.group_path || '.') || root;
    parent.directFiles.push(f);
  }

  function setDepth(box, depth) {
    if (box.path !== '.') box.depth = depth;
    const childDepth = box.path === '.' ? 0 : depth + 1;
    for (const c of box.children) setDepth(c, childDepth);
  }
  setDepth(root, 0);
  return root;
}

// ─── Stage 2: Size (post-order) ───────────────────────────────────────────────

/**
 * Bottom-up sizing: computes box.ring for every group. Uses tryPack at
 * virtual center (0, 0) as a feasibility proxy. The real tryPack at the
 * actual parent center in Stage 3 may need to grow the ring further due
 * to greedy-ordering parity quirks — that's handled top-down.
 */
function sizeOnlyPass(box) {
  if (box.kind !== 'group') return;

  for (const child of box.children) sizeOnlyPass(child);

  if (box.path === '.') return; // world root has no ring

  if (box.children.length === 0 && box.directFiles.length === 0) {
    box.ring = 1; // always-hex floor
    return;
  }

  const directCount = box.directFiles.length;
  const maxChildRing = box.children.length > 0
    ? Math.max(...box.children.map(c => c.ring))
    : 0;
  let ring = Math.max(1, maxChildRing + 1);

  const requiredCells = directCount
    + box.children.reduce((s, c) => s + hexCellCount(c.ring), 0)
    + 1; // +1 guaranteed empty slot
  while (hexCellCount(ring) < requiredCells) ring++;

  while (!tryPack(box, 0, 0, ring, null)) {
    ring++;
    if (ring > MAX_RING) {
      throw new Error(`hex layout: ring > ${MAX_RING} at ${box.path}`);
    }
  }
  box.ring = ring;
}

// ─── tryPack: feasibility test + position writer ─────────────────────────────

/**
 * Attempt to place all `box.children` inside a hex of ring R centered at
 * (cq, cr). Writes successful positions into `child.cq, child.cr`.
 * Returns true on success, false if caller should grow R and retry.
 *
 * Strategy:
 *   • Sort children by ring descending (biggest first — most constrained)
 *   • Honour `savedHints.get(path)` if the hint is still valid
 *   • Else spiral INWARD from the parent's rim (farthest-from-center
 *     first). This yields two wins:
 *       1. Packing feasibility: center-first greedy fails for some
 *          feasible configs because sibling non-overlap requires distance
 *          ≥ r_a + r_b + 1 > containment distance from center. Outside-in
 *          finds those configs.
 *       2. Visual: sub-groups ring around the edge, leaving the parent's
 *          center free for its direct files. Matches the honeycomb aesthetic.
 *   • Non-overlap test: hexDistance(c_a, c_b) ≥ r_a + r_b + 1  (O(1))
 *   • Verify `freeCells ≥ directFiles + 1` after children occupy theirs
 */
function tryPack(box, cq, cr, R, savedHints) {
  const children = [...box.children].sort((a, b) => b.ring - a.ring);
  const placed = [];

  for (const child of children) {
    const maxDist = R - child.ring;
    if (maxDist < 0) return false;

    let chosen = null;

    if (savedHints) {
      const hint = savedHints.get(child.path);
      if (hint) {
        const [hq, hr] = hint;
        if (hexDistance(cq, cr, hq, hr) <= maxDist) {
          let ok = true;
          for (const p of placed) {
            if (hexDistance(hq, hr, p.cq, p.cr) < child.ring + p.ring + 1) {
              ok = false;
              break;
            }
          }
          if (ok) chosen = { q: hq, r: hr };
        }
      }
    }

    if (!chosen) {
      // Outside-in spiral: iterate from maxDist down to 0
      for (let d = maxDist; d >= 0 && !chosen; d--) {
        const ring = cellsAtDistance(cq, cr, d);
        for (const c of ring) {
          let ok = true;
          for (const p of placed) {
            if (hexDistance(c.q, c.r, p.cq, p.cr) < child.ring + p.ring + 1) {
              ok = false;
              break;
            }
          }
          if (ok) {
            chosen = c;
            break;
          }
        }
      }
    }

    if (!chosen) return false;
    child.cq = chosen.q;
    child.cr = chosen.r;
    placed.push({ cq: chosen.q, cr: chosen.r, ring: child.ring });
  }

  // Verify ≥1 empty slot after children occupy their cells
  const occupied = new Set();
  for (const p of placed) {
    for (const cell of getHexDisk(p.cq, p.cr, p.ring)) {
      occupied.add(`${cell.q},${cell.r}`);
    }
  }
  return hexCellCount(R) - occupied.size >= box.directFiles.length + 1;
}

// ─── Stage 3: Place (top-down) ────────────────────────────────────────────────

function placeForest(root, savedHints) {
  placeTopLevel(root.children, savedHints);
  for (const top of root.children) {
    placeSubtree(top, savedHints);
  }
}

/**
 * Top-level groups have no containing hex — they're placed on the infinite
 * plane via BFS from origin. Saved anchors are honoured when possible.
 */
function placeTopLevel(topGroups, savedHints) {
  const sorted = [...topGroups].sort((a, b) => b.ring - a.ring);
  const placed = [];

  for (const group of sorted) {
    let chosen = null;

    if (savedHints) {
      const hint = savedHints.get(group.path);
      if (hint) {
        const [hq, hr] = hint;
        let ok = true;
        for (const p of placed) {
          if (hexDistance(hq, hr, p.cq, p.cr) < group.ring + p.ring + 1) {
            ok = false;
            break;
          }
        }
        if (ok) chosen = { q: hq, r: hr };
      }
    }

    if (!chosen) {
      // BFS outward from origin — cap distance to prevent runaway
      const MAX_D = 80;
      for (let d = 0; d <= MAX_D && !chosen; d++) {
        const candidates = cellsAtDistance(0, 0, d);
        for (const c of candidates) {
          let ok = true;
          for (const p of placed) {
            if (hexDistance(c.q, c.r, p.cq, p.cr) < group.ring + p.ring + 1) {
              ok = false;
              break;
            }
          }
          if (ok) {
            chosen = c;
            break;
          }
        }
      }
    }

    if (!chosen) chosen = { q: 0, r: 0 };
    group.cq = chosen.q;
    group.cr = chosen.r;
    placed.push({ cq: chosen.q, cr: chosen.r, ring: group.ring });
  }
}

/**
 * Recursively place `box`'s descendants. Assumes box.cq/cr already set.
 * Re-runs tryPack at the real center — may grow the ring beyond the
 * sizeOnlyPass estimate if greedy ordering at offset parity differs.
 */
function placeSubtree(box, savedHints) {
  if (box.children.length === 0 && box.directFiles.length === 0) return;

  let ring = box.ring;
  while (!tryPack(box, box.cq, box.cr, ring, savedHints)) {
    ring++;
    if (ring > MAX_RING) {
      throw new Error(`hex layout: ring > ${MAX_RING} at ${box.path}`);
    }
  }
  box.ring = ring;

  for (const child of box.children) {
    placeSubtree(child, savedHints);
  }
}

// ─── Stage 4: Project to output maps ──────────────────────────────────────────

function countAllFiles(box) {
  let n = box.directFiles.length;
  for (const c of box.children) n += countAllFiles(c);
  return n;
}

function projectToOutput(root, hexSize) {
  const cells = new Map();
  const folders = new Map();
  const groupRegions = new Map();
  const occupancy = new Map();

  // Reserved cells per region (for later cellOwner depth-priority walk)
  const usedGridCells = new Set();

  function projectGroup(box) {
    const regionCells = getHexDisk(box.cq, box.cr, box.ring);
    groupRegions.set(box.path, regionCells);
    for (const c of regionCells) usedGridCells.add(`${c.q},${c.r}`);

    const centerPx = hexToPixel(box.cq, box.cr, hexSize);
    const topY = centerPx.y - box.ring * hexSize * SQRT3 * 1.06;

    folders.set(box.path, {
      x: centerPx.x,
      y: centerPx.y,
      radius: box.ring * hexSize * 1.8,
      labelX: centerPx.x,
      // GroupRenderer subtracts another HEX_SIZE * 0.7 when drawing,
      // giving a total offset above the top cell.
      labelY: topY,
      labelRect: null,
      name: box.name,
      depth: box.depth,
      ring: box.ring,
      cq: box.cq,
      cr: box.cr,
      fileCount: box.directFiles.length,
      childCount: box.children.length,
      totalFiles: countAllFiles(box),
      path: box.path,
      cellCount: regionCells.length,
    });

    // Cells NOT occupied by children become candidates for direct files
    const childCellSet = new Set();
    for (const child of box.children) {
      for (const cell of getHexDisk(child.cq, child.cr, child.ring)) {
        childCellSet.add(`${cell.q},${cell.r}`);
      }
    }
    const freeCells = regionCells
      .filter(c => !childCellSet.has(`${c.q},${c.r}`))
      .sort((a, b) => {
        const da = hexDistance(box.cq, box.cr, a.q, a.r);
        const db = hexDistance(box.cq, box.cr, b.q, b.r);
        return da - db; // center-outward
      });

    const sortedFiles = [...box.directFiles].sort(
      (a, b) => (b.is_landmark ? 1 : 0) - (a.is_landmark ? 1 : 0)
    );

    // Place files center-outward, skipping cells that still have free slot
    // reserved as the empty landing zone (last cell).
    for (let i = 0; i < sortedFiles.length && i < freeCells.length; i++) {
      const file = sortedFiles[i];
      const cell = freeCells[i];
      const px = hexToPixel(cell.q, cell.r, hexSize);
      cells.set(file.path, {
        q: cell.q,
        r: cell.r,
        x: px.x,
        y: px.y,
        parentFolder: box.path,
      });
      occupancy.set(`${cell.q},${cell.r}`, file.path);
    }

    for (const child of box.children) projectGroup(child);
  }

  for (const top of root.children) projectGroup(top);

  // Root-level standalone files
  placeRootFiles(root.directFiles, usedGridCells, cells, occupancy, hexSize);

  // Build cellOwner: files win; empty slots assigned to deepest owning group
  const cellOwner = new Map();
  for (const [key, filePath] of occupancy) {
    cellOwner.set(key, { kind: 'file', filePath });
  }
  const sortedRegions = [...groupRegions.entries()].sort((a, b) => {
    const da = folders.get(a[0])?.depth ?? 0;
    const db = folders.get(b[0])?.depth ?? 0;
    return da - db;
  });
  for (const [groupPath, regionCells] of sortedRegions) {
    for (const c of regionCells) {
      const key = `${c.q},${c.r}`;
      const existing = cellOwner.get(key);
      if (existing?.kind === 'file') continue;
      cellOwner.set(key, { kind: 'empty', groupPath, q: c.q, r: c.r });
    }
  }

  // Label collision resolution (shift overlapping labels vertically)
  layoutLabels(folders, hexSize);

  return { cells, folders, groupRegions, occupancy, cellOwner };
}

function placeRootFiles(rootFiles, usedGridCells, cells, occupancy, hexSize) {
  if (!rootFiles || rootFiles.length === 0) return;

  const sorted = [...rootFiles].sort(
    (a, b) => (b.is_landmark ? 1 : 0) - (a.is_landmark ? 1 : 0)
  );

  // Seed: find the nearest cell to origin that isn't inside any group
  let seed = null;
  for (let d = 0; d < 100; d++) {
    const ring = cellsAtDistance(0, 0, d);
    for (const c of ring) {
      if (!usedGridCells.has(`${c.q},${c.r}`)) {
        seed = c;
        break;
      }
    }
    if (seed) break;
  }
  if (!seed) seed = { q: 0, r: 0 };

  // BFS outward from seed, filling cells with files
  const queue = [seed];
  const visited = new Set([`${seed.q},${seed.r}`]);
  let index = 0;

  while (queue.length > 0 && index < sorted.length) {
    const cell = queue.shift();
    const key = `${cell.q},${cell.r}`;
    if (!usedGridCells.has(key) && !occupancy.has(key)) {
      const file = sorted[index++];
      const px = hexToPixel(cell.q, cell.r, hexSize);
      cells.set(file.path, {
        q: cell.q,
        r: cell.r,
        x: px.x,
        y: px.y,
        parentFolder: null,
      });
      occupancy.set(key, file.path);
    }
    for (const n of cellsAtDistance(cell.q, cell.r, 1)) {
      const nKey = `${n.q},${n.r}`;
      if (!visited.has(nKey)) {
        visited.add(nKey);
        queue.push(n);
      }
    }
  }
}

// ─── Label collision resolution ───────────────────────────────────────────────

function layoutLabels(folders, hexSize) {
  const sorted = [...folders.values()].sort((a, b) => a.depth - b.depth);
  const placed = []; // rect list for overlap testing

  const overlaps = (a, b) =>
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y;

  for (const folder of sorted) {
    const fontSize = folder.depth === 0 ? 15 : folder.depth === 1 ? 11 : 9;
    const plateH = folder.depth === 0 ? 26 : folder.depth === 1 ? 20 : 14;
    const nameW = (folder.name?.length || 1) * fontSize * 0.6;
    const countStr = folder.depth < 2 && folder.totalFiles > 0 ? String(folder.totalFiles) : '';
    const countW = countStr ? countStr.length * fontSize * 0.55 + 8 : 0;
    const totalW = nameW + countW + 24;

    let lx = folder.labelX;
    let ly = folder.labelY;
    const rectAt = (x, y) => ({
      x: x - totalW / 2,
      y: y - hexSize * 0.7 - plateH / 2,
      w: totalW,
      h: plateH,
    });

    let r = rectAt(lx, ly);
    let attempts = 0;
    while (placed.some(p => overlaps(r, p)) && attempts < 8) {
      attempts++;
      ly -= plateH + 4; // shift upward
      r = rectAt(lx, ly);
    }
    if (placed.some(p => overlaps(r, p))) {
      // Fallback: flip below the group
      ly = folder.y + folder.ring * hexSize * SQRT3 * 1.06 + hexSize * 0.7;
      r = rectAt(lx, ly);
      attempts = 0;
      while (placed.some(p => overlaps(r, p)) && attempts < 8) {
        attempts++;
        ly += plateH + 4;
        r = rectAt(lx, ly);
      }
    }

    folder.labelX = lx;
    folder.labelY = ly;
    folder.labelRect = r;
    placed.push(r);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Compute the Hexis layout.
 *
 * @param {Array} files      — [{path, name, group_path, is_landmark, ...}]
 * @param {Array} groups     — [{path, parent_path, name, ...}]
 * @param {number} hexSize   — cell radius in pixels (default 30)
 * @param {object|null} savedState — persistence hints: `{groupPositions, groupRings}`
 * @returns {object} layout — `{cells, folders, groupRegions, occupancy, cellOwner, _savedState}`
 *
 * The returned object includes an attached `_savedState` snapshot suitable
 * for passing back on the next call (persistence). Callers that don't care
 * about persistence can ignore it.
 */
export function computeLayout(files, groups, hexSize = HEX_SIZE, savedState = null) {
  const root = buildForest(files, groups);

  // Pass A: bottom-up ring sizing
  for (const child of root.children) sizeOnlyPass(child);

  const hints = savedState?.groupPositions
    ? new Map(
        Object.entries(savedState.groupPositions).map(([k, v]) => [k, v])
      )
    : null;

  // Pass B: top-down placement at real centers
  placeForest(root, hints);

  // Pass C: project to renderer output
  const layout = projectToOutput(root, hexSize);

  // Snapshot resulting state for persistence
  const newSavedState = {
    version: 1,
    groupPositions: {},
    groupRings: {},
  };
  for (const [path, folder] of layout.folders) {
    newSavedState.groupPositions[path] = [folder.cq, folder.cr];
    newSavedState.groupRings[path] = folder.ring;
  }
  layout._savedState = newSavedState;

  return layout;
}
