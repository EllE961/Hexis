/**
 * Hexis Viewport — camera controller.
 *
 * All coordinates in CSS pixels. No DPR.
 * Pan = immediate (no animation).
 * Zoom = velocity-decay toward cursor anchor (decay ×0.85 per frame).
 * centerOn = exponential ease-out (ease = 0.15 per frame).
 */

export class Viewport {
  constructor(canvasWidth, canvasHeight) {
    this.width = canvasWidth;
    this.height = canvasHeight;

    // Current state (what renders this frame)
    this.x = 0;
    this.y = 0;
    this.zoom = 1.0;

    // Target state (what we're animating toward)
    this.tx = 0;
    this.ty = 0;
    this.tz = 1.0;

    this.precision = 0.5;  // snap threshold (world pixels)

    this.minZoom = 0.05;
    this.maxZoom = 5.0;
  }

  resize(w, h) {
    this.width = w;
    this.height = h;
  }

  /**
   * Animate each frame.
   *
   * There are two distinct animation modes and they MUST NOT overlap:
   *
   * 1. **Timed camera move** (set by `centerOn` / `centerOnWithOvershoot` /
   *    `fitBoundsAnimated`): x, y, and zoom interpolate from the captured
   *    start values to their targets over `_animDuration` ms using a single
   *    cubic ease-out curve. This guarantees all three axes reach their
   *    destinations at the SAME moment — no "zoom teleports then pan drifts"
   *    feeling, because the visual change is driven by one clock, not three
   *    independent per-axis eases.
   *
   * 2. **Wheel zoom** (set by `zoomAt`): velocity-decay toward cursor. Used
   *    for continuous scroll input where there's no discrete "target". This
   *    also cancels any running timed animation since the user is taking
   *    control of the camera.
   */
  update() {
    // ── Wheel zoom velocity decay ──
    const zv = this._zoomVelocity || 0;
    if (Math.abs(zv) > 0.0001) {
      // User is wheel-zooming — cancel any running timed animation
      this._animStart = null;

      const focus = this._zoomFocusScreen || { x: this.width / 2, y: this.height / 2 };
      const wx = (focus.x - this.width / 2) / this.zoom + this.x;
      const wy = (focus.y - this.height / 2) / this.zoom + this.y;

      this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom * (1 + zv)));
      this.tz = this.zoom;

      this.x = wx - (focus.x - this.width / 2) / this.zoom;
      this.y = wy - (focus.y - this.height / 2) / this.zoom;
      this.tx = this.x;
      this.ty = this.y;

