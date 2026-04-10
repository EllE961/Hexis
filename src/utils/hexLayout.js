/**
 * Hexis Layout — freeform hex-in-hex grid with user anchors.
 *
 * Every folder is a perfect hex shape (ring of cells). Every file is a
 * single cell inside its owning folder. Groups can be positioned
 * manually by the user via drag-and-drop (anchors persisted in
 * localStorage), or auto-placed adjacent to other groups when no
 * anchor exists.
 *
 * Core algorithm (freeform):
 *   Stage 1: compute each group's required ring size based on its
 *            content (direct files + children). Minimum ring 1.
 *   Stage 2: place top-level groups at their user anchors; auto-place
 *            the rest adjacent. Resolve sibling collisions by pushing
 *            the non-anchored / most-recently-moved one outward.
 *   Stage 3: recursively place child groups inside parents. If a
 *            child doesn't fit, GROW THE PARENT until it does, then
 *            cascade collision resolution up.
 *   Stage 4: fill cells with direct files (center-outward); build
 *            groupRegions, occupancy, cellOwner.
 *
 * Key invariants:
 *   - Every group has ring ≥ 1 (never shrinks below ring-1 = 7 cells)
 *   - Sub-group is always FULLY CONTAINED in its parent:
 *       hexDistance(parent.center, child.center) + child.ring ≤ parent.ring
 *   - Siblings never overlap:
 *       hexDistance(a.center, b.center) ≥ a.ring + b.ring + gap
 *
 * Hex ring sizes (cells_in_ring(n) = 3n² + 3n + 1):
 *   ring 0: 1    ring 1: 7    ring 2: 19    ring 3: 37
 *   ring 4: 61   ring 5: 91   ring 6: 127   ring 7: 169
 */

import { hexToPixel, hexNeighbors, hexDistance } from './hexMath.js';

const HEX_SIZE = 30;
const SIBLING_GAP = 1; // min extra distance between sibling group rings

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

/**
 * Ring size for a GROUP. Guaranteed minimum ring-1 (= 7 cells) so every
 * group always renders as a full hex, even if it contains 0 or 1 files.
 */
function ringForGroup(n) {
  const r = ringForCount(n);
  return r < 1 ? 1 : r;
}

/** All cells in a perfect hex ring of radius `ring` centered at (cq, cr). */
function getHexRingCells(cq, cr, ring) {
  const cells = [];
  for (let q = cq - ring; q <= cq + ring; q++) {
    for (let r = cr - ring; r <= cr + ring; r++) {
      if (hexDistance(cq, cr, q, r) <= ring) {
        cells.push({ q, r });
      }
    }
  }
  return cells;
}

/** Six axial hex directions. */
const HEX_DIRS = [
  [+1, 0], [+1, -1], [0, -1],
  [-1, 0], [-1, +1], [0, +1],
];

/** Pick the hex axial direction closest to the delta vector (dq, dr). */
function hexAxialPushDirection(dq, dr) {
  if (dq === 0 && dr === 0) return HEX_DIRS[0];
  let best = HEX_DIRS[0];
  let bestScore = -Infinity;
  const mag = Math.sqrt(dq * dq + dr * dr) || 1;
  for (const [hq, hr] of HEX_DIRS) {
    // dot product in axial coordinates (approx Euclidean)
    const score = (hq * dq + hr * dr) / mag;
    if (score > bestScore) {
      bestScore = score;
      best = [hq, hr];
    }
  }
  return best;
}

/** Is `child` fully inside `parent`? */
function containsFully(parent, child) {
  return hexDistance(parent.cq, parent.cr, child.cq, child.cr) + child.ring <= parent.ring;
}

/** Grow parent ring until it fully contains child. Returns new ring. */
function growParentRingFor(parent, child) {
  const needed = hexDistance(parent.cq, parent.cr, child.cq, child.cr) + child.ring;
  return Math.max(parent.ring, needed);
}

/**
 * Resolve collisions between sibling groups at the same level by
 * pushing overlapping groups along the axial direction of their center
 * delta. Iterates up to `maxIter` times. `fixed` is a set of groups
 * that shouldn't be moved (user-anchored ones we want to preserve).
 */
