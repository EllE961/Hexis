/**
 * Window system design tokens — single source of truth for the entire app.
 *
 * ──────────────────────────────────────────────────────────────
 * HOW TO ADD / CHANGE THEMES
 * ──────────────────────────────────────────────────────────────
 *
 * Every color, space, font, shadow, border and z-index used by Hexis
 * lives in this file. No hardcoded colors should exist anywhere else.
 *
 * To tweak the look of the app:
 *   1. Edit values in the `dark` theme below (or any other theme).
 *   2. The change applies everywhere instantly — panels, modals, popovers,
 *      buttons, tabs, status bar, tooltips, the lot.
 *
 * To add a new theme:
 *   1. Copy the `dark` object, rename it, tweak the values.
 *   2. Register it in the `themes` map.
 *   3. Call `setTheme('your-theme-name')` anywhere in the app.
 *
 * Tokens are grouped by purpose:
 *   - color.surface  — 5 elevation levels (bg0..bg4)
 *   - color.text     — 4-tier text hierarchy
 *   - color.border   — subtle / default / highlighted
 *   - color.accent   — the single accent color used everywhere (amber)
 *   - color.status   — semantic (green/red/yellow/blue/purple/teal/pink)
 *   - spacing, sizing, radius, shadow, zIndex, animation, font
 *
 * `W` is a mutable object — assign new theme values into it with `setTheme`.
 * Inline style consumers read from `W` directly and re-render on React state
 * changes. For Tailwind/CSS, call `injectCssVars()` which publishes
 * `--hexis-*` custom properties on :root.
 */

// ─────────────────────────────────────────────────────────────
// BASE structure — all themes must fill in every key here.
// ─────────────────────────────────────────────────────────────

function buildTheme(overrides) {
  // Non-color structural tokens are the same across all themes.
  const structural = {
    // ─── Spacing (4px grid) ───
    s0: 0,
    s1: 4,
    s2: 8,
    s3: 12,
    s4: 16,
    s5: 20,
    s6: 24,
    s8: 32,

    // ─── Sizing — VS Code compact density ───
    headerHeight: 36,
    tabHeight: 30,          // was 32 — matches VS Code's tab strip
    rowHeight: 22,          // was 28 — tree + context menu
    buttonHeight: 22,
    hitTarget: 32,

    // Dock / menu chrome (compact)
    dockHeaderHeight: 28,   // was 32 — VS Code panel headers
    dockBtnSize: 22,        // was 28 — header control buttons
    menuBarHeight: 28,      // was 32

    // ─── Icon sizes — compact IDE scale, baseline 14px ───
    icon:    14,            // default — menu items, tree rows, tab close
    iconSm:  12,            // tiny — dock header controls, inline hints
    iconMd:  16,            // primary buttons, file icons, dock brand
    iconLg:  20,            // modal headers, empty-state primary
    iconXl:  28,            // welcome / onboarding

    // Legacy aliases (do not remove — imported in several places)
    iconSize: 14,
    // iconLg already defined above

    // ─── Border radius ───
    radius0: 0,
    radius1: 4,
    radius2: 6,
    radius3: 10,
    radius4: 14,

    // ─── Z-index ───
    zPanelDocked: 25,
    zStatusBar: 50,
    zPanelFloat: 100,
    zDropZone: 200,
    zPopover: 300,
    zContextMenu: 400,
    zModalBackdrop: 900,
    zModal: 1000,
    zTooltip: 2000,

    // ─── Animation ───
    animFast: '120ms cubic-bezier(0.25, 0.1, 0.25, 1)',
    animMed: '200ms cubic-bezier(0.22, 0.61, 0.36, 1)',
    animSlow: '320ms cubic-bezier(0.16, 1, 0.3, 1)',

    // ─── Typography ───
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", system-ui, sans-serif',
    fontMono: '"JetBrains Mono", "Fira Code", "Cascadia Code", Consolas, monospace',

    fontXs: 10,
    fontSm: 11,
    fontMd: 12,
    fontLg: 13,
    fontXl: 14,
    font2xl: 16,
    font3xl: 20,

    fontWeightNormal: 400,
    fontWeightMed: 500,
    fontWeightSemi: 600,
    fontWeightBold: 700,
  };

  return { ...structural, ...overrides };
}

// ─────────────────────────────────────────────────────────────
// THEMES
// ─────────────────────────────────────────────────────────────

/**
 * Dark (default) — cool neutral GitHub-style dark with amber accent.
 * High contrast (AAA on primary text, AA on secondary).
 * NO brown/warm muddiness — surfaces are pure neutral gray.
 */
