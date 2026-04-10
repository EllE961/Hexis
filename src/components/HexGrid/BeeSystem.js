/** @module components/HexGrid/BeeSystem */

const AGENT_COLORS = {
  writer:     { body: '#F0A030', wing: '#FEDE98', eye: '#5A3A08' },
  planner:    { body: '#F59E0B', wing: '#FDE68A', eye: '#78350F' },
  coder:      { body: '#14B8A6', wing: '#99F6E4', eye: '#134E4A' },
  tester:     { body: '#A855F7', wing: '#E9D5FF', eye: '#3B0764' },
  reviewer:   { body: '#3B82F6', wing: '#BFDBFE', eye: '#1E3A5A' },
  documenter: { body: '#EC4899', wing: '#FBCFE8', eye: '#831843' },
};

// Physics constants — tuned for smooth, calm motion
// All values are per-second (scaled by deltaTime internally for frame-rate independence)
const MAX_SPEED_WANDER = 70;    // world units/sec — wander speed
const MAX_SPEED_FLY = 180;      // world units/sec — flight to target
const STEER_STRENGTH = 2.8;     // how strongly velocity steers toward desired (higher = snappier)
const WANDER_STEER_STRENGTH = 1.2;  // softer steering when wandering
const ARRIVE_SLOWDOWN = 160;    // distance at which deceleration begins
const MAX_TRAIL_AGE_MS = 2500;
const WORK_PARTICLE_AGE_MS = 1400;
const WORK_HOVER_OFFSET = -30;

// Work-state animation styles — each bee picks one at spawn for personality
// variety. The implementations live in the `working` branch of update().
const WORK_STYLES = ['nod', 'circle', 'figure8', 'dive', 'zigzag', 'inspect'];

/**
 * @class BeeSystem
 * Animated AI agents rendered as bees on the hex canvas — no fixed hive, always in motion.
 *
 * **Lifecycle:**
 * `spawn` enters the bee from a random visible-viewport edge into state `wandering`.
 * When `flyTo` is called the bee transitions to `flying`, steering toward the target cell.
 * On arrival it enters `working`, hovering sinusoidally above the cell.
 * `returnToHive` returns it to `wandering`; `flyAway` transitions to `leaving` and
 * removes the bee once it exits the screen.
 * Happy-path summary: **spawn → wander → fly-to-target → work → wander**.
 *
 * **HexCanvas integration contract:**
 * Each animation frame HexCanvas calls, in order:
 *   1. `setViewBounds(bounds)` — passes the current visible world rect (HexCanvas.jsx:408)
 *   2. `update()` — advances physics; derives `dt` internally from `performance.now()`
 *   3. `draw(ctx)` — renders trails, glow rings, and bee sprites onto a `ctx` already
 *      transformed by the viewport matrix (HexCanvas.jsx:415–416)
 *
 * **Agent roles** — sourced from `AGENT_COLORS`:
 *   - `writer` — amber body
 *   - `planner` — yellow body
 *   - `coder` — teal body
 *   - `tester` — purple body
 *   - `reviewer` — blue body
 *   - `documenter` — pink body
 *
 * @example
 * const bees = new BeeSystem();
 * bees.spawn('agent-1', 'coder');
 * bees.flyTo('agent-1', cell.x, cell.y, 'src/foo.js');
 * bees.update();
 * bees.draw(ctx);
 */
export class BeeSystem {
  constructor() {
    this.bees = new Map();
    this.trails = [];
    // Visible viewport bounds (set by HexCanvas each frame)
    this.viewBounds = { minX: -500, minY: -500, maxX: 500, maxY: 500 };
  }

  /**
   * Update the visible world bounds so bees know where to wander and where to enter from.
   * Called each frame by HexCanvas before `update()`.
   *
   * @param {{minX:number,minY:number,maxX:number,maxY:number}} bounds - Visible world bounds in hex-canvas coordinates.
   * @returns {void}
   */
  setViewBounds(bounds) {
    this.viewBounds = bounds;
  }

  /** Pick a random point inside the visible area. */
  _randomPointInView() {
    const b = this.viewBounds;
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    // Stay within the middle 80% of the visible area
    const padding = 0.1;
    return {
      x: b.minX + w * (padding + Math.random() * (1 - padding * 2)),
      y: b.minY + h * (padding + Math.random() * (1 - padding * 2)),
    };
  }

  /** Pick a random point just outside the visible area (for entry). */
  _randomEdgePoint() {
    const b = this.viewBounds;
    const side = Math.floor(Math.random() * 4); // 0=left 1=right 2=top 3=bottom
    const buffer = 80;
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    switch (side) {
      case 0: return { x: b.minX - buffer, y: b.minY + Math.random() * h };
      case 1: return { x: b.maxX + buffer, y: b.minY + Math.random() * h };
      case 2: return { x: b.minX + Math.random() * w, y: b.minY - buffer };
      default: return { x: b.minX + Math.random() * w, y: b.maxY + buffer };
    }
  }