function resolveCollisions(siblings, fixed = new Set(), maxIter = 30) {
  for (let iter = 0; iter < maxIter; iter++) {
    let moved = false;
    for (let i = 0; i < siblings.length; i++) {
      for (let j = i + 1; j < siblings.length; j++) {
        const a = siblings[i];
        const b = siblings[j];
        const dist = hexDistance(a.cq, a.cr, b.cq, b.cr);
        const minDist = a.ring + b.ring + SIBLING_GAP;
        if (dist >= minDist) continue;
        // Decide who moves: prefer moving non-fixed. If both fixed,
        // move b (the "later" one in our ordering, which in practice
        // is the one the user just dropped).
        const aFixed = fixed.has(a.path);
        const bFixed = fixed.has(b.path);
        const mover = aFixed && !bFixed ? b
                    : !aFixed && bFixed ? a
                    : b;
        const anchor = mover === a ? b : a;
        // Push along the direction from anchor → mover
        const dq = mover.cq - anchor.cq;
        const dr = mover.cr - anchor.cr;
        const [hq, hr] = hexAxialPushDirection(dq || 1, dr);
        // Push by at least 1 step, or `overlap` steps if large
        const overlap = Math.max(1, minDist - dist);
        mover.cq += hq * overlap;
        mover.cr += hr * overlap;
        moved = true;
      }
    }
    if (!moved) return true;
  }
  return false; // didn't converge
}

/**
 * BFS outward from `startQ, startR` to find a hex position at which
 * placing a ring of size `childRing` would be fully contained inside
 * the parent (whose region is in `parentCellSet`) AND wouldn't
 * collide with any already-placed child in `placedChildren`.
 *
 * Returns { cq, cr } or null.
 */
function findChildPosition(parent, childRing, placedChildren) {
  // Generate candidate centers INSIDE the parent ring such that
  // placing a childRing hex at that center is fully contained.
  // Containment: hexDistance(parent, cand) + childRing <= parent.ring
  // So the candidate must be within (parent.ring - childRing) from the center.
  const innerRadius = parent.ring - childRing;
  if (innerRadius < 0) return null;

  // Build candidates; prefer positions AWAY from center (leaves room
  // for future siblings at the center) and from existing children.
  const candidates = getHexRingCells(parent.cq, parent.cr, innerRadius);

  // Score: maximize distance from (a) parent center, (b) nearest existing child center
  let best = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    // Check sibling collision
    let ok = true;
    let minSibDist = Infinity;
    for (const other of placedChildren) {
      const d = hexDistance(c.q, c.r, other.cq, other.cr);
      if (d < childRing + other.ring + SIBLING_GAP) { ok = false; break; }
      if (d < minSibDist) minSibDist = d;
    }
    if (!ok) continue;
    const distFromCenter = hexDistance(c.q, c.r, parent.cq, parent.cr);
    const score = distFromCenter + (minSibDist === Infinity ? 100 : minSibDist * 0.1);
    if (score > bestScore) {
      bestScore = score;
      best = { cq: c.q, cr: c.r };
    }
  }
  return best;
}

/**
 * Find a placement for a new top-level group (not user-anchored).
 * BFS outward from origin looking for a hex center at which a ring
 * of size `ring` has no collision with any `existing` group.
 */
function findFloatingPlacement(ring, existing) {
  if (existing.length === 0) return { cq: 0, cr: 0 };
  // Start from the centroid of existing groups
  let cx = 0, cy = 0;
  for (const g of existing) { cx += g.cq; cy += g.cr; }
  cx = Math.round(cx / existing.length);
  cy = Math.round(cy / existing.length);

  const visited = new Set();
  const queue = [{ q: cx, r: cy }];
  let tested = 0;
  while (queue.length > 0 && tested < 2000) {
    const cur = queue.shift();
    const key = `${cur.q},${cur.r}`;
    if (visited.has(key)) continue;
    visited.add(key);
    tested++;

    // Test: any collision?
    let ok = true;
    for (const g of existing) {
      if (hexDistance(cur.q, cur.r, g.cq, g.cr) < ring + g.ring + SIBLING_GAP) {
        ok = false; break;
      }
    }
    if (ok) return { cq: cur.q, cr: cur.r };

    for (const n of hexNeighbors(cur.q, cur.r)) queue.push(n);
  }
  // Fallback: place far from origin
  return { cq: cx + ring * 4, cr: cy };
}

// ═════════════════════════════════════════════════════════════════════
// computeLayout — the main entry point
// ═════════════════════════════════════════════════════════════════════

