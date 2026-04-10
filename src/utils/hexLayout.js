/**
 * Hexis Layout — perfect hex-in-hex grid snapping.
 *
 * Everything on ONE hex grid. Folders are perfect hex shapes (rings of cells).
 * Files are individual cells inside their folder hex.
 *
 * Hex ring sizes (perfect hexagonal numbers):
 *   ring 0: 1 cell      ring 1: 7 cells     ring 2: 19 cells
 *   ring 3: 37 cells    ring 4: 61 cells    ring 5: 91 cells
 *
 * Formula: cells_in_ring(n) = 3n² + 3n + 1
 */

import { hexToPixel, hexNeighbors, hexDistance } from './hexMath.js';

const HEX_SIZE = 30;

/** How many cells in a perfect hex of ring radius n. */
function hexCellCount(n) { return 3 * n * n + 3 * n + 1; }

/** Find minimum ring that fits N cells. */
function ringForCount(n) {
  if (n <= 1) return 0;
  for (let r = 1; r <= 10; r++) {
    if (hexCellCount(r) >= n) return r;
  }
  return 10;
}

/** Get all cells in a perfect hex ring of radius `ring` centered at (cq, cr). */
function getHexRingCells(cq, cr, ring) {
  const cells = [];
  for (let q = cq - ring * 2; q <= cq + ring * 2; q++) {
    for (let r = cr - ring * 2; r <= cr + ring * 2; r++) {
      if (hexDistance(cq, cr, q, r) <= ring) {
        cells.push({ q, r });
      }
    }
  }
  return cells;
}

/**
 * Compute layout.
 */
export function computeLayout(files, groups, hexSize = HEX_SIZE) {
  const cells = new Map();
  const folders = new Map();
  const groupRegions = new Map();
  const occupancy = new Map();

  // Build tree
  const filesByGroup = new Map();
  for (const file of files) {
    const gp = file.group_path || '.';
    if (!filesByGroup.has(gp)) filesByGroup.set(gp, []);
    filesByGroup.get(gp).push(file);
  }

  const childGroupsOf = new Map();
  for (const g of groups) {
    if (g.parent_path && g.parent_path !== '.') {
      if (!childGroupsOf.has(g.parent_path)) childGroupsOf.set(g.parent_path, []);
      childGroupsOf.get(g.parent_path).push(g);
    }
  }

  // Root '.' is NOT a group — it's the workspace itself. Files directly at
  // root render as standalone cells next to the real folder clusters, not
  // wrapped in a pseudo-group hex ring. So topGroups excludes '.'.
  const topGroups = groups.filter(g => g.path !== '.' && (!g.parent_path || g.parent_path === '.'));

  // Count all files recursively
  function countAll(gp) {
    let count = (filesByGroup.get(gp) || []).length;
    for (const child of (childGroupsOf.get(gp) || [])) count += countAll(child.path);
    return count;
  }

  // Sort biggest first
  topGroups.sort((a, b) => countAll(b.path) - countAll(a.path));

  // Global grid occupancy
  const gridUsed = new Set();

  // Place each top-level group as a perfect hex shape on a meta-grid
  // Meta-grid: folder centers placed on a hex grid with spacing based on ring size
  const folderPlacements = []; // [{ path, ring, cq, cr }]

  // Calculate cells needed including sub-folder ring overhead + padding
  function cellsNeeded(gp) {
    const directFiles = (filesByGroup.get(gp) || []).length;
    const children = childGroupsOf.get(gp) || [];
    let total = directFiles;
    for (const child of children) {
      const childFiles = countAll(child.path);
      if (childFiles === 0) continue;
      // Sub-folder needs its complete ring
      const childRing = ringForCount(childFiles);
      total += hexCellCount(childRing);
    }
    // Minimal padding for packing slack
    if (children.length > 0) total = Math.ceil(total * 1.08);
    return total;
  }

  for (const group of topGroups) {
    const total = countAll(group.path);
    if (total === 0) continue;
    // Use cellsNeeded which accounts for sub-folder ring overhead
    const neededCells = cellsNeeded(group.path);
    const ring = ringForCount(neededCells);

    // Find placement: first folder at origin, rest adjacent
    let cq, cr;
    if (folderPlacements.length === 0) {
      cq = 0; cr = 0;
    } else {
      // Find a position adjacent to existing folders where this hex fits
      const pos = findAdjacentPlacement(ring, folderPlacements, gridUsed);
      cq = pos.q; cr = pos.r;
    }

    // Claim cells
    const hexCells = getHexRingCells(cq, cr, ring);
    for (const c of hexCells) gridUsed.add(`${c.q},${c.r}`);

    folderPlacements.push({ path: group.path, ring, cq, cr });

    // Place files inside this hex shape
    placeFilesInHex(group.path, group.name || group.path, cq, cr, ring, hexCells, 0,
      filesByGroup, childGroupsOf, cells, folders, groupRegions, occupancy, hexSize);
  }

  // ── Root files: place as standalone cells, NOT as a group ──
  // Root files are not "inside" anything. They cluster adjacent to the
  // existing folder regions via BFS, but they don't get a folder entry,
  // a groupRegion, or a border — they are just loose nodes on the grid.
  const rootFiles = filesByGroup.get('.') || [];
  if (rootFiles.length > 0) {
    placeRootFilesAsCluster(rootFiles, gridUsed, cells, occupancy, hexSize);
  }

  return { cells, folders, groupRegions, occupancy };
}