  /**
   * Spawn a bee entering from a random edge of the visible viewport into `wandering` state.
   * Re-spawning the same agentId is a no-op — the existing bee record is returned unchanged.
   *
   * @param {string} agentId - Unique agent identifier.
   * @param {'writer'|'planner'|'coder'|'tester'|'reviewer'|'documenter'} [role='coder'] - Visual role; selects body, wing, and eye colors from AGENT_COLORS.
   * @returns {Object} bee - The bee record stored in `this.bees`.
   */
  spawn(agentId, role) {
    if (this.bees.has(agentId)) return this.bees.get(agentId);

    const entry = this._randomEdgePoint();
    const firstTarget = this._randomPointInView();

    // Initialize velocity pointing toward the first target so the bee starts smooth
    const dx = firstTarget.x - entry.x;
    const dy = firstTarget.y - entry.y;
    const dist = Math.hypot(dx, dy) || 1;
    const initialSpeed = MAX_SPEED_WANDER / 60;  // per-frame approximation

    const bee = {
      agentId,
      role: role || 'coder',
      x: entry.x,
      y: entry.y,
      vx: (dx / dist) * initialSpeed,
      vy: (dy / dist) * initialSpeed,
      heading: Math.atan2(dy, dx),
      state: 'wandering',
      wanderTarget: firstTarget,
      wanderUntil: performance.now() + 2000 + Math.random() * 2000,
      wanderPauseUntil: 0,       // random "look around" pauses in wander
      workTargetX: 0,
      workTargetY: 0,
      workArrivedAt: 0,
      currentFile: null,
      wingPhase: Math.random() * Math.PI * 2,
      spawnedAt: performance.now(),

      // ─── Per-bee personality (random at spawn, stays stable for bee's life) ───
      // Work animation style — nod / circle / figure8 / dive / zigzag / inspect
      workStyle: WORK_STYLES[Math.floor(Math.random() * WORK_STYLES.length)],
      // Multiplier on work-animation speed — 0.75x to 1.3x so bees don't sync
      workSpeed: 0.75 + Math.random() * 0.55,
      // Base wing flap rate (rad/sec). Faster wings = more alert-looking bee.
      wingBaseSpeed: 16 + Math.random() * 8,
      // Cosmetic positional wobble during flight — each bee has its own frequency + amplitude
      wobblePhase: Math.random() * Math.PI * 2,
      wobbleFreq: 2.2 + Math.random() * 2.5,
      wobbleAmt: 0.5 + Math.random() * 1.4,
      // Hover bob phase (used by 'inspect' work style for a gentle rise/fall)
      bobPhase: Math.random() * Math.PI * 2,
    };
    this.bees.set(agentId, bee);
    return bee;
  }

  /**
   * Transition a bee to `flying` state, steering it toward a target cell.
   * Silent no-op if agentId has no bee, or if the bee is already `working` on the same target.
   *
   * @param {string} agentId - Agent whose bee should fly.
   * @param {number} targetX - World-space x of the target cell.
   * @param {number} targetY - World-space y of the target cell (the bee will hover `WORK_HOVER_OFFSET` above this).
   * @param {string|null} [filePath=null] - Optional file path stored on the bee for UI readout.
   * @returns {void}
   */
  flyTo(agentId, targetX, targetY, filePath = null) {
    const bee = this.bees.get(agentId);
    if (!bee) return;

    // Already at this target and working? Stay.
    if (bee.state === 'working' &&
        Math.abs(bee.workTargetX - targetX) < 2 &&
        Math.abs(bee.workTargetY - targetY) < 2) {
      return;
    }

    bee.workTargetX = targetX;
    bee.workTargetY = targetY + WORK_HOVER_OFFSET;  // hover above the cell
    bee.state = 'flying';
    bee.currentFile = filePath;
  }

  /**
   * Return the bee to `wandering` state (despite the legacy name, there is no hive).
   * The bee resumes free-roaming with a fresh random in-view wander target.
   * No-op if agentId is unknown.
   *
   * @param {string} agentId - Agent whose bee should resume wandering.
   * @returns {void}
   */
  returnToHive(agentId) {
    const bee = this.bees.get(agentId);
    if (!bee) return;
    bee.state = 'wandering';
    bee.currentFile = null;
    bee.wanderTarget = this._randomPointInView();
    bee.wanderUntil = performance.now() + 2000;
  }

