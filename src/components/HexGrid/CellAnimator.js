/**
 * CellAnimator — smooth per-cell animation states.
 *
 * Tracks hover, selection, and status transitions with lerp-based easing.
 * Each cell has animated values that smoothly approach their targets.
 */

const LERP_SPEED = 0.12;       // hover/select transition speed
const FAST_LERP = 0.2;         // for quick responses like save flash

export class CellAnimator {
  constructor() {
    this.cells = new Map(); // filePath → AnimState
  }

  /** Get or create animation state for a cell. */
  get(filePath) {
    if (!this.cells.has(filePath)) {
      this.cells.set(filePath, {
        hover: 0,         // 0–1 hover blend
        select: 0,        // 0–1 selection blend
        saveFlash: 0,      // 0–1 save flash (decays)
        modifiedPulse: 0,  // continuous pulse phase for dirty files
        agentGlow: 0,      // 0–1 agent activity
        scale: 1,          // scale factor for pop-in
      });
    }
    return this.cells.get(filePath);
  }

  /** Update all cells toward their targets. Call once per frame. */
  update(hoveredCell, selectedCell, dirtyFiles, activeAgentFiles) {
    const now = Date.now();

    for (const [path, state] of this.cells) {
      // Hover
      const hoverTarget = path === hoveredCell ? 1 : 0;
      state.hover += (hoverTarget - state.hover) * LERP_SPEED;
      if (Math.abs(state.hover - hoverTarget) < 0.01) state.hover = hoverTarget;

      // Select
      const selectTarget = path === selectedCell ? 1 : 0;
      state.select += (selectTarget - state.select) * LERP_SPEED;
      if (Math.abs(state.select - selectTarget) < 0.01) state.select = selectTarget;

      // Save flash (decays)
      if (state.saveFlash > 0) {
        state.saveFlash *= 0.92;
        if (state.saveFlash < 0.01) state.saveFlash = 0;
      }

      // Modified pulse (continuous sine wave for dirty files)
      if (dirtyFiles?.has(path)) {
        state.modifiedPulse = Math.sin(now * 0.003) * 0.5 + 0.5;
      } else {
        state.modifiedPulse *= 0.9;
      }

      // Agent glow
      const agentTarget = activeAgentFiles?.has(path) ? 1 : 0;
      state.agentGlow += (agentTarget - state.agentGlow) * LERP_SPEED;

      // Scale (pop-in on first appearance, or slight bump on select)
      const scaleTarget = path === selectedCell ? 1.04 : 1;
      state.scale += (scaleTarget - state.scale) * LERP_SPEED;
    }
  }

  /** Trigger save flash for a file. */
  triggerSaveFlash(filePath) {
    const state = this.get(filePath);
    state.saveFlash = 1;
  }

  /** Clean up cells that are no longer visible. */
  prune(visiblePaths) {
    if (this.cells.size > visiblePaths.size * 2) {
      for (const path of this.cells.keys()) {
        if (!visiblePaths.has(path)) this.cells.delete(path);
      }
    }
  }
}