/**
 * @param files    Array<{path, group_path, is_landmark, ...}>
 * @param groups   Array<{path, parent_path, depth, name}>
 * @param hexSize  HEX_SIZE
 * @param anchors  Map<groupPath, [cq, cr]> — optional user-chosen positions
 */
export function computeLayout(files, groups, hexSize = HEX_SIZE, anchors = null) {
  const cells = new Map();
  const folders = new Map();
  const groupRegions = new Map();
  const occupancy = new Map();

  // ── Build tree ──
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

  // All groups (excluding '.') indexed by path
  const allGroups = groups.filter(g => g.path !== '.');
  const groupByPath = new Map();
  for (const g of allGroups) groupByPath.set(g.path, g);

  const topGroups = allGroups.filter(g => !g.parent_path || g.parent_path === '.');

  // Helper: recursive file count
  function countAll(gp) {
    let count = (filesByGroup.get(gp) || []).length;
    for (const child of (childGroupsOf.get(gp) || [])) count += countAll(child.path);
    return count;
  }

  // ── Stage 1: compute required ring bottom-up ──
  //
  // Each group needs enough cells to hold:
  //   - its direct files (ownRing from ringForGroup(directFiles + slack))
  //   - every child group's ring + positioning overhead
  //
  // We compute this post-order (deepest first) so parents know their
  // children's sizes.

  const placed = new Map(); // path → { path, cq, cr, ring, depth, parent }

  function requiredRingForOwnFiles(gp) {
    const direct = (filesByGroup.get(gp) || []).length;
    const slack = Math.max(1, Math.ceil(direct * 0.15));
    return ringForGroup(direct + slack);
  }

  // Post-order traversal helper
  function traversePostOrder(gp, visit) {
    const kids = childGroupsOf.get(gp) || [];
    for (const k of kids) traversePostOrder(k.path, visit);
    visit(gp);
  }

  // Size every group (no positions yet — fills `placed` with ring only)
  for (const top of topGroups) {
    traversePostOrder(top.path, (gp) => {
      const g = groupByPath.get(gp);
      if (!g) return;
      const ownRing = requiredRingForOwnFiles(gp);
      placed.set(gp, {
        path: gp,
        cq: 0, cr: 0, // placeholder
        ring: ownRing,
        depth: g.depth ?? 0,
        parent: g.parent_path && g.parent_path !== '.' ? g.parent_path : null,
        name: g.name,
      });
    });
  }

  // ── Stage 2: place TOP-LEVEL groups ──
  //
  // Anchored groups land at their user-chosen position.
  // Floating groups auto-pack adjacent.
  // Then we resolve sibling collisions, preferring to move floating ones.

  const topPlaced = [];
  const topAnchored = new Set(); // paths of user-anchored top groups

  // Sort: anchored first (so the auto-packer places floating ones around them)
  const sortedTops = [...topGroups].sort((a, b) => {
    const aAnchor = anchors?.get(a.path);
    const bAnchor = anchors?.get(b.path);
    if (aAnchor && !bAnchor) return -1;
    if (!aAnchor && bAnchor) return 1;
    // Then by size descending (bigger first for better packing)
    return countAll(b.path) - countAll(a.path);
  });

  for (const g of sortedTops) {
    const p = placed.get(g.path);
    if (!p) continue;
    const anchor = anchors?.get(g.path);
    if (anchor) {
      p.cq = anchor[0];
      p.cr = anchor[1];
      topAnchored.add(g.path);
    } else {
      const pos = findFloatingPlacement(p.ring, topPlaced);
      p.cq = pos.cq;
      p.cr = pos.cr;
    }
    topPlaced.push(p);
  }

  // Resolve top-level sibling collisions (grow anchors get priority)
  resolveCollisions(topPlaced, topAnchored);

  // ── Stage 3: recursively place children ──
  //
  // For each placed group, for each child:
  //   - if anchored (absolute coords): place there
  //   - else: find a position inside parent via findChildPosition
  //   - if the child doesn't fit: grow parent until it does, then
  //     propagate collision resolution at the parent's level.

  function placeChildrenOf(parentPath) {
    const parent = placed.get(parentPath);
    if (!parent) return;
    const kids = childGroupsOf.get(parentPath) || [];
    if (kids.length === 0) return;

    // Separate anchored children (absolute coords) from floating
    const anchoredKids = [];
    const floatingKids = [];
    for (const k of kids) {
      const kp = placed.get(k.path);
      if (!kp) continue;
      if (anchors?.has(k.path)) anchoredKids.push(kp);
      else floatingKids.push(kp);
    }

    // Place anchored children first at their stored positions
    const childAnchored = new Set();
    const placedChildren = [];
    for (const kp of anchoredKids) {
      const anchor = anchors.get(kp.path);
      kp.cq = anchor[0];
      kp.cr = anchor[1];
      childAnchored.add(kp.path);
      placedChildren.push(kp);
      // Grow parent if the anchored child doesn't fit
      if (!containsFully(parent, kp)) {
        parent.ring = growParentRingFor(parent, kp);
      }
    }

    // Place floating children via findChildPosition, growing parent as needed
    for (const kp of floatingKids) {
      let pos = findChildPosition(parent, kp.ring, placedChildren);
      if (!pos) {
        // Parent is too small to fit this child at all. Grow parent
        // until a position exists. We grow conservatively — by 1 ring
        // at a time — and re-try.
        let safety = 6;
        while (!pos && safety-- > 0) {
          parent.ring += 1;
          pos = findChildPosition(parent, kp.ring, placedChildren);
        }
        if (!pos) {
          // Absolute fallback: place at parent center (shouldn't happen)
          pos = { cq: parent.cq, cr: parent.cr };
        }
      }
      kp.cq = pos.cq;
      kp.cr = pos.cr;
      placedChildren.push(kp);
    }

    // Now resolve sibling collisions among children (rare if findChildPosition
    // did its job, but anchors can cause overlaps)
    if (placedChildren.length > 1) {
      resolveCollisions(placedChildren, childAnchored);
      // After push, verify all children still fit — grow parent if not
      for (const kp of placedChildren) {
        if (!containsFully(parent, kp)) {
          parent.ring = growParentRingFor(parent, kp);
        }
      }
    }

    // Recurse
    for (const kp of placedChildren) {
      placeChildrenOf(kp.path);
    }
  }

  for (const g of topGroups) placeChildrenOf(g.path);

  // After all children are placed, if any parent grew, re-check top-level
  // collisions (cascade). We run one more pass.
  resolveCollisions(topPlaced, topAnchored);

  // ── Stage 4: generate cells, groupRegions, folders, occupancy ──

  // Build groupRegions for every placed group
  const gridUsed = new Set();
  for (const p of placed.values()) {
    const regionCells = getHexRingCells(p.cq, p.cr, p.ring);
    groupRegions.set(p.path, regionCells);
    for (const c of regionCells) gridUsed.add(`${c.q},${c.r}`);
  }

  // Register folder metadata
  for (const p of placed.values()) {
    const center = hexToPixel(p.cq, p.cr, hexSize);
    const regionCells = groupRegions.get(p.path);
    // Top-most cell for label position
    let topY = Infinity, topX = center.x;
    for (const c of regionCells) {
      const pos = hexToPixel(c.q, c.r, hexSize);
      if (pos.y < topY) { topY = pos.y; topX = pos.x; }
    }

    const rawName = p.name === '.' ? 'root' : (p.name || p.path.split('/').pop() || p.path);
    const depth = p.depth;
    const fontSize = depth === 0 ? 15 : depth === 1 ? 11 : 9;
    const plateH = depth === 0 ? 26 : depth === 1 ? 20 : 14;
    const estNameW = rawName.length * fontSize * 0.6;
    const totalFilesCount = countAll(p.path);
    const countDigits = totalFilesCount > 0 ? String(totalFilesCount).length : 0;
    const countW = depth < 2 && countDigits > 0 ? countDigits * fontSize * 0.55 + 8 : 0;
    const totalW = estNameW + countW + 24;
    const labelCX = topX;
    const labelCY = topY - hexSize * 0.7;
    const labelRect = {
      x: labelCX - totalW / 2,
      y: labelCY - plateH / 2,
      w: totalW,
      h: plateH,
    };

    const directFiles = (filesByGroup.get(p.path) || []).length;
    const childCount = (childGroupsOf.get(p.path) || []).length;

    folders.set(p.path, {
      x: center.x, y: center.y,
      radius: p.ring * hexSize * 1.8,
      labelX: topX, labelY: topY,
      labelRect,
      name: p.name || p.path.split('/').pop() || p.path,
      depth,
      ring: p.ring,
      cq: p.cq,
      cr: p.cr,
      fileCount: directFiles,
      childCount,
      totalFiles: totalFilesCount,
      path: p.path,
      cellCount: regionCells.length,
    });
  }

  // ── Place direct files inside each group (center-outward) ──
  //
  // We iterate groups DEEPEST-FIRST so leaf groups claim their cells
  // before ancestors try to put THEIR direct files in cells that
  // already belong to deeper sub-groups.

  const sortedByDepthDesc = [...placed.values()].sort((a, b) => b.depth - a.depth);
  const claimedCells = new Set(); // cells owned by a deeper group

  for (const p of sortedByDepthDesc) {
    const regionCells = groupRegions.get(p.path);
    // Exclude cells claimed by any child sub-group (so those stay visible
    // as part of the child's region, not this parent's direct-file area)
    const childPaths = (childGroupsOf.get(p.path) || []).map(c => c.path);
    const childRegionSet = new Set();
    for (const cp of childPaths) {
      const cpRegion = groupRegions.get(cp);
      if (!cpRegion) continue;
      for (const c of cpRegion) childRegionSet.add(`${c.q},${c.r}`);
    }

    const availableCells = regionCells
      .filter(c => !childRegionSet.has(`${c.q},${c.r}`) && !claimedCells.has(`${c.q},${c.r}`))
      .sort((a, b) => {
        const da = hexDistance(p.cq, p.cr, a.q, a.r);
        const db = hexDistance(p.cq, p.cr, b.q, b.r);
        return da - db;
      });

    const directFiles = (filesByGroup.get(p.path) || [])
      .slice()
      .sort((a, b) => (b.is_landmark ? 1 : 0) - (a.is_landmark ? 1 : 0));

    for (let i = 0; i < directFiles.length && i < availableCells.length; i++) {
      const cell = availableCells[i];
      const file = directFiles[i];
      const pos = hexToPixel(cell.q, cell.r, hexSize);
      cells.set(file.path, {
        q: cell.q, r: cell.r,
        x: pos.x, y: pos.y,
        parentFolder: p.path,
      });
      occupancy.set(`${cell.q},${cell.r}`, file.path);
    }

    // Mark this group's region cells as claimed so ancestors don't reuse
    // them for their own direct files (even the empty ones — they belong
    // to this sub-group visually).
    for (const c of regionCells) claimedCells.add(`${c.q},${c.r}`);
  }

  // ── Root files: place as standalone cells next to the folder clusters ──
  const rootFiles = filesByGroup.get('.') || [];
  if (rootFiles.length > 0) {
    placeRootFilesAsCluster(rootFiles, gridUsed, cells, occupancy, hexSize);
  }

  // ── Build cellOwner map for O(1) hit tests ──
  const cellOwner = new Map();
  for (const [key, filePath] of occupancy) {
    cellOwner.set(key, { kind: 'file', filePath });
  }
  const sortedRegionsForOwner = [...groupRegions.entries()].sort((a, b) => {
    const da = folders.get(a[0])?.depth ?? 0;
    const db = folders.get(b[0])?.depth ?? 0;
    return da - db;
  });
  for (const [groupPath, regionCells] of sortedRegionsForOwner) {
    for (const c of regionCells) {
      const key = `${c.q},${c.r}`;
      const existing = cellOwner.get(key);
      if (existing?.kind === 'file') continue;
      cellOwner.set(key, { kind: 'empty', groupPath, q: c.q, r: c.r });
    }
  }

  return { cells, folders, groupRegions, occupancy, cellOwner };
}

/**
 * Place root-level files as individual cells adjacent to existing
 * folder clusters. BFS outward from a seed on the boundary of the
 * used grid.
 */
function placeRootFilesAsCluster(rootFiles, gridUsed, cells, occupancy, hexSize) {
  const sortedFiles = [...rootFiles].sort((a, b) =>
    (b.is_landmark ? 1 : 0) - (a.is_landmark ? 1 : 0));

  // Seed
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

  const queue = [seed];
  const visited = new Set([`${seed.q},${seed.r}`]);
  let placedCount = 0;

  while (queue.length > 0 && placedCount < sortedFiles.length) {
    const cur = queue.shift();
    const key = `${cur.q},${cur.r}`;

    if (!gridUsed.has(key)) {
      const file = sortedFiles[placedCount++];
      gridUsed.add(key);
      const pos = hexToPixel(cur.q, cur.r, hexSize);
      cells.set(file.path, {
        q: cur.q, r: cur.r,
        x: pos.x, y: pos.y,
        parentFolder: null,
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