  /**
   * Transition the bee to `dragging` state and pause its physics simulation.
   * Snapshots the current `state`, `workTargetX`/`workTargetY`, and `currentFile` into
   * `_priorState`, `_priorWorkTarget`, and `_priorCurrentFile` so that `endDrag` can
   * restore them cleanly on drop. Velocity is zeroed so the bee stays exactly where the
   * pointer holds it. No-op returning `false` if no bee exists for `agentId`.
   *
   * @param {string} agentId - Agent whose bee should begin being dragged.
   * @returns {boolean} `true` if the bee was found and dragging began; `false` if no bee
   *   with that id exists.
   */
  beginDrag(agentId) {
    const bee = this.bees.get(agentId);
    if (!bee) return false;
    // Remember prior state so we can resume after drop
    bee._priorState = bee.state;
    bee._priorWorkTarget = { x: bee.workTargetX, y: bee.workTargetY };
    bee._priorCurrentFile = bee.currentFile;
    bee.state = 'dragging';
    bee.vx = 0;
    bee.vy = 0;
    return true;
  }

  /**
   * Set the dragged bee's world position directly, bypassing physics.
   * Silent no-op if the bee does not exist or is not currently in `dragging` state
   * (i.e. must be called between a successful `beginDrag` and `endDrag`).
   *
   * @param {string} agentId - Agent whose bee position should be updated.
   * @param {number} worldX - World-space x coordinate in hex-canvas coordinates.
   * @param {number} worldY - World-space y coordinate in hex-canvas coordinates.
   * @returns {void}
   */
  updateDrag(agentId, worldX, worldY) {
    const bee = this.bees.get(agentId);
    if (!bee || bee.state !== 'dragging') return;
    bee.x = worldX;
    bee.y = worldY;
  }

  /**
   * End a drag and restore the bee to an appropriate post-drop state.
   * If `_priorState` was `working` or `flying`, the bee re-enters `flying` state and
   * steers back to the already-preserved `workTargetX`/`workTargetY`. Otherwise it
   * transitions to `wandering` with a fresh random in-view target. The `_priorState`,
   * `_priorWorkTarget`, and `_priorCurrentFile` snapshot fields are deleted after use.
   * Silent no-op if the bee does not exist or is not in `dragging` state.
   *
   * @param {string} agentId - Agent whose bee should stop being dragged.
   * @returns {void}
   */
  endDrag(agentId) {
    const bee = this.bees.get(agentId);
    if (!bee || bee.state !== 'dragging') return;

    // If it had a work target, fly back to it
    if (bee._priorState === 'working' || bee._priorState === 'flying') {
      bee.state = 'flying';
      // workTargetX/Y are already set from before drag, so flying will aim for them
    } else {
      // No active work — wander
      bee.state = 'wandering';
      bee.wanderTarget = this._randomPointInView();
      bee.wanderUntil = performance.now() + 2000;
    }

    delete bee._priorState;
    delete bee._priorWorkTarget;
    delete bee._priorCurrentFile;
  }

  /**
   * Transition the bee to `leaving` state and aim it at a random point just outside the
   * visible viewport (chosen via `_randomEdgePoint`). Once `update()` detects that the
   * bee has moved outside the viewport bounds, the record is automatically removed from
   * `this.bees`. Clears `currentFile`. Used by HexCanvas.jsx when the backing agent
   * finishes. Silent no-op if the bee does not exist or is already in `leaving` state.
   *
   * @param {string} agentId - Agent whose bee should fly off-screen and be removed.
   * @returns {void}
   */
  flyAway(agentId) {
    const bee = this.bees.get(agentId);
    if (!bee) return;
    if (bee.state === 'leaving') return;  // already leaving

    // Pick an exit point just outside the visible area, preferring the same direction as current motion
    const exit = this._randomEdgePoint();
    bee.workTargetX = exit.x;
    bee.workTargetY = exit.y;
    bee.state = 'leaving';
    bee.currentFile = null;
  }

  /**
   * Remove the bee entirely.
   * Used after an agent has been wandering idle for a few seconds — see HexCanvas.jsx:299.
   *
   * @param {string} agentId - Agent whose bee should be deleted.
   * @returns {void}
   */
  remove(agentId) {
    this.bees.delete(agentId);
  }

  /**
   * Hit-test a world position against all bees.
   * Called by HexCanvas.jsx:450 for bee hover/click detection.
   *
   * @param {number} worldX - World-space x coordinate.
   * @param {number} worldY - World-space y coordinate.
   * @param {number} [radius=22] - World-space hit radius.
   * @returns {string|null} agentId of the closest bee within range, or null.
   */
  hitTest(worldX, worldY, radius = 22) {
    let closest = null;
    let closestDist = radius * radius;
    for (const bee of this.bees.values()) {
      const dx = bee.x - worldX;
      const dy = bee.y - worldY;
      const d2 = dx * dx + dy * dy;
      if (d2 < closestDist) {
        closestDist = d2;
        closest = bee.agentId;
      }
    }
    return closest;
  }