const dark = buildTheme({
  name: 'dark',

  // ─── Surfaces (5 elevation levels, neutral cool gray) ───
  bg0: '#0B0F14',         // deepest — behind everything (pure cool dark)
  bg1: '#12171F',         // panel body
  bg2: '#1A2029',         // panel header / elevated
  bg3: '#242C38',         // hover / input field
  bg4: '#2E3744',         // active / pressed

  // ─── Text (4-tier hierarchy) ───
  text:      '#E6EDF3',   // primary — near white
  textDim:   '#A8B3BE',   // secondary — labels, metadata
  textMuted: '#6E7A89',   // tertiary — placeholders, captions
  textGhost: '#4A5360',   // quaternary — inactive icons

  // ─── Borders ───
  border:       'rgba(166, 180, 196, 0.12)',
  borderSubtle: 'rgba(166, 180, 196, 0.06)',
  borderHi:     'rgba(240, 160, 48, 0.5)',
  borderActive: 'rgba(240, 160, 48, 0.85)',

  // ─── Accent (single amber, used everywhere) ───
  accent:      '#F0A030',
  accentBg:    'rgba(240, 160, 48, 0.08)',
  accentSoft:  'rgba(240, 160, 48, 0.15)',
  accentHover: 'rgba(240, 160, 48, 0.25)',

  // ─── Status (semantic) ───
  green:  '#3FB950',  greenBg:  'rgba(63, 185, 80, 0.12)',
  red:    '#F85149',  redBg:    'rgba(248, 81, 73, 0.12)',
  blue:   '#58A6FF',  blueBg:   'rgba(88, 166, 255, 0.12)',
  yellow: '#D4A017',  yellowBg: 'rgba(212, 160, 23, 0.12)',
  purple: '#A855F7',  purpleBg: 'rgba(168, 85, 247, 0.12)',
  teal:   '#14B8A6',  tealBg:   'rgba(20, 184, 166, 0.12)',
  pink:   '#EC4899',  pinkBg:   'rgba(236, 72, 153, 0.12)',

  // ─── Shadows ───
  shadow0: 'none',
  shadow1: '0 1px 3px rgba(0, 0, 0, 0.4)',
  shadow2: '0 4px 12px rgba(0, 0, 0, 0.5)',
  shadow3: '0 12px 32px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(0, 0, 0, 0.3)',
  shadow4: '0 24px 64px rgba(0, 0, 0, 0.75), 0 0 0 1px rgba(0, 0, 0, 0.4)',
  shadowGlow: '0 0 16px rgba(240, 160, 48, 0.3)',
});

/**
 * Midnight — deeper blue-black variant, same amber accent.
 */
const midnight = buildTheme({
  name: 'midnight',

  bg0: '#070A12',
  bg1: '#0D1220',
  bg2: '#141A2B',
  bg3: '#1E2438',
  bg4: '#2A3148',

  text:      '#E8EEF7',
  textDim:   '#A6B4CC',
  textMuted: '#6A7A96',
  textGhost: '#4A5572',

  border:       'rgba(170, 190, 220, 0.12)',
  borderSubtle: 'rgba(170, 190, 220, 0.06)',
  borderHi:     'rgba(240, 160, 48, 0.5)',
  borderActive: 'rgba(240, 160, 48, 0.85)',

  accent:      '#F0A030',
  accentBg:    'rgba(240, 160, 48, 0.08)',
  accentSoft:  'rgba(240, 160, 48, 0.15)',
  accentHover: 'rgba(240, 160, 48, 0.25)',

  green:  '#4BE07A',  greenBg:  'rgba(75, 224, 122, 0.12)',
  red:    '#FF6B6B',  redBg:    'rgba(255, 107, 107, 0.12)',
  blue:   '#63B3FF',  blueBg:   'rgba(99, 179, 255, 0.12)',
  yellow: '#E6B800',  yellowBg: 'rgba(230, 184, 0, 0.12)',
  purple: '#B084FF',  purpleBg: 'rgba(176, 132, 255, 0.12)',
  teal:   '#2BD4C1',  tealBg:   'rgba(43, 212, 193, 0.12)',
  pink:   '#FF5FA8',  pinkBg:   'rgba(255, 95, 168, 0.12)',

  shadow0: 'none',
  shadow1: '0 1px 3px rgba(0, 0, 0, 0.5)',
  shadow2: '0 4px 12px rgba(0, 0, 0, 0.6)',
  shadow3: '0 12px 32px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(0, 0, 0, 0.4)',
  shadow4: '0 24px 64px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(0, 0, 0, 0.5)',
  shadowGlow: '0 0 16px rgba(240, 160, 48, 0.35)',
});

/**
 * High-contrast — stronger borders, brighter text for accessibility.
 */
