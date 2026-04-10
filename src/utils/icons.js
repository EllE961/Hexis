/**
 * Canvas Icon System — renders Lucide-quality SVG icons on canvas.
 *
 * Each icon is defined as an SVG string (24x24 viewBox, stroke-based).
 * Icons are pre-rendered to offscreen canvases and cached by size+color.
 * Drawing an icon is a single `drawImage` call — zero per-frame cost.
 *
 * To add a new icon: add its SVG markup to ICON_SVGS below.
 * To change a mapping: edit TYPE_TO_ICON.
 */

// ─── Icon SVG definitions (from Lucide, 24x24 viewBox) ───

const ICON_SVGS = {
  lightbulb: `<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>`,
  code: `<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>`,
  compass: `<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>`,
  layout: `<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><line x1="3" x2="21" y1="9" y2="9"/><line x1="9" x2="9" y1="21" y2="9"/>`,
  palette: `<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>`,
  settings: `<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>`,
  scale: `<path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/>`,
  search: `<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>`,
  bookopen: `<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>`,
  clock: `<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>`,
  bookletter: `<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/><path d="M8 7h4"/><path d="M8 11h4"/>`,
  ruler: `<path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"/><path d="m14.5 12.5 2-2"/><path d="m11.5 9.5 2-2"/><path d="m8.5 6.5 2-2"/><path d="m17.5 15.5 2-2"/>`,
  image: `<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>`,
  map: `<polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/><line x1="9" x2="9" y1="3" y2="18"/><line x1="15" x2="15" y1="6" y2="21"/>`,
  alerttriangle: `<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>`,
  star: `<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>`,
  file: `<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>`,
  filecode: `<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m10 13-2 2 2 2"/><path d="m14 17 2-2-2-2"/>`,
  microscope: `<path d="M6 18h8"/><path d="M3 22h18"/><path d="M14 22a7 7 0 1 0 0-14h-1"/><path d="M9 14h2"/><path d="M9 12a2 2 0 0 1-2-2V6h6v4a2 2 0 0 1-2 2Z"/><path d="M12 6V3a1 1 0 0 0-1-1H9a1 1 0 0 0-1 1v3"/>`,
  diamond: `<path d="M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41l-7.59-7.59a2.41 2.41 0 0 0-3.41 0Z"/>`,
  layers: `<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22.54 12.43-1.96-.89-8.58 3.91a2 2 0 0 1-1.66 0l-8.58-3.9-1.96.87a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22.54 16.43-1.96-.89-8.58 3.91a2 2 0 0 1-1.66 0l-8.58-3.9-1.96.87a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/>`,
  home: `<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>`,
};

// ─── Type → Icon mapping (flexible — edit this to change icons) ───

const TYPE_TO_ICON = {
  concept: 'lightbulb',
  api: 'filecode',
  guide: 'compass',
  architecture: 'layout',
  design: 'palette',
  mechanic: 'settings',
  decision: 'scale',
  research: 'microscope',
  reference: 'bookopen',
  changelog: 'clock',
  glossary: 'bookletter',
  conventions: 'ruler',
  asset: 'image',
  level: 'map',
  troubleshooting: 'alerttriangle',
  index: 'home',
  unknown: 'file',
};

// ─── Icon cache: pre-rendered to offscreen canvases ───

const iconCache = new Map(); // "iconName|size|color" → HTMLCanvasElement

function buildSVG(iconName, size, color) {
  const paths = ICON_SVGS[iconName] || ICON_SVGS.file;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

function renderIconToCanvas(iconName, size, color) {
  const key = `${iconName}|${size}|${color}`;
  if (iconCache.has(key)) return iconCache.get(key);

  const dpr = window.devicePixelRatio || 1;
  const pxSize = Math.ceil(size * dpr);
  const canvas = document.createElement('canvas');
  canvas.width = pxSize;
  canvas.height = pxSize;

  const img = new Image();
  const svg = buildSVG(iconName, pxSize, color);
  img.src = 'data:image/svg+xml,' + encodeURIComponent(svg);

  // Store a promise-like: null until loaded, then the canvas
  const entry = { canvas, ready: false };
  iconCache.set(key, entry);

  img.onload = () => {
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, pxSize, pxSize);
    entry.ready = true;
  };

  // Try sync draw (works if SVG is simple enough for immediate decode)
  try {
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, pxSize, pxSize);
    entry.ready = true;
  } catch {}

  return entry;
}

/**
 * Draw an icon on a canvas context.
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} type — node type (e.g., 'concept', 'research')
 * @param {number} cx — center X in graph coordinates
 * @param {number} cy — center Y in graph coordinates
 * @param {number} size — icon size in screen pixels
 * @param {string} color — stroke color
 */
export function drawIcon(ctx, type, cx, cy, size, color = '#2C1810') {
  const iconName = TYPE_TO_ICON[type] || TYPE_TO_ICON.unknown;
  const entry = renderIconToCanvas(iconName, Math.round(size), color);

  if (!entry.ready) return; // not loaded yet, will appear next frame

  const dpr = window.devicePixelRatio || 1;
  const drawSize = size / dpr;

  ctx.save();
  ctx.drawImage(entry.canvas, cx - drawSize / 2, cy - drawSize / 2, drawSize, drawSize);
  ctx.restore();
}

/**
 * Get the icon name for a node type.
 */
export function getIconName(type) {
  return TYPE_TO_ICON[type] || 'file';
}

/**
 * Get all available icon names.
 */
export function getAvailableIcons() {
  return Object.keys(ICON_SVGS);
}

/**
 * Register a custom icon SVG for a type.
 */
export function registerIcon(name, svgPaths) {
  ICON_SVGS[name] = svgPaths;
}

/**
 * Map a node type to an icon name.
 */
export function mapTypeToIcon(type, iconName) {
  TYPE_TO_ICON[type] = iconName;
}