  /**
   * Look up a bee record by agent identifier.
   *
   * @param {string} agentId - Agent identifier to look up.
   * @returns {Object|undefined} The bee record, or undefined if no bee with that id exists.
   */
  getBee(agentId) {
    return this.bees.get(agentId);
  }

  /**
   * Advance bee physics by one frame.
   * Delta time is computed internally from `performance.now()` and clamped to 50 ms
   * to survive tab-blur pauses — no `dt` parameter is accepted or needed.
   *
   * Steers wandering bees toward random in-view targets with soft exponential blending;
   * steers flying bees with arrival slowdown; holds working bees in a small sinusoidal
   * hover over their target; and fades pollen trails by age.
   *
   * @returns {void}
   */
  update() {
    const now = performance.now();
    // Compute delta time in seconds — frame-rate independent
    if (this._lastUpdate == null) this._lastUpdate = now;
    let dt = (now - this._lastUpdate) / 1000;
    this._lastUpdate = now;
    if (dt > 0.05) dt = 0.05;
    if (dt <= 0) return;

    const beesToRemove = [];

    for (const bee of this.bees.values()) {
      // Wing flap rate is per-bee (personality) × state (buzzing harder when working)
      const wingMult =
        bee.state === 'working' ? 2.0 :  // hard buzz while working
        bee.state === 'flying' ? 1.35 :  // faster during travel
        bee.state === 'leaving' ? 1.2 :
        bee.state === 'dragging' ? 0.85 :
        1.0;
      bee.wingPhase += bee.wingBaseSpeed * wingMult * dt;

      // Wobble phase (purely cosmetic — drives positional jitter in draw)
      bee.wobblePhase += bee.wobbleFreq * dt;

      if (bee.state === 'wandering') {
        // ── Random "look around" pauses ──
        if (bee.wanderPauseUntil > now) {
          // Paused — decelerate, gentle head sway
          bee.vx *= Math.max(0, 1 - 3 * dt);
          bee.vy *= Math.max(0, 1 - 3 * dt);
          bee.x += bee.vx * dt;
          bee.y += bee.vy * dt;
          // Head sways side to side like looking around
          const lookT = (now - (bee.wanderPauseUntil - 800)) * 0.004;
          bee.heading = Math.sin(lookT) * 0.6;
        } else {
          // Small chance per frame to pause briefly
          if (Math.random() < 0.0015) {
            bee.wanderPauseUntil = now + 500 + Math.random() * 700;
          }

          // Pick a new wander target when reached or time expires
          const dx = bee.wanderTarget.x - bee.x;
          const dy = bee.wanderTarget.y - bee.y;
          const distSq = dx * dx + dy * dy;
          if (distSq < 2500 || now > bee.wanderUntil) {
            bee.wanderTarget = this._randomPointInView();
            bee.wanderUntil = now + 3000 + Math.random() * 3000;
          }

          // Desired velocity: unit vector toward target * wander speed
          const dist = Math.sqrt(distSq) || 1;
          const desiredVx = (dx / dist) * MAX_SPEED_WANDER;
          const desiredVy = (dy / dist) * MAX_SPEED_WANDER;

          // Smoothly blend current velocity toward desired (soft steering)
          const blend = 1 - Math.exp(-WANDER_STEER_STRENGTH * dt);
          bee.vx += (desiredVx - bee.vx) * blend;
          bee.vy += (desiredVy - bee.vy) * blend;

          // Integrate position
          bee.x += bee.vx * dt;
          bee.y += bee.vy * dt;

          // Update heading from velocity for drawing
          if (bee.vx * bee.vx + bee.vy * bee.vy > 1) {
            bee.heading = Math.atan2(bee.vy, bee.vx);
          }
        }

        if (Math.random() < 0.08) this._dropTrail(bee, 0.3);

      } else if (bee.state === 'flying') {
        const dx = bee.workTargetX - bee.x;
        const dy = bee.workTargetY - bee.y;
        const dist = Math.hypot(dx, dy);

        // Arrive: slow down smoothly as we approach
        if (dist < 2) {
          bee.x = bee.workTargetX;
          bee.y = bee.workTargetY;
          bee.vx = 0;
          bee.vy = 0;
          bee.state = 'working';
          bee.workArrivedAt = now;
        } else {
          // Arrival speed scales with distance
          const speedFactor = Math.min(1, dist / ARRIVE_SLOWDOWN);
          const targetSpeed = MAX_SPEED_FLY * speedFactor;
          const desiredVx = (dx / dist) * targetSpeed;
          const desiredVy = (dy / dist) * targetSpeed;

          // Stronger steering for flying
          const blend = 1 - Math.exp(-STEER_STRENGTH * dt);
          bee.vx += (desiredVx - bee.vx) * blend;
          bee.vy += (desiredVy - bee.vy) * blend;

          bee.x += bee.vx * dt;
          bee.y += bee.vy * dt;

          if (bee.vx * bee.vx + bee.vy * bee.vy > 1) {
            bee.heading = Math.atan2(bee.vy, bee.vx);
          }

          if (Math.random() < 0.3) this._dropTrail(bee, 0.55);
        }

      } else if (bee.state === 'working') {
        // ── Per-bee work style — six different "actively working" animations.
        // Position is computed purely as a function of (now - workArrivedAt),
        // not integrated, so there's zero drift even after long hovers.
        const t = (now - bee.workArrivedAt) * 0.001 * bee.workSpeed;
        const cx = bee.workTargetX;
        const cy = bee.workTargetY;

        switch (bee.workStyle) {
          case 'circle': {
            // Tight orbit — like the bee is circling a flower
            const r = 9 + Math.sin(t * 0.7) * 2;
            const ang = t * 1.3;
            bee.x = cx + Math.cos(ang) * r;
            bee.y = cy + Math.sin(ang) * r;
            bee.heading = ang + Math.PI / 2;  // face direction of motion
            break;
          }
          case 'figure8': {
            // Lazy figure-eight tracing
            bee.x = cx + Math.sin(t * 1.1) * 13;
            bee.y = cy + Math.sin(t * 2.2) * 6.5;
            const dxh = Math.cos(t * 1.1) * 14.3;
            const dyh = Math.cos(t * 2.2) * 14.3;
            bee.heading = Math.atan2(dyh, dxh);
            break;
          }
          case 'dive': {
            // Periodic dive onto the cell + rebound — like pecking/inspecting close-up
            const cycle = (t * 0.45) % 1;
            const diveCurve = Math.max(0, Math.sin(cycle * Math.PI));
            bee.x = cx + Math.sin(t * 0.6) * 3;
            bee.y = cy + diveCurve * 24 - 3;
            bee.heading = diveCurve * Math.PI * 0.35;  // tilt forward during dive
            break;
          }
          case 'zigzag': {
            // Fast side-to-side buzz, like a drill mode
            bee.x = cx + Math.sin(t * 4.2) * 7;
            bee.y = cy + Math.cos(t * 2.3) * 3;
            bee.heading = Math.sin(t * 4.2) * 0.5;
            break;
          }
          case 'inspect': {
            // Slow bob + rhythmic head swivel — bee is "studying" the cell
            bee.x = cx + Math.sin(t * 0.6) * 2;
            bee.y = cy + Math.sin(t * 1.05 + bee.bobPhase) * 3.5;
            // Swivel head from one side to the other
            bee.heading = Math.sin(t * 0.5) * 0.75;
            break;
          }
          case 'nod':
          default: {
            // Nodding forward + small in-place bob, like reading
            const nod = Math.sin(t * 2.2) * 0.35;
            bee.x = cx + Math.cos(t * 0.9) * 1.8;
            bee.y = cy + Math.sin(t * 1.3) * 2.8 + Math.abs(Math.sin(t * 2.5)) * 3;
            bee.heading = nod;
            break;
          }
        }

        bee.vx = 0;
        bee.vy = 0;

        // Drop work particles — little sparkles around the cell that the bee is working on.
        // Density scales with how quickly the work style is moving.
        if (Math.random() < 0.22) this._dropWorkParticle(bee);

      } else if (bee.state === 'dragging') {
        // Position is controlled externally via updateDrag().
        // Keep velocity at zero so when released, there's no carryover.
        bee.vx = 0;
        bee.vy = 0;
        // No heading change — stay upright
        continue;

      } else if (bee.state === 'leaving') {
        // Fly off-screen, then remove
        const dx = bee.workTargetX - bee.x;
        const dy = bee.workTargetY - bee.y;
        const dist = Math.hypot(dx, dy) || 1;

        // Check if bee has reached/passed the exit point
        const b = this.viewBounds;
        const outOfView = bee.x < b.minX - 60 || bee.x > b.maxX + 60 ||
                          bee.y < b.minY - 60 || bee.y > b.maxY + 60;
        if (outOfView || dist < 10) {
          beesToRemove.push(bee.agentId);
          continue;
        }

        // Steer smoothly toward the exit at full wander speed
        const desiredVx = (dx / dist) * MAX_SPEED_FLY * 0.7;
        const desiredVy = (dy / dist) * MAX_SPEED_FLY * 0.7;
        const blend = 1 - Math.exp(-STEER_STRENGTH * dt);
        bee.vx += (desiredVx - bee.vx) * blend;
        bee.vy += (desiredVy - bee.vy) * blend;
        bee.x += bee.vx * dt;
        bee.y += bee.vy * dt;

        if (bee.vx * bee.vx + bee.vy * bee.vy > 1) {
          bee.heading = Math.atan2(bee.vy, bee.vx);
        }

        if (Math.random() < 0.25) this._dropTrail(bee, 0.4);
      }
    }

    // Remove leaving bees that reached their exit
    for (const id of beesToRemove) this.bees.delete(id);

    // Fade trails (work particles use a shorter, brighter fade curve)
    this.trails = this.trails.filter(tr => {
      const age = now - tr.born;
      if (tr.work) {
        // Rise slightly as they fade — sparkle effect
        tr.y -= 8 * dt;
        tr.alpha = Math.max(0, 0.9 - (age / WORK_PARTICLE_AGE_MS));
      } else {
        tr.alpha = Math.max(0, 0.6 - (age / MAX_TRAIL_AGE_MS));
      }
      return tr.alpha > 0.02;
    });
  }

