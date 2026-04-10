/**
 * Legacy `tokens.js` — compat shim that re-exports from `window-tokens.js`.
 *
 * All new code should import from `window-tokens.js` directly:
 *   import { W } from '../../theme/window-tokens.js';
 *
 * The `colors` and `statusColor` objects below are maintained for backwards
 * compatibility with older components. They are VIEWS onto the active theme
 * and update automatically when `setTheme()` is called.
 *
 * Do not add new keys here — add them to `window-tokens.js` instead.
 */

import { W } from './window-tokens.js';

export { W, setTheme, themes, getThemeName, onThemeChange } from './window-tokens.js';

// ─── Legacy `colors` — proxied view onto active W theme ───
export const colors = new Proxy({}, {
  get(_, key) {
    // Map legacy color names → W token keys
    switch (key) {
      case 'bgDeep':       return W.bg0;
      case 'bgBase':       return W.bg1;
      case 'bgSurface':    return W.bg2;
      case 'bgElevated':   return W.bg3;
      case 'bgOverlay':    return W.bg4;

      case 'textPrimary':   return W.text;
      case 'textSecondary': return W.textDim;
      case 'textTertiary':  return W.textMuted;

      case 'accent':       return W.accent;
      case 'accentHover':  return W.accentHover;
      case 'accentDim':    return W.accentSoft;

      // Section colors — mapped to semantic status colors (no warm browns)
      case 'engine':    return W.accent;
      case 'game':      return W.yellow;
      case 'research':  return W.teal;
      case 'decisions': return W.accent;
      case 'shared':    return W.green;
      case 'templates': return W.textMuted;

      case 'healthy':  return W.green;
      case 'warning':  return W.yellow;
      case 'error':    return W.red;
      case 'neutral':  return W.textMuted;

      case 'border':       return W.border;
      case 'borderHover':  return W.borderHi;
      case 'borderStrong': return W.borderActive;

      case 'gridLine':        return W.borderSubtle;
      case 'gridLineActive':  return W.border;

      default:
        // Fall through to W if the key matches directly
        return W[key];
    }
  },
});

export const sectionColor = new Proxy({}, {
  get(_, key) {
    return colors[key] || W.textMuted;
  },
});

export function getDynSectionColor(section, dynamicColors) {
  if (dynamicColors && dynamicColors[section]) return dynamicColors[section];
  return sectionColor[section] || W.textMuted;
}

export const statusColor = new Proxy({}, {
  get(_, key) {
    switch (key) {
      case 'stable':      return W.green;
      case 'review':      return W.accent;
      case 'draft':       return W.textMuted;
      case 'deprecated':  return W.textMuted;
      case 'in-progress': return W.accent;
      case 'complete':    return W.green;
      case 'applied':     return W.green;
      case 'stale':       return W.yellow;
      case 'abandoned':   return W.textMuted;
      case 'unknown':     return W.textMuted;
      default:            return W.textMuted;
    }
  },
});

// ─── Timing + easing (structural, not color) ───

export const timing = {
  instant: 50,
  fast: 120,
  medium: 240,
  smooth: 360,
  deliberate: 600,
};

export const easing = {
  default: 'cubic-bezier(0.25, 0.1, 0.25, 1)',
  decelerate: 'cubic-bezier(0.0, 0.0, 0.2, 1)',
  accelerate: 'cubic-bezier(0.4, 0.0, 1, 1)',
  microspring: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
  expoOut: 'cubic-bezier(0.16, 1, 0.3, 1)',
};

// ─── Hex grid ───
export const HEX_SIZE = 55;
