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

  /** Animate each frame: spring for position, velocity decay for zoom. */
  update() {
    // ── Smooth zoom via velocity decay ──
    const zv = this._zoomVelocity || 0;
    if (Math.abs(zv) > 0.0001) {
      const focus = this._zoomFocusScreen || { x: this.width / 2, y: this.height / 2 };

      // World point under cursor BEFORE zoom step
      const wx = (focus.x - this.width / 2) / this.zoom + this.x;
      const wy = (focus.y - this.height / 2) / this.zoom + this.y;

      // Apply zoom velocity
      this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom * (1 + zv)));
      this.tz = this.zoom;

      // Keep world point under cursor
      this.x = wx - (focus.x - this.width / 2) / this.zoom;
      this.y = wy - (focus.y - this.height / 2) / this.zoom;
      this.tx = this.x;
      this.ty = this.y;

      // Decay velocity (smooth deceleration)
      this._zoomVelocity = zv * 0.85;
      if (Math.abs(this._zoomVelocity) < 0.0001) this._zoomVelocity = 0;
    }

    // ── Smooth ease-out for position + zoom (centerOn animation) ──
    const ease = 0.15; // exponential ease-out — no bounce, clean glide

    this.x += (this.tx - this.x) * ease;
    this.y += (this.ty - this.y) * ease;
    this.zoom += (this.tz - this.zoom) * ease;

    // Clamp zoom
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom));

    // Snap when close
    if (Math.abs(this.tx - this.x) < this.precision) this.x = this.tx;
    if (Math.abs(this.ty - this.y) < this.precision) this.y = this.ty;
    if (Math.abs(this.tz - this.zoom) < this.precision) this.zoom = this.tz;
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

  /** Smoothly center on a world position. Optional zoom. */
  centerOn(wx, wy, zoom) {
    this.tx = wx;
    this.ty = wy;
    if (zoom != null) this.tz = Math.max(this.minZoom, Math.min(this.maxZoom, zoom));
    this._zoomVelocity = 0;
  }

  /** Fit all points in view with padding. */
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