const highContrast = buildTheme({
  name: 'high-contrast',

  bg0: '#000000',
  bg1: '#0A0F14',
  bg2: '#14191F',
  bg3: '#1F262E',
  bg4: '#2A333D',

  text:      '#FFFFFF',
  textDim:   '#C4CBD4',
  textMuted: '#8A93A0',
  textGhost: '#596271',

  border:       'rgba(255, 255, 255, 0.2)',
  borderSubtle: 'rgba(255, 255, 255, 0.1)',
  borderHi:     'rgba(255, 180, 60, 0.7)',
  borderActive: 'rgba(255, 180, 60, 1)',

  accent:      '#FFB43C',
  accentBg:    'rgba(255, 180, 60, 0.12)',
  accentSoft:  'rgba(255, 180, 60, 0.2)',
  accentHover: 'rgba(255, 180, 60, 0.3)',

  green:  '#4FD865',  greenBg:  'rgba(79, 216, 101, 0.15)',
  red:    '#FF6058',  redBg:    'rgba(255, 96, 88, 0.15)',
  blue:   '#6DB8FF',  blueBg:   'rgba(109, 184, 255, 0.15)',
  yellow: '#F0B820',  yellowBg: 'rgba(240, 184, 32, 0.15)',
  purple: '#BA6AFF',  purpleBg: 'rgba(186, 106, 255, 0.15)',
  teal:   '#24C8B4',  tealBg:   'rgba(36, 200, 180, 0.15)',
  pink:   '#FF5AA8',  pinkBg:   'rgba(255, 90, 168, 0.15)',

  shadow0: 'none',
  shadow1: '0 1px 3px rgba(0, 0, 0, 0.6)',
  shadow2: '0 4px 12px rgba(0, 0, 0, 0.7)',
  shadow3: '0 12px 32px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(0, 0, 0, 0.5)',
  shadow4: '0 24px 64px rgba(0, 0, 0, 0.9), 0 0 0 1px rgba(0, 0, 0, 0.6)',
  shadowGlow: '0 0 18px rgba(255, 180, 60, 0.4)',
});

// ─────────────────────────────────────────────────────────────
// THEME REGISTRY + ACTIVE THEME
// ─────────────────────────────────────────────────────────────

export const themes = {
  dark,
  midnight,
  'high-contrast': highContrast,
};

const STORAGE_KEY = 'hexis-theme';

function loadInitialThemeName() {
  try {
    const saved = typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY);
    if (saved && themes[saved]) return saved;
  } catch { /* ignore */ }
  return 'dark';
}

const initialName = loadInitialThemeName();

/**
 * `W` — the active theme. Imported everywhere.
 *
 * This object is MUTATED by `setTheme` — its identity never changes, only its
 * keys. React components that consume it via inline style re-read on every
 * render, so a theme swap followed by a re-render will pick up the new values.
 */
export const W = { ...themes[initialName] };

/**
 * Inject the active theme as CSS custom properties on :root so that
 * stylesheets and tailwind can use `var(--hexis-bg1)` etc.
 */
export function injectCssVars() {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(W)) {
    // Only publish color-ish strings (skip numbers, font families, etc.)
    if (typeof value === 'string' && (value.startsWith('#') || value.startsWith('rgb'))) {
      root.style.setProperty(`--hexis-${key}`, value);
    }
  }
  root.dataset.theme = W.name;
}

/**
 * Swap to a different theme at runtime.
 * Components using W via inline styles will pick up the new values on next
 * render. Call triggerRerender() in the consuming code if you need to force it.
 */
export function setTheme(name) {
  if (!themes[name]) {
    console.warn(`Unknown theme: ${name}. Available: ${Object.keys(themes).join(', ')}`);
    return;
  }
  // Clear and reassign — preserves object identity for any module that
  // happens to hold a reference to W.
  for (const k of Object.keys(W)) delete W[k];
  Object.assign(W, themes[name]);
  try { localStorage.setItem(STORAGE_KEY, name); } catch { /* ignore */ }
  injectCssVars();
  // Notify listeners so React components can re-render
  for (const cb of themeListeners) cb(name);
}

/** Get the currently active theme's name. */
export function getThemeName() {
  return W.name;
}

// ─── Theme change listeners (so React components can re-render on swap) ───

const themeListeners = new Set();
export function onThemeChange(cb) {
  themeListeners.add(cb);
  return () => themeListeners.delete(cb);
}

// ─── Initial inject ───
injectCssVars();

/** Utility: build a font shorthand. */
export function font(size, weight = 'normal') {
  const w = {
    normal: W.fontWeightNormal,
    med: W.fontWeightMed,
    semi: W.fontWeightSemi,
    bold: W.fontWeightBold,
  }[weight] || weight;
  return `${w} ${size}px ${W.fontFamily}`;
}
