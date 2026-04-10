import { describe, it, expect } from 'vitest';
import { computeLayout } from './hexLayout.js';
import { hexDistance, hexCellCount } from './hexMath.js';

// ─── Helpers ───

function mkFile(path, groupPath, extras = {}) {
  const name = path.split('/').pop();
  return { path, name, group_path: groupPath, ...extras };
}

function mkGroup(path, parentPath = null) {
  const name = path.split('/').pop();
  return { path, parent_path: parentPath, name };
}

function countEmptyCellsInGroup(layout, groupPath) {
  const region = layout.groupRegions.get(groupPath) || [];
  let empty = 0;
  for (const c of region) {
    const key = `${c.q},${c.r}`;
    if (!layout.occupancy.has(key)) empty++;
  }
  // Note: subtract cells that are occupied by DEEPER child groups.
  // Those cells belong to the child, not this group's "empty" pool.
  const folder = layout.folders.get(groupPath);
  if (!folder) return empty;
  for (const [childPath, childFolder] of layout.folders) {
    if (childPath === groupPath) continue;
    if (!childPath.startsWith(groupPath + '/')) continue;
    if (childFolder.depth !== folder.depth + 1) continue;
    const childRegion = layout.groupRegions.get(childPath) || [];
    // subtract the cells in the child region that are NOT files (files are
    // already subtracted above by the occupancy check, but the child's
    // non-file cells were double-counted as "empty" for the parent).
    for (const c of childRegion) {
      const key = `${c.q},${c.r}`;
      if (!layout.occupancy.has(key)) empty--;
    }
  }
  return empty;
}

// ─── Invariant tests ───