      this._zoomVelocity = zv * 0.85;
      if (Math.abs(this._zoomVelocity) < 0.0001) this._zoomVelocity = 0;
      return;
    }

    // ── Timed camera move (synchronized x/y/zoom interpolation) ──
    if (this._animStart != null) {
      const now = performance.now();
      const rawT = (now - this._animStart) / this._animDuration;
      const t = rawT >= 1 ? 1 : rawT;
      // Cubic ease-out — fast start, smooth settle, no bounce
      const eased = 1 - Math.pow(1 - t, 3);

      this.x    = this._animFromX + (this.tx - this._animFromX) * eased;
      this.y    = this._animFromY + (this.ty - this._animFromY) * eased;
      this.zoom = this._animFromZ + (this.tz - this._animFromZ) * eased;
      this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom));

      if (t >= 1) {
        // Overshoot: we just finished the "out" phase — start the elastic
        // settle-back phase (target now the real final zoom, retrigger
        // a second short animation from current zoom).
        if (this._overshootPhase === 'out' && this._overshootSettleZoom != null) {
          this._animStart = now;
          this._animDuration = 180;  // quick settle
          this._animFromX = this.x;
          this._animFromY = this.y;
          this._animFromZ = this.zoom;
          this.tz = this._overshootSettleZoom;
          this._overshootPhase = 'settle';
          return;
        }
        // Normal end — snap exactly to target
        this.x = this.tx;
        this.y = this.ty;
        this.zoom = this.tz;
        this._animStart = null;
        this._overshootPhase = null;
        this._overshootSettleZoom = null;
      }
      return;
    }

    // ── Idle: if targets drift from current (e.g. via direct .tx/.tz assign
    //    outside the animation API), fall back to a gentle per-axis ease so
    //    the camera still converges without jitter. This is the safety net.
    const ease = 0.15;
    const dx = this.tx - this.x;
    const dy = this.ty - this.y;
    const dz = this.tz - this.zoom;
    if (Math.abs(dx) > this.precision || Math.abs(dy) > this.precision ||
        Math.abs(dz) > this.precision) {
      this.x += dx * ease;
      this.y += dy * ease;
      this.zoom += dz * ease;
      this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom));
    } else {
      this.x = this.tx;
      this.y = this.ty;
      this.zoom = this.tz;
    }
  }

  /** Apply camera transform to canvas context. */
  apply(ctx) {
    ctx.translate(this.width / 2, this.height / 2);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-this.x, -this.y);
  }

  /** Screen CSS pixels → world coordinates. */
  screenToWorld(sx, sy) {
    return {
      x: (sx - this.width / 2) / this.zoom + this.x,
      y: (sy - this.height / 2) / this.zoom + this.y,
    };
  }

  /** World coordinates → screen CSS pixels. */
  worldToScreen(wx, wy) {
    return {
      x: (wx - this.x) * this.zoom + this.width / 2,
      y: (wy - this.y) * this.zoom + this.height / 2,
    };
  }

  /** Zoom toward a screen point. Velocity-based: smooth + responsive. */
  zoomAt(screenX, screenY, delta) {
    // Store the zoom focus point so update() can keep it stable
    this._zoomFocusScreen = { x: screenX, y: screenY };

    // Add zoom velocity (accumulates across rapid scroll events)
    const normalized = Math.sign(delta) * Math.min(Math.abs(delta), 150);
    this._zoomVelocity = (this._zoomVelocity || 0) + normalized * -0.0008;
  }

  /** Pan by screen-space delta. Immediate. */
  pan(dsx, dsy) {
    const dx = dsx / this.zoom;
    const dy = dsy / this.zoom;
    this.x -= dx;
    this.y -= dy;
    this.tx -= dx;
    this.ty -= dy;
  }

  /**
   * Compute a natural animation duration based on how far the camera has to
   * travel. Short hops = fast (220ms), long cinematic moves = slower (620ms).
   * The distance component includes zoom delta as well, so a big zoom-in
   * gets more frames to breathe.
   */
  _pickDuration(targetX, targetY, targetZoom) {
    const dx = (targetX - this.x) * Math.max(this.zoom, 0.2);
    const dy = (targetY - this.y) * Math.max(this.zoom, 0.2);
    const posDist = Math.hypot(dx, dy);
    // Zoom delta in log-space so going 0.2 → 2.0 feels the same as 0.5 → 5.0
    const zoomDelta = Math.abs(Math.log(Math.max(0.01, targetZoom) / Math.max(0.01, this.zoom)));
    // Weight: 1px position ≈ 0.004 zoom units (tuned by feel)
    const combined = posDist + zoomDelta * 250;
    // Clamp to [220, 620]
    return Math.max(220, Math.min(620, 180 + combined * 0.65));
  }

  _beginAnim(targetX, targetY, targetZoom, duration) {
    this._animStart = performance.now();
    this._animDuration = duration;
    this._animFromX = this.x;
    this._animFromY = this.y;
    this._animFromZ = this.zoom;
    this.tx = targetX;
    this.ty = targetY;
    this.tz = Math.max(this.minZoom, Math.min(this.maxZoom, targetZoom));
    this._zoomVelocity = 0;
  }

  /**
   * Smoothly center on a world position. Optional zoom. x, y, and zoom all
   * interpolate together over a single distance-adaptive duration so the
   * camera glides in one motion instead of zoom-teleporting then panning.
   */
  centerOn(wx, wy, zoom) {
    const targetZoom = zoom != null ? zoom : this.zoom;
    const duration = this._pickDuration(wx, wy, targetZoom);
    this._overshootPhase = null;
    this._overshootSettleZoom = null;
    this._beginAnim(wx, wy, targetZoom, duration);
  }

  /**
   * Smooth center + zoom with an elastic overshoot. Camera arcs past the
   * target zoom by ~4%, then settles back. The overshoot runs as a second
   * short animation once the main move completes (see update()). Gives
   * "zoom to X" a satisfying punch without breaking synchronized interp.
   */
  centerOnWithOvershoot(wx, wy, zoom) {
    const clamped = Math.max(this.minZoom, Math.min(this.maxZoom, zoom));
    const isZoomingIn = clamped > this.zoom;
    // The main animation aims PAST the final zoom; the settle phase in
    // update() will then reel it back to `clamped`.
    const inflated = isZoomingIn
      ? Math.min(this.maxZoom, clamped * 1.04)
      : Math.max(this.minZoom, clamped * 0.97);
    const duration = this._pickDuration(wx, wy, inflated);
    this._overshootPhase = 'out';
    this._overshootSettleZoom = clamped;
    this._beginAnim(wx, wy, inflated, duration);
  }

  /**
   * Zoom toward a world point while keeping it anchored under a fixed
   * screen position. Unlike `centerOnWithOvershoot` (which centers the
   * target), this is the VS-Code / Google-Maps "zoom to cursor" behavior:
   * the hex the user double-clicked stays exactly under their mouse as the
   * camera zooms in around it.
   *
   * Math: after zoom, we want screen point (anchorSx, anchorSy) to show
   * world point (wx, wy). From `screen = (world - cam) * zoom + size/2`:
   *   camX = wx - (anchorSx - width/2) / targetZoom
   *   camY = wy - (anchorSy - height/2) / targetZoom
   *
   * @param {number} wx            world-space x of the target (cell center)
   * @param {number} wy            world-space y of the target
   * @param {number} zoom          final zoom level
   * @param {number} anchorSx      canvas-local screen x where wx/wy should end up
   * @param {number} anchorSy      canvas-local screen y where wx/wy should end up
   */
  zoomToAnchored(wx, wy, zoom, anchorSx, anchorSy) {
    const clamped = Math.max(this.minZoom, Math.min(this.maxZoom, zoom));
    const isZoomingIn = clamped > this.zoom;
    const inflated = isZoomingIn
      ? Math.min(this.maxZoom, clamped * 1.04)
      : Math.max(this.minZoom, clamped * 0.97);

    // Camera position that keeps (wx, wy) under the anchor screen point at
    // the FINAL (non-inflated) zoom. We use the final zoom for anchor math
    // so the world point lands exactly under the cursor after settle.
    const targetCamX = wx - (anchorSx - this.width / 2) / clamped;
    const targetCamY = wy - (anchorSy - this.height / 2) / clamped;

    const duration = this._pickDuration(targetCamX, targetCamY, inflated);
    this._overshootPhase = 'out';
    this._overshootSettleZoom = clamped;
    this._beginAnim(targetCamX, targetCamY, inflated, duration);
  }

  /** Fit all points in view with padding — SNAPS immediately (no animation). */
  fitBounds(minX, minY, maxX, maxY, padding = 120) {
    this.tx = (minX + maxX) / 2;
    this.ty = (minY + maxY) / 2;
    const rangeX = maxX - minX + padding * 2;
    const rangeY = maxY - minY + padding * 2;
    this.tz = Math.max(this.minZoom, Math.min(this.maxZoom, Math.min(this.width / rangeX, this.height / rangeY)));
    // Also set current immediately for initial load
    this.x = this.tx;
    this.y = this.ty;
    this.zoom = this.tz;
    this._animStart = null;
    this._overshootPhase = null;
    this._overshootSettleZoom = null;
  }

  /** Animate fit-bounds (smooth transition, synchronized x/y/zoom). */
  fitBoundsAnimated(minX, minY, maxX, maxY, padding = 120) {
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const rangeX = maxX - minX + padding * 2;
    const rangeY = maxY - minY + padding * 2;
    const zoom = Math.max(this.minZoom, Math.min(this.maxZoom, Math.min(this.width / rangeX, this.height / rangeY)));
    const duration = this._pickDuration(cx, cy, zoom);
    this._overshootPhase = null;
    this._overshootSettleZoom = null;
    this._beginAnim(cx, cy, zoom, duration);
  }

  /**
   * Is a world point currently inside the visible rectangle (with margin)?
   * Used by HexCanvas.ensureVisible to decide whether to pan.
   */
  isVisible(wx, wy, margin = 40) {
    const b = this.getVisibleBounds();
    return wx >= b.minX + margin &&
           wx <= b.maxX - margin &&
           wy >= b.minY + margin &&
           wy <= b.maxY - margin;
  }

  /** Get visible world rectangle. */
  getVisibleBounds() {
    const hw = this.width / 2 / this.zoom;
    const hh = this.height / 2 / this.zoom;
    return { minX: this.x - hw, minY: this.y - hh, maxX: this.x + hw, maxY: this.y + hh };
  }

  /** Semantic zoom level. */
  getZoomLevel() {
    if (this.zoom < 0.12) return 'satellite';
    if (this.zoom < 0.25) return 'region';
    if (this.zoom < 0.55) return 'city';
    if (this.zoom < 1.5) return 'street';
    return 'interior';
  }
}