  _dropTrail(bee, alpha) {
    const colors = AGENT_COLORS[bee.role] || AGENT_COLORS.coder;
    this.trails.push({
      x: bee.x + (Math.random() - 0.5) * 4,
      y: bee.y + (Math.random() - 0.5) * 4,
      color: colors.body,
      alpha,
      size: 1 + Math.random() * 1.5,
      born: performance.now(),
    });
  }

  /**
   * Drop a bright "work sparkle" particle near the bee's target cell.
   * Particles use the bee's wing color (lighter than body) so they read as
   * golden dust rather than bee trails. They rise slowly and fade out fast.
   */
  _dropWorkParticle(bee) {
    const colors = AGENT_COLORS[bee.role] || AGENT_COLORS.coder;
    // Scatter around the actual CELL center, not the bee's hover point above it
    const cellY = bee.workTargetY - WORK_HOVER_OFFSET;
    const spreadX = (Math.random() - 0.5) * 30;
    const spreadY = (Math.random() - 0.5) * 16;
    this.trails.push({
      x: bee.workTargetX + spreadX,
      y: cellY + spreadY,
      color: colors.wing,
      alpha: 0.9,
      size: 0.7 + Math.random() * 1.4,
      born: performance.now(),
      work: true,
    });
  }

  /**
   * Render all bees and visual effects onto the canvas.
   * The viewport transform is already applied to `ctx` by HexCanvas.jsx before this is called —
   * all coordinates are in world space.
   *
   * Three render passes, in order:
   *   1. **Pollen trails** — fading colored dots left in each bee's wake.
   *   2. **Glow rings** — pulsing stroke rings drawn on working-bee target cells.
   *   3. **Bees** — wing, body, head, stripes, eye, stinger, and antennae sprites.
   *
   * @param {CanvasRenderingContext2D} ctx - World-space 2D rendering context.
   * @returns {void}
   */
  draw(ctx) {
    // 1. Pollen trails
    for (const trail of this.trails) {
      ctx.globalAlpha = trail.alpha;
      ctx.fillStyle = trail.color;
      ctx.beginPath();
      ctx.arc(trail.x, trail.y, trail.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // 2. Working glow rings on target cells — layered effect:
    //    a) soft inner fill blob, b) main pulsing ring, c) expanding echo ring
    const now = performance.now();
    for (const bee of this.bees.values()) {
      if (bee.state === 'working') {
        const colors = AGENT_COLORS[bee.role] || AGENT_COLORS.coder;
        const cellX = bee.workTargetX;
        const cellY = bee.workTargetY - WORK_HOVER_OFFSET;
        // Two desynced pulses for organic motion
        const pulseA = (Math.sin(now * 0.004) + 1) * 0.5;
        const pulseB = (Math.sin(now * 0.0028 + 1.7) + 1) * 0.5;

        ctx.save();

        // (a) Soft inner fill — radial glow behind the cell
        const innerGrad = ctx.createRadialGradient(cellX, cellY, 0, cellX, cellY, 26);
        innerGrad.addColorStop(0, colors.body + '66');
        innerGrad.addColorStop(0.55, colors.body + '22');
        innerGrad.addColorStop(1, colors.body + '00');
        ctx.globalAlpha = 0.55 + pulseA * 0.3;
        ctx.fillStyle = innerGrad;
        ctx.beginPath();
        ctx.arc(cellX, cellY, 26, 0, Math.PI * 2);
        ctx.fill();

        // (b) Main pulsing ring
        ctx.strokeStyle = colors.body;
        ctx.globalAlpha = 0.30 + pulseA * 0.45;
        ctx.lineWidth = 2 + pulseA * 1.5;
        ctx.beginPath();
        ctx.arc(cellX, cellY, 22 + pulseA * 3, 0, Math.PI * 2);
        ctx.stroke();

        // (c) Expanding echo ring — starts small, grows + fades on each cycle
        const echoRadius = 18 + pulseB * 14;
        const echoAlpha = (1 - pulseB) * 0.6;
        ctx.strokeStyle = colors.wing;
        ctx.globalAlpha = echoAlpha;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(cellX, cellY, echoRadius, 0, Math.PI * 2);
        ctx.stroke();

        ctx.restore();
      }
    }

    // 3. Bees
    for (const bee of this.bees.values()) {
      this._drawBee(ctx, bee);
    }
  }

  _drawBee(ctx, bee) {
    const colors = AGENT_COLORS[bee.role] || AGENT_COLORS.coder;
    const wingFlap = Math.sin(bee.wingPhase);
    const isDragging = bee.state === 'dragging';
    const isWorking = bee.state === 'working';
    // Working bees scale up slightly with a subtle breathing pulse
    const workBreath = isWorking ? 1 + Math.sin(bee.wingPhase * 0.25) * 0.04 : 1;
    const scale = (isDragging ? 2.8 : 2.4) * workBreath;

    // Cosmetic wobble — tiny perpendicular jitter during flight/wander so
    // bees don't feel robotic. Zero during work (the work style owns position)
    // and zero during drag (user controls position).
    let wobbleX = 0, wobbleY = 0;
    if (!isDragging && !isWorking) {
      wobbleX = Math.sin(bee.wobblePhase) * bee.wobbleAmt;
      wobbleY = Math.cos(bee.wobblePhase * 1.37) * bee.wobbleAmt * 0.7;
    }

    ctx.save();
    ctx.translate(bee.x + wobbleX, bee.y + wobbleY);
    ctx.scale(scale, scale);

    // Rotate for any state that sets a heading. Dragging stays upright.
    if (!isDragging) {
      ctx.rotate(bee.heading);
    }

    // ─── 1. Soft shadow beneath ───
    ctx.save();
    ctx.translate(0.8, 1.2);
    ctx.globalAlpha = isDragging ? 0.35 : 0.25;
    const shadowGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, 10);
    shadowGrad.addColorStop(0, 'rgba(0,0,0,0.6)');
    shadowGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = shadowGrad;
    ctx.beginPath();
    ctx.ellipse(0, 0, 10, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // ─── 2. Wings (behind body, with motion blur) ───
    const wingY1 = -6 + wingFlap * 3;
    const wingY2 = 6 - wingFlap * 3;
    const wingRot = 0.35 + Math.abs(wingFlap) * 0.15;

    ctx.globalAlpha = 0.45 + Math.abs(wingFlap) * 0.15;

    // Wing fill — radial gradient for glossy insect look
    const leftWingGrad = ctx.createRadialGradient(-1, wingY1, 0, -1, wingY1, 7);
    leftWingGrad.addColorStop(0, colors.wing);
    leftWingGrad.addColorStop(0.7, colors.wing + 'CC');
    leftWingGrad.addColorStop(1, colors.wing + '40');
    ctx.fillStyle = leftWingGrad;
    ctx.beginPath();
    ctx.ellipse(-1, wingY1, 5.5, 8.5, -wingRot, 0, Math.PI * 2);
    ctx.fill();

    const rightWingGrad = ctx.createRadialGradient(-1, wingY2, 0, -1, wingY2, 7);
    rightWingGrad.addColorStop(0, colors.wing);
    rightWingGrad.addColorStop(0.7, colors.wing + 'CC');
    rightWingGrad.addColorStop(1, colors.wing + '40');
    ctx.fillStyle = rightWingGrad;
    ctx.beginPath();
    ctx.ellipse(-1, wingY2, 5.5, 8.5, wingRot, 0, Math.PI * 2);
    ctx.fill();

    // Wing veins — subtle detail lines
    ctx.globalAlpha = 0.25;
    ctx.strokeStyle = colors.eye;
    ctx.lineWidth = 0.25;
    ctx.beginPath();
    ctx.moveTo(-2, wingY1 - 3);
    ctx.lineTo(2, wingY1 + 3);
    ctx.moveTo(-2, wingY2 + 3);
    ctx.lineTo(2, wingY2 - 3);
    ctx.stroke();

    ctx.globalAlpha = 1;

    // ─── 3. Body (rounder, fuller) ───
    // Dark outline for definition
    ctx.fillStyle = colors.eye;
    ctx.beginPath();
    ctx.ellipse(0, 0, 9, 7, 0, 0, Math.PI * 2);
    ctx.fill();

    // Gradient body
    const bodyGrad = ctx.createRadialGradient(-2, -3, 0, 0, 0, 10);
    bodyGrad.addColorStop(0, this._lighten(colors.body, 40));
    bodyGrad.addColorStop(0.5, colors.body);
    bodyGrad.addColorStop(1, this._darken(colors.body, 20));
    ctx.fillStyle = bodyGrad;
    ctx.beginPath();
    ctx.ellipse(0, 0, 8.2, 6.2, 0, 0, Math.PI * 2);
    ctx.fill();

    // ─── 4. Stripes — curved bands ───
    ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
    // Front stripe
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(0, 0, 8.2, 6.2, 0, 0, Math.PI * 2);
    ctx.clip();
    ctx.beginPath();
    ctx.ellipse(2.5, 0, 1.6, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(-1.5, 0, 1.4, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // ─── 5. Body highlight (glossy shine) ───
    ctx.globalAlpha = 0.35;
    const shineGrad = ctx.createRadialGradient(-2.5, -3, 0, -2.5, -3, 4);
    shineGrad.addColorStop(0, '#FFFFFF');
    shineGrad.addColorStop(1, '#FFFFFF00');
    ctx.fillStyle = shineGrad;
    ctx.beginPath();
    ctx.ellipse(-2.5, -3, 3.5, 2, -0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // ─── 6. Head (larger, rounder) ───
    // Outline
    ctx.fillStyle = colors.eye;
    ctx.beginPath();
    ctx.arc(8, 0, 5, 0, Math.PI * 2);
    ctx.fill();

    // Head gradient
    const headGrad = ctx.createRadialGradient(6.5, -1.5, 0, 8, 0, 5);
    headGrad.addColorStop(0, this._lighten(colors.body, 35));
    headGrad.addColorStop(1, colors.body);
    ctx.fillStyle = headGrad;
    ctx.beginPath();
    ctx.arc(8, 0, 4.5, 0, Math.PI * 2);
    ctx.fill();

    // ─── 7. Big expressive eyes ───
    // Eye whites
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(9, -1.5, 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(9, 1.5, 2.2, 0, Math.PI * 2);
    ctx.fill();

    // Pupils (large + dark)
    ctx.fillStyle = '#1a1a1a';
    ctx.beginPath();
    ctx.arc(9.6, -1.5, 1.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(9.6, 1.5, 1.3, 0, Math.PI * 2);
    ctx.fill();

    // Eye highlights (catch light)
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(10, -2, 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(10, 1, 0.5, 0, Math.PI * 2);
    ctx.fill();

    // ─── 8. Tiny smile ───
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = 0.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(11.2, 0, 1.2, -0.4, 0.4);
    ctx.stroke();

    // ─── 9. Antennae (cute curved + ball tips) ───
    ctx.strokeStyle = colors.eye;
    ctx.lineWidth = 0.7;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(9, -4);
    ctx.quadraticCurveTo(11, -7, 12.5, -6);
    ctx.moveTo(9, 4);
    ctx.quadraticCurveTo(11, 7, 12.5, 6);
    ctx.stroke();
    // Ball tips
    ctx.fillStyle = colors.body;
    ctx.beginPath();
    ctx.arc(12.5, -6, 0.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(12.5, 6, 0.7, 0, Math.PI * 2);
    ctx.fill();

    // ─── 10. Stinger ───
    ctx.fillStyle = colors.eye;
    ctx.beginPath();
    ctx.moveTo(-8.5, 0);
    ctx.lineTo(-12, -1);
    ctx.lineTo(-12, 1);
    ctx.closePath();
    ctx.fill();

    // ─── 11. Dragging indicator: glow ring ───
    if (isDragging) {
      ctx.strokeStyle = colors.body;
      ctx.lineWidth = 0.8;
      ctx.globalAlpha = 0.6;
      ctx.setLineDash([1.5, 1.5]);
      ctx.beginPath();
      ctx.arc(0, 0, 13, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();
  }

  _lighten(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.min(255, ((n >> 16) & 0xff) + amt);
    const g = Math.min(255, ((n >> 8) & 0xff) + amt);
    const b = Math.min(255, (n & 0xff) + amt);
    return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
  }

  _darken(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.max(0, ((n >> 16) & 0xff) - amt);
    const g = Math.max(0, ((n >> 8) & 0xff) - amt);
    const b = Math.max(0, (n & 0xff) - amt);
    return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
  }
}
