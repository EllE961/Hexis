/**
 * LayoutAnimator — smooth cell-position reflow after layout changes.
 *
 * When `computeLayout()` runs (e.g. after a drag-drop or file create),
 * each cell may end up at a new (x, y). Snapping would feel jarring.
 * Instead we lerp each cell from its previous position to its new one
 * over a short duration so the honeycomb "flows" into place.
 *
 * Usage in HexCanvas:
 *   const animator = layoutAnimatorRef.current;
 *
 *   // BEFORE running computeLayout, snapshot current positions
 *   animator.snapshot(prevLayout?.cells);
 *
 *   // AFTER running computeLayout, start transitioning to new positions
 *   animator.transition(newLayout.cells, performance.now());
 *
 *   // In render loop, get the interpolated position for each file
 *   const { x, y } = animator.positionFor(filePath, fallbackCell);
 */

const DURATION_MS = 320;

export class LayoutAnimator {
  constructor() {
    this.prev = new Map(); // filePath → {x, y}
    this.current = new Map(); // filePath → {fromX, fromY, toX, toY, startTime}
  }

  /** Remember the positions of the OUTGOING layout. */
  snapshot(cells) {
    this.prev.clear();
    if (!cells) return;
    for (const [path, cell] of cells) {
      this.prev.set(path, { x: cell.x, y: cell.y });
    }
  }

  /**
   * Begin transitioning every cell from its previous snapshotted
   * position to its new position. Cells that DIDN'T exist before
   * animate from their current position (no travel).
   */
  transition(newCells, now) {
    this.current.clear();
    if (!newCells) return;
    for (const [path, cell] of newCells) {
      const was = this.prev.get(path);
      if (was && (Math.abs(was.x - cell.x) > 0.5 || Math.abs(was.y - cell.y) > 0.5)) {
        this.current.set(path, {
          fromX: was.x,
          fromY: was.y,
          toX: cell.x,
          toY: cell.y,
          startTime: now,
        });
      }
    }
  }

  /**
   * Return the interpolated position for a cell, or the fallback
   * (typically the cell's static position from the new layout) if no
   * animation is in flight for it.
   */
  positionFor(filePath, fallback, now) {
    const anim = this.current.get(filePath);
    if (!anim) return fallback;
    const t = Math.min(1, (now - anim.startTime) / DURATION_MS);
    if (t >= 1) {
      this.current.delete(filePath);
      return fallback;
    }
    // easeOutCubic
    const eased = 1 - Math.pow(1 - t, 3);
    return {
      x: anim.fromX + (anim.toX - anim.fromX) * eased,
      y: anim.fromY + (anim.toY - anim.fromY) * eased,
    };
  }

  /** Any active animations? (Keeps the render loop running.) */
  hasActive() {
    return this.current.size > 0;
  }
}
