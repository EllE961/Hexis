/**
 * Deep space starfield — pre-rendered to offscreen canvas.
 * Rendered once, blitted every frame via drawImage (fast).
 * No gradients on the base = no banding. No animation dependency.
 */

// Seeded PRNG — deterministic random
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

let cached = null;
let cachedW = 0;
let cachedH = 0;

function renderOnce(W, H, dpr) {
  const off = document.createElement('canvas');
  off.width = W;
  off.height = H;
  const ctx = off.getContext('2d');

  // Flat solid background — no gradient, no banding
  ctx.fillStyle = '#08080E';
  ctx.fillRect(0, 0, W, H);

  // Stars — fully random scatter
  const starCount = Math.floor((W * H) / (45000 * dpr));
  const rng = mulberry32(7919);
  const starColors = ['#8B4513', '#93C5FD', '#6EE7B7', '#FDE68A', '#FDA4AF', '#A5B4FC'];

  for (let i = 0; i < starCount; i++) {
    const sx = rng() * W;
    const sy = rng() * H;
    const brightness = rng();

    const size = brightness < 0.7
      ? (0.4 + brightness * 0.6) * dpr
      : (0.8 + (brightness - 0.7) * 3.5) * dpr;

    const alpha = Math.min(1, 0.3 + brightness * 0.55);
    ctx.globalAlpha = alpha;

    // Color — most white, bright ones tinted
    let color = '#2C1810';
    if (brightness > 0.7) {
      color = starColors[Math.floor(rng() * starColors.length)];
    } else {
      rng(); // consume to keep sequence stable
    }

    // Soft glow for bright stars (small, won't read as layers)
    if (size > 1.2 * dpr) {
      const gs = size * 3;
      ctx.beginPath();
      ctx.arc(sx, sy, gs, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(180,140,60,${alpha * 0.04})`;
      ctx.fill();
    }

    // Star dot
    ctx.beginPath();
    ctx.arc(sx, sy, size, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  ctx.globalAlpha = 1;
  return off;
}

export function drawStarfield(ctx) {
  ctx.save();
  ctx.resetTransform();

  const W = ctx.canvas.width;
  const H = ctx.canvas.height;

  // Render once, cache, blit
  if (!cached || cachedW !== W || cachedH !== H) {
    const dpr = window.devicePixelRatio || 1;
    cached = renderOnce(W, H, dpr);
    cachedW = W;
    cachedH = H;
  }

  ctx.drawImage(cached, 0, 0);
  ctx.restore();
}