/**
 * Place root-level files as individual cells adjacent to existing folder
 * clusters. BFS outward from a seed on the boundary of already-used cells,
 * filling the nearest free cells. Landmark files (README, etc) go first.
 */
function placeRootFilesAsCluster(rootFiles, gridUsed, cells, occupancy, hexSize) {
  const sortedFiles = [...rootFiles].sort((a, b) =>
    (b.is_landmark ? 1 : 0) - (a.is_landmark ? 1 : 0));

  // Seed: closest free boundary cell to origin, or origin itself if nothing placed.
  let seed = null;
  if (gridUsed.size === 0) {
    seed = { q: 0, r: 0 };
  } else {
    let bestDist = Infinity;
    for (const key of gridUsed) {
      const [q, r] = key.split(',').map(Number);
      for (const n of hexNeighbors(q, r)) {
        const nk = `${n.q},${n.r}`;
        if (gridUsed.has(nk)) continue;
        const d = Math.abs(n.q) + Math.abs(n.r) + Math.abs(n.q + n.r);
        if (d < bestDist) { bestDist = d; seed = n; }
      }
    }
    if (!seed) seed = { q: 0, r: 0 };
  }

  // BFS outward from seed, placing files into the first N free cells.
  const queue = [seed];
  const visited = new Set([`${seed.q},${seed.r}`]);
  let placed = 0;

  while (queue.length > 0 && placed < sortedFiles.length) {
    const cur = queue.shift();
    const key = `${cur.q},${cur.r}`;

    if (!gridUsed.has(key)) {
      const file = sortedFiles[placed++];
      gridUsed.add(key);
      const pos = hexToPixel(cur.q, cur.r, hexSize);
      cells.set(file.path, {
        q: cur.q, r: cur.r,
        x: pos.x, y: pos.y,
        parentFolder: null, // explicitly ungrouped
      });
      occupancy.set(key, file.path);
    }

    for (const n of hexNeighbors(cur.q, cur.r)) {
      const nk = `${n.q},${n.r}`;
      if (!visited.has(nk)) {
        visited.add(nk);
        queue.push(n);
      }
    }
  }
}

/**
 * Find a grid position where a hex of given ring fits, directly adjacent to existing groups.
 * BFS from the boundary of all placed cells to find a center where the ring fits without overlap
 * and is touching at least one existing cell.
 */