describe('computeLayout — always-hex invariant', () => {
  it('empty group renders as ring 1 (7 cells)', () => {
    const files = [];
    const groups = [mkGroup('empty')];
    const layout = computeLayout(files, groups);
    const folder = layout.folders.get('empty');
    expect(folder).toBeDefined();
    expect(folder.ring).toBe(1);
    expect(folder.cellCount).toBe(7);
  });

  it('group with 1 file is still ring 1', () => {
    const files = [mkFile('src/a.js', 'src')];
    const groups = [mkGroup('src')];
    const layout = computeLayout(files, groups);
    expect(layout.folders.get('src').ring).toBe(1);
  });

  it('every group has ring ≥ 1', () => {
    const files = [
      mkFile('a/x.js', 'a'),
      mkFile('a/b/y.js', 'a/b'),
      mkFile('a/b/c/z.js', 'a/b/c'),
    ];
    const groups = [
      mkGroup('a'),
      mkGroup('a/b', 'a'),
      mkGroup('a/b/c', 'a/b'),
    ];
    const layout = computeLayout(files, groups);
    for (const folder of layout.folders.values()) {
      expect(folder.ring).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('computeLayout — empty cell guarantee', () => {
  it('group at boundary (6 files) has ≥ 1 empty cell', () => {
    const files = Array.from({ length: 6 }, (_, i) => mkFile(`g/f${i}.js`, 'g'));
    const groups = [mkGroup('g')];
    const layout = computeLayout(files, groups);
    const folder = layout.folders.get('g');
    // Direct files occupy ≤ cellCount − 1
    expect(folder.fileCount).toBeLessThan(folder.cellCount);
    expect(countEmptyCellsInGroup(layout, 'g')).toBeGreaterThanOrEqual(1);
  });

  it('group with 7 files has ≥ 1 empty cell (grows to ring 2)', () => {
    const files = Array.from({ length: 7 }, (_, i) => mkFile(`g/f${i}.js`, 'g'));
    const groups = [mkGroup('g')];
    const layout = computeLayout(files, groups);
    expect(layout.folders.get('g').ring).toBeGreaterThanOrEqual(2);
    expect(countEmptyCellsInGroup(layout, 'g')).toBeGreaterThanOrEqual(1);
  });

  it('group at 18 files still has ≥ 1 empty cell', () => {
    const files = Array.from({ length: 18 }, (_, i) => mkFile(`g/f${i}.js`, 'g'));
    const groups = [mkGroup('g')];
    const layout = computeLayout(files, groups);
    expect(countEmptyCellsInGroup(layout, 'g')).toBeGreaterThanOrEqual(1);
  });
});

describe('computeLayout — containment invariant', () => {
  it('child group centers are within parent disk', () => {
    const files = [
      mkFile('a/b/x.js', 'a/b'),
      mkFile('a/b/y.js', 'a/b'),
      mkFile('a/c/z.js', 'a/c'),
    ];
    const groups = [
      mkGroup('a'),
      mkGroup('a/b', 'a'),
      mkGroup('a/c', 'a'),
    ];
    const layout = computeLayout(files, groups);
    const parent = layout.folders.get('a');
    for (const childPath of ['a/b', 'a/c']) {
      const child = layout.folders.get(childPath);
      const dist = hexDistance(parent.cq, parent.cr, child.cq, child.cr);
      // Full containment: distance + child.ring ≤ parent.ring
      expect(dist + child.ring).toBeLessThanOrEqual(parent.ring);
    }
  });
});

describe('computeLayout — sibling non-overlap', () => {
  it('no two sibling groups overlap', () => {
    const files = [
      mkFile('p/a/x.js', 'p/a'),
      mkFile('p/b/y.js', 'p/b'),
      mkFile('p/c/z.js', 'p/c'),
    ];
    const groups = [
      mkGroup('p'),
      mkGroup('p/a', 'p'),
      mkGroup('p/b', 'p'),
      mkGroup('p/c', 'p'),
    ];
    const layout = computeLayout(files, groups);
    const siblings = ['p/a', 'p/b', 'p/c'].map(p => layout.folders.get(p));
    for (let i = 0; i < siblings.length; i++) {
      for (let j = i + 1; j < siblings.length; j++) {
        const a = siblings[i];
        const b = siblings[j];
        const d = hexDistance(a.cq, a.cr, b.cq, b.cr);
        expect(d).toBeGreaterThanOrEqual(a.ring + b.ring + 1);
      }
    }
  });

  it('no two top-level groups overlap', () => {
    const files = [
      mkFile('alpha/a.js', 'alpha'),
      mkFile('beta/b.js', 'beta'),
      mkFile('gamma/c.js', 'gamma'),
    ];
    const groups = [mkGroup('alpha'), mkGroup('beta'), mkGroup('gamma')];
    const layout = computeLayout(files, groups);
    const tops = [...layout.folders.values()];
    for (let i = 0; i < tops.length; i++) {
      for (let j = i + 1; j < tops.length; j++) {
        const a = tops[i];
        const b = tops[j];
        const d = hexDistance(a.cq, a.cr, b.cq, b.cr);
        expect(d).toBeGreaterThanOrEqual(a.ring + b.ring + 1);
      }
    }
  });
});

describe('computeLayout — determinism', () => {
  it('same input produces same output', () => {
    const files = [
      mkFile('x/a.js', 'x'),
      mkFile('x/b.js', 'x'),
      mkFile('y/c.js', 'y'),
    ];
    const groups = [mkGroup('x'), mkGroup('y')];
    const a = computeLayout(files, groups);
    const b = computeLayout(files, groups);
    for (const path of ['x', 'y']) {
      expect(a.folders.get(path).cq).toBe(b.folders.get(path).cq);
      expect(a.folders.get(path).cr).toBe(b.folders.get(path).cr);
      expect(a.folders.get(path).ring).toBe(b.folders.get(path).ring);
    }
  });
});

describe('computeLayout — cascading growth', () => {
  it('parent of full subgroup has ring large enough to contain it', () => {
    const files = Array.from({ length: 20 }, (_, i) =>
      mkFile(`top/nested/f${i}.js`, 'top/nested')
    );
    const groups = [mkGroup('top'), mkGroup('top/nested', 'top')];
    const layout = computeLayout(files, groups);
    const parent = layout.folders.get('top');
    const child = layout.folders.get('top/nested');
    expect(child.ring).toBeGreaterThanOrEqual(2);
    // Child fully contained
    const dist = hexDistance(parent.cq, parent.cr, child.cq, child.cr);
    expect(dist + child.ring).toBeLessThanOrEqual(parent.ring);
  });

  it('deeply nested subtree is fully contained at every level', () => {
    const files = [
      mkFile('a/b/c/d/f.js', 'a/b/c/d'),
    ];
    const groups = [
      mkGroup('a'),
      mkGroup('a/b', 'a'),
      mkGroup('a/b/c', 'a/b'),
      mkGroup('a/b/c/d', 'a/b/c'),
    ];
    const layout = computeLayout(files, groups);
    const chain = ['a', 'a/b', 'a/b/c', 'a/b/c/d'];
    for (let i = 1; i < chain.length; i++) {
      const parent = layout.folders.get(chain[i - 1]);
      const child = layout.folders.get(chain[i]);
      const dist = hexDistance(parent.cq, parent.cr, child.cq, child.cr);
      expect(dist + child.ring).toBeLessThanOrEqual(parent.ring);
    }
  });
});

describe('computeLayout — tight packing', () => {
  it('2 empty sub-groups pack into a ring-3 parent (not ring-4)', () => {
    const files = [];
    const groups = [
      mkGroup('p'),
      mkGroup('p/a', 'p'),
      mkGroup('p/b', 'p'),
    ];
    const layout = computeLayout(files, groups);
    // Two ring-1 children must fit geometrically in ring 3 (minimum).
    // Prior center-first heuristic incorrectly grew this to ring 4.
    expect(layout.folders.get('p').ring).toBeLessThanOrEqual(3);
  });

  it('many small sub-groups pack as tightly as possible', () => {
    // 7 ring-1 sub-groups should fit in a modest parent ring
    const groups = [
      mkGroup('big'),
      ...Array.from({ length: 7 }, (_, i) => mkGroup(`big/s${i}`, 'big')),
    ];
    const files = Array.from({ length: 7 }, (_, i) =>
      mkFile(`big/s${i}/f.js`, `big/s${i}`)
    );
    const layout = computeLayout(files, groups);
    // 7 ring-1 children need parent ring ≥ 4 (geometric bound), should
    // not explode to ring 6+
    expect(layout.folders.get('big').ring).toBeLessThanOrEqual(5);
  });

  it('sub-groups sit toward the rim, not at parent center', () => {
    const groups = [
      mkGroup('p'),
      mkGroup('p/a', 'p'),
      mkGroup('p/b', 'p'),
    ];
    const files = [
      mkFile('p/a/x.js', 'p/a'),
      mkFile('p/b/y.js', 'p/b'),
    ];
    const layout = computeLayout(files, groups);
    const parent = layout.folders.get('p');
    const a = layout.folders.get('p/a');
    const b = layout.folders.get('p/b');
    // Outside-in packing places children at distance > 0 from parent
    // center when multiple children exist.
    const distA = hexDistance(parent.cq, parent.cr, a.cq, a.cr);
    const distB = hexDistance(parent.cq, parent.cr, b.cq, b.cr);
    expect(Math.max(distA, distB)).toBeGreaterThan(0);
  });
});

describe('computeLayout — persistence hints', () => {
  it('honours saved positions when still valid', () => {
    const files = [mkFile('g/a.js', 'g')];
    const groups = [mkGroup('g')];
    const savedState = {
      version: 1,
      groupPositions: { g: [5, 3] },
      groupRings: { g: 1 },
    };
    const layout = computeLayout(files, groups, 30, savedState);
    const folder = layout.folders.get('g');
    expect(folder.cq).toBe(5);
    expect(folder.cr).toBe(3);
  });

  it('exposes _savedState for next round-trip', () => {
    const files = [mkFile('g/a.js', 'g')];
    const groups = [mkGroup('g')];
    const layout = computeLayout(files, groups);
    expect(layout._savedState).toBeDefined();
    expect(layout._savedState.groupPositions.g).toEqual([
      layout.folders.get('g').cq,
      layout.folders.get('g').cr,
    ]);
    expect(layout._savedState.groupRings.g).toBe(layout.folders.get('g').ring);
  });
});