function findAdjacentPlacement(ring, existing, gridUsed) {
  // Collect all boundary cells (cells adjacent to gridUsed but not in gridUsed)
  const boundary = new Set();
  for (const key of gridUsed) {
    const [q, r] = key.split(',').map(Number);
    for (const n of hexNeighbors(q, r)) {
      const nk = `${n.q},${n.r}`;
      if (!gridUsed.has(nk)) boundary.add(nk);
    }
  }

  // For each boundary cell, check if centering a ring hex there fits
  // We need the ring center to be at distance `ring` from the boundary
  // So try cells at distance `ring` outward from each boundary cell
  const tested = new Set();
  let bestQ = 0, bestR = 0, bestScore = -Infinity;

  for (const bKey of boundary) {
    const [bq, br] = bKey.split(',').map(Number);

    // The center of the new hex should be at distance `ring` from this boundary cell
    // Try this boundary cell + ring steps outward
    const candidates = ring === 0 ? [{ q: bq, r: br }] : getHexRingCells(bq, br, ring);

    for (const c of candidates) {
      const ck = `${c.q},${c.r}`;
      if (tested.has(ck)) continue;
      tested.add(ck);

      // Check if a ring hex centered here fits (no overlap with gridUsed)
      const hexCells = getHexRingCells(c.q, c.r, ring);
      const conflicts = hexCells.filter(h => gridUsed.has(`${h.q},${h.r}`)).length;
      if (conflicts > 0) continue;

      // Score: prefer positions that are closest to existing groups (most adjacent)
      let adjacency = 0;
      for (const h of hexCells) {
        for (const n of hexNeighbors(h.q, h.r)) {
          if (gridUsed.has(`${n.q},${n.r}`)) adjacency++;
        }
      }

      // Also prefer positions close to origin
      const distFromOrigin = Math.abs(c.q) + Math.abs(c.r);
      const score = adjacency * 100 - distFromOrigin;

      if (score > bestScore) {
        bestScore = score;
        bestQ = c.q;
        bestR = c.r;
      }
    }

    if (tested.size > 2000) break; // limit search
  }

  if (bestScore > -Infinity) return { q: bestQ, r: bestR };

  // Fallback: BFS from origin for a clear spot
  const visited = new Set();
  const queue = [{ q: 0, r: 0 }];
  while (queue.length > 0) {
    const cur = queue.shift();
    const key = `${cur.q},${cur.r}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const hexCells = getHexRingCells(cur.q, cur.r, ring);
    if (hexCells.every(c => !gridUsed.has(`${c.q},${c.r}`))) return cur;
    for (const n of hexNeighbors(cur.q, cur.r)) {
      if (!visited.has(`${n.q},${n.r}`)) queue.push(n);
    }
    if (visited.size > 500) break;
  }
  return { q: bestQ, r: bestR };
}

/**
 * Place files and sub-folders inside a perfect hex region.
 */
function placeFilesInHex(groupPath, name, cq, cr, ring, hexCells, depth,
  filesByGroup, childGroupsOf, cells, folders, groupRegions, occupancy, hexSize) {

  const directFiles = filesByGroup.get(groupPath) || [];
  const childGroups = childGroupsOf.get(groupPath) || [];

  // Register region
  groupRegions.set(groupPath, [...hexCells]);

  // Folder metadata
  const center = hexToPixel(cq, cr, hexSize);
  let topY = Infinity, topX = center.x;
  for (const c of hexCells) {
    const p = hexToPixel(c.q, c.r, hexSize);
    if (p.y < topY) { topY = p.y; topX = p.x; }
  }

  function countAll(gp) {
    let count = (filesByGroup.get(gp) || []).length;
    for (const child of (childGroupsOf.get(gp) || [])) count += countAll(child.path);
    return count;
  }

  folders.set(groupPath, {
    x: center.x, y: center.y,
    radius: ring * hexSize * 1.8,
    labelX: topX, labelY: topY,
    name: name || groupPath.split('/').pop() || groupPath,
    depth, ring, cq, cr,
    fileCount: directFiles.length,
    childCount: childGroups.length,
    totalFiles: countAll(groupPath),
    path: groupPath,
    cellCount: hexCells.length,
  });

  // Available cells for placement (BFS from center outward)
  const available = [...hexCells].sort((a, b) => {
    const da = hexDistance(cq, cr, a.q, a.r);
    const db = hexDistance(cq, cr, b.q, b.r);
    return da - db; // center first
  });

  const usedInGroup = new Set();

  // Place child sub-folders first (they need contiguous regions)
  const sortedChildren = [...childGroups].sort((a, b) => countAll(b.path) - countAll(a.path));

  for (const child of sortedChildren) {
    const childTotal = countAll(child.path);
    if (childTotal === 0) continue;

    let childRing = ringForCount(childTotal);

    // Find a sub-center within available cells (may reduce ring if needed)
    const subResult = findSubCenter(available, usedInGroup, childRing, cq, cr);
    if (!subResult) continue;
    const subCenter = subResult.center;
    childRing = subResult.ring; // use the actual ring that fits

    // Claim COMPLETE hex ring for this sub-folder
    const ringCells = getHexRingCells(subCenter.q, subCenter.r, childRing);
    const parentSet = new Set(available.map(a => `${a.q},${a.r}`));
    const subCells = [];
    let rejected = [];
    for (const rc of ringCells) {
      const key = `${rc.q},${rc.r}`;
      const inParent = parentSet.has(key);
      const used = usedInGroup.has(key);
      if (inParent && !used) {
        subCells.push(rc);
        usedInGroup.add(key);
      } else {
        rejected.push(`${key}(inP=${inParent},used=${used})`);
      }
    }

    if (subCells.length > 0) {
      placeFilesInHex(child.path, child.name || child.path.split('/').pop(),
        subCenter.q, subCenter.r, childRing, subCells, depth + 1,
        filesByGroup, childGroupsOf, cells, folders, groupRegions, occupancy, hexSize);
    }
  }

  // Place direct files in remaining cells
  const remainingCells = available.filter(c => !usedInGroup.has(`${c.q},${c.r}`));
  const sortedFiles = [...directFiles].sort((a, b) => (b.is_landmark ? 1 : 0) - (a.is_landmark ? 1 : 0));

  for (let i = 0; i < sortedFiles.length && i < remainingCells.length; i++) {
    const cell = remainingCells[i];
    const file = sortedFiles[i];
    const pos = hexToPixel(cell.q, cell.r, hexSize);

    cells.set(file.path, {
      q: cell.q, r: cell.r,
      x: pos.x, y: pos.y,
      parentFolder: groupPath,
    });
    occupancy.set(`${cell.q},${cell.r}`, file.path);
  }
}

/**
 * Find a center for a sub-folder hex where the COMPLETE ring fits.
 * Only accepts positions where 100% of the ring cells are available.
 * Falls back to best partial fit if no perfect fit exists.
 */
function findSubCenter(available, usedInGroup, childRing, parentCQ, parentCR) {
  const freeSet = new Set();
  for (const c of available) {
    if (!usedInGroup.has(`${c.q},${c.r}`)) freeSet.add(`${c.q},${c.r}`);
  }

  const needed = hexCellCount(childRing);
  // Build set of all cells in parent for quick lookup
  const parentSet = new Set(available.map(c => `${c.q},${c.r}`));

  let bestCell = null;
  let bestFit = 0;

  // Sort candidates: prefer cells AWAY from parent center (leaves room for siblings)
  const sortedCandidates = available
    .filter(c => !usedInGroup.has(`${c.q},${c.r}`))
    .sort((a, b) => {
      const da = hexDistance(parentCQ, parentCR, a.q, a.r);
      const db = hexDistance(parentCQ, parentCR, b.q, b.r);
      return db - da; // farthest from center first
    });

  for (const c of sortedCandidates) {
    const ringCells = getHexRingCells(c.q, c.r, childRing);
    let fit = 0;
    let allInParent = true;
    for (const rc of ringCells) {
      const key = `${rc.q},${rc.r}`;
      if (!parentSet.has(key)) { allInParent = false; break; }
      if (freeSet.has(key)) fit++;
    }

    if (allInParent && fit === ringCells.length) {
      return { center: c, ring: childRing }; // PERFECT
    }

    if (allInParent && fit > bestFit) {
      bestFit = fit;
      bestCell = c;
    }
  }

  // Perfect fit found at this ring
  if (bestCell && bestFit === needed) return { center: bestCell, ring: childRing };


  // No perfect fit — try smaller ring
  if (childRing > 0) {
    return findSubCenter(available, usedInGroup, childRing - 1, parentCQ, parentCR);
  }

  // Absolute fallback: ring-0 (single cell)
  for (const c of available) {
    if (!usedInGroup.has(`${c.q},${c.r}`)) return { center: c, ring: 0 };
  }
  return null;
}

/** Find nearest empty cell for drag-drop. */
export function findNearestEmpty(px, py, hexSize, occupancy) {
  const gap = 1.06;
  const SQRT3 = Math.sqrt(3);
  const colW = hexSize * 1.5 * gap;
  const rowH = hexSize * SQRT3 * gap;
  const q0 = Math.round(px / colW);
  const yOff = (q0 & 1) ? rowH * 0.5 : 0;
  const r0 = Math.round((py - yOff) / rowH);

  if (!occupancy.has(`${q0},${r0}`)) return { q: q0, r: r0 };

  const visited = new Set([`${q0},${r0}`]);
  const queue = [{ q: q0, r: r0 }];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const n of hexNeighbors(cur.q, cur.r)) {
      const nk = `${n.q},${n.r}`;
      if (!visited.has(nk)) {
        visited.add(nk);
        if (!occupancy.has(nk)) return n;
        if (visited.size < 200) queue.push(n);
      }
    }
  }
  return { q: q0, r: r0 };
}

