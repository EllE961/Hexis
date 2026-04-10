/**
 * CellRenderer — premium polished honeycomb cell.
 *
 * Each cell looks like a wax chamber:
 * - Bright warm gradient from top-left (light source)
 * - Visible 3D depth: top bevel (light), bottom shadow (dark)
 * - Bold letter icon with text shadow for readability
 * - Filename label with contrast background pill
 * - Clean git status as colored corner badge
 */

import { hexPath } from '../../utils/hexMath.js';

const HEX_SIZE = 30;

// Git-status borders — conflict and test-fail are "alarm" states and stay
// bold. Modified/staged are informational — they must be CLEAR but must NOT
// cover hover/selection/group-highlight effects that layer on top. Solution:
// thin (1.2px same as the default gray border) + 55% alpha so the base cell
// gradient and any overlay wash still read through cleanly. The corner dot
// badge (drawn later) is the primary "this is modified" signal.
const BORDER_STATES = {
  conflict:  { color: '#EF4444',  width: 2.5 },  // alarm — stays bold
  modified:  { color: '#F59E0B8C', width: 1.2 },  // subtle, 55% alpha amber
  staged:    { color: '#22C55E8C', width: 1.2 },  // subtle, 55% alpha green
  untracked: { color: '#58A6FF8C', width: 1.2 },  // subtle, 55% alpha blue — new file
  clean:     { color: null,       width: 0 },
  testFail:  { color: '#DC2626',  width: 2 },    // alarm — stays bold
};

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function tint(sectionColor, baseR, baseG, baseB, amount) {
  const [sr, sg, sb] = hexToRgb(sectionColor);
  return `rgb(${Math.round(baseR + (sr - baseR) * amount)},${Math.round(baseG + (sg - baseG) * amount)},${Math.round(baseB + (sb - baseB) * amount)})`;
}

export function drawCell(ctx, file, x, y, sectionColor, zoomLevel, state = {}) {
  const { selected, hovered, gitStatus, testStatus, aiStatus } = state;
  const isAgentActive = aiStatus === 'reading' || aiStatus === 'editing';
  const isLandmark = file.is_landmark;
  const s = isLandmark ? HEX_SIZE * 1.02 : HEX_SIZE * 0.96;

  // ─── Satellite: warm dot ───
  if (zoomLevel === 'satellite') {
    ctx.beginPath();
    ctx.arc(x, y, isLandmark ? 5 : 3.5, 0, Math.PI * 2);
    ctx.fillStyle = sectionColor;
    ctx.globalAlpha = selected ? 1 : 0.8;
    ctx.fill();
    ctx.globalAlpha = 1;
    return;
  }

  // ─── Region: tinted hex, no details ───
  if (zoomLevel === 'region') {
    hexPath(ctx, x, y, s);
    ctx.fillStyle = tint(sectionColor, 22, 27, 34, 0.4);
    ctx.fill();
    hexPath(ctx, x, y, s);
    ctx.strokeStyle = sectionColor + '40';
    ctx.lineWidth = 0.8;
    ctx.stroke();
    return;
  }

  // ─── City / Street / Interior: full polished cell ───
  ctx.save();

  // === 1. CELL BODY: warm wax gradient ===
  hexPath(ctx, x, y, s);

  // Gradient: top-left light source → bottom-right shadow
  const grad = ctx.createLinearGradient(x - s * 0.6, y - s * 0.7, x + s * 0.6, y + s * 0.7);

  if (selected) {
    grad.addColorStop(0, tint(sectionColor, 60, 68, 80, 0.55));
    grad.addColorStop(0.45, tint(sectionColor, 35, 42, 52, 0.45));
    grad.addColorStop(1, tint(sectionColor, 18, 24, 32, 0.4));
  } else if (hovered) {
    grad.addColorStop(0, tint(sectionColor, 50, 58, 70, 0.5));
    grad.addColorStop(0.45, tint(sectionColor, 30, 38, 48, 0.4));
    grad.addColorStop(1, tint(sectionColor, 18, 24, 32, 0.35));
  } else {
    // Default: cool dark cell
    grad.addColorStop(0, tint(sectionColor, 40, 48, 58, 0.38));
    grad.addColorStop(0.4, tint(sectionColor, 25, 32, 42, 0.32));
    grad.addColorStop(1, tint(sectionColor, 15, 20, 30, 0.25));
  }
  ctx.fillStyle = grad;
  ctx.fill();

  // === 2. TOP BEVEL: light catches the upper edges ===
  // Top-left edge (bright)
  ctx.beginPath();
  const a4 = (Math.PI / 3) * 4;
  const a5 = (Math.PI / 3) * 5;
  const a0 = 0;
  const bv = s * 0.88;
  ctx.moveTo(x + bv * Math.cos(a4), y + bv * Math.sin(a4));
  ctx.lineTo(x + bv * Math.cos(a5), y + bv * Math.sin(a5));
  ctx.lineTo(x + bv * Math.cos(a0), y + bv * Math.sin(a0));
  ctx.strokeStyle = 'rgba(200, 210, 225, 0.18)';
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  ctx.stroke();

  // Bottom-right edge (shadow)
  ctx.beginPath();
  const a1 = (Math.PI / 3) * 1;
  const a2 = (Math.PI / 3) * 2;
  const a3 = (Math.PI / 3) * 3;
  ctx.moveTo(x + bv * Math.cos(a1), y + bv * Math.sin(a1));
  ctx.lineTo(x + bv * Math.cos(a2), y + bv * Math.sin(a2));
  ctx.lineTo(x + bv * Math.cos(a3), y + bv * Math.sin(a3));
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // === 3. BORDER ===
  const borderState = getBorderState(gitStatus, testStatus);
  hexPath(ctx, x, y, s);

  if (selected) {
    ctx.strokeStyle = '#58A6FF';
    ctx.lineWidth = 2.5;
  } else if (hovered) {
    ctx.strokeStyle = sectionColor + 'BB';
    ctx.lineWidth = 2;
  } else if (borderState.color) {
    ctx.strokeStyle = borderState.color;
    ctx.lineWidth = borderState.width;
  } else {
    ctx.strokeStyle = 'rgba(68, 76, 86, 0.5)';
    ctx.lineWidth = 1.2;
  }
  ctx.stroke();

  // === 4. INNER CONTENT ===
  const baseName = file.name.replace(/\.[^.]+$/, '');
  const showLabel = zoomLevel === 'city' || zoomLevel === 'street' || zoomLevel === 'interior';

  // Letter icon — bold, with subtle text shadow for readability
  const letter = baseName.charAt(0).toUpperCase();
  const iconSize = isLandmark ? 15 : 12;
  const iconY = y - (showLabel ? s * 0.15 : 0);

  ctx.font = `700 ${iconSize}px Inter, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Text shadow (dark behind, for contrast)
  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.fillText(letter, x + 0.5, iconY + 0.5);

  // Main letter
  ctx.fillStyle = selected ? '#FFFFFF' : hovered ? '#E6EDF3' : tint(sectionColor, 200, 210, 225, 0.6);
  ctx.fillText(letter, x, iconY);

  // Filename label — with background pill for readability
  if (showLabel) {
    let label = baseName;
    const labelSize = isLandmark ? 7.5 : 6;
    const labelY = y + s * 0.35;
    const maxW = s * 1.5;

    ctx.font = `500 ${labelSize}px Inter, system-ui, sans-serif`;

    if (ctx.measureText(label).width > maxW) {
      while (ctx.measureText(label + '…').width > maxW && label.length > 2) label = label.slice(0, -1);
      label += '…';
    }

    const tw = ctx.measureText(label).width;

    // Label background pill
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    const pillW = tw + 6;
    const pillH = labelSize + 3;
    const pillX = x - pillW / 2;
    const pillY = labelY - pillH / 2;
    ctx.beginPath();
    ctx.roundRect(pillX, pillY, pillW, pillH, 2);
    ctx.fill();

    // Label text
    ctx.fillStyle = selected ? '#FFFFFF' : hovered ? '#E6EDF3' : '#8B949E';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, labelY);
  }

  // === 5. GIT STATUS: tiny colored corner badge ===
  // A small (2.2px) dot at the top-right corner. This is the PRIMARY
  // "this cell is modified" signal — the border is deliberately subtle so
  // hover/selection/group-highlight effects show through cleanly. Color by
  // state: amber = modified, green = staged, blue = untracked (new file),
  // red = merge conflict.
  const badgeColor =
    gitStatus === 'modified' ? '#F59E0B' :
    gitStatus === 'staged' ? '#22C55E' :
    gitStatus === 'untracked' ? '#58A6FF' :
    gitStatus === 'conflict' ? '#EF4444' :
    null;
  if (badgeColor) {
    const bx = x + s * 0.52;
    const by = y - s * 0.52;
    // Outer soft halo — reads as a subtle hint at distance
    ctx.beginPath();
    ctx.arc(bx, by, 4.2, 0, Math.PI * 2);
    ctx.fillStyle = badgeColor + '30';  // 19% alpha halo
    ctx.fill();
    // Crisp core dot
    ctx.beginPath();
    ctx.arc(bx, by, 2.2, 0, Math.PI * 2);
    ctx.fillStyle = badgeColor;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.lineWidth = 0.4;
    ctx.stroke();
  }

  // === 6. AGENT ACTIVITY OVERLAY ===
  if (isAgentActive) {
    const agentColor = aiStatus === 'editing' ? '#14B8A6' : '#3B82F6';
    const pulse = Math.sin(Date.now() * 0.004) * 0.3 + 0.7;
    hexPath(ctx, x, y, s);
    ctx.strokeStyle = agentColor;
    ctx.lineWidth = 2.5 * pulse;
    ctx.setLineDash([5, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.restore();
}

/**
 * Draw an EMPTY cell — a placeholder hex that shows where new files can
 * land (drop targets for drag-drop, click targets for "new file here").
 *
 * Visual: thin dashed hex outline at low alpha, with a subtle "+" glyph
 * in the center for discoverability. When a drag is hovering this cell
 * (`dropTarget: true`), it brightens + fills with the section color at
 * ~20% alpha and pulses gently.
 *
 * Skipped in `satellite` zoom (at that distance the empty slots would
 * just be visual noise).
 */
export function drawEmptyCell(ctx, x, y, sectionColor, zoomLevel, state = {}) {
  if (zoomLevel === 'satellite') return;

  const { dropTarget = false, hovered = false } = state;
  const s = HEX_SIZE * 0.88;

  ctx.save();

  if (dropTarget) {
    // ─── Drop target highlight — pulses amber + section color fill ───
    const pulse = Math.sin(Date.now() * 0.006) * 0.15 + 0.85;
    hexPath(ctx, x, y, s);
    ctx.fillStyle = sectionColor + '33'; // ~20% alpha section tint
    ctx.fill();
    ctx.strokeStyle = `rgba(240, 160, 48, ${pulse})`;
    ctx.lineWidth = 2.2;
    ctx.setLineDash([]);
    ctx.stroke();

    // + glyph bigger + bright
    ctx.fillStyle = `rgba(240, 160, 48, ${pulse})`;
    ctx.font = `700 ${Math.round(HEX_SIZE * 0.5)}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('+', x, y + 1);
  } else {
    // ─── Passive placeholder — faint dashed outline + tiny + ───
    // Region zoom: just a very faint outline, no +
    if (zoomLevel === 'region') {
      hexPath(ctx, x, y, s);
      ctx.strokeStyle = 'rgba(139, 148, 158, 0.15)';
      ctx.lineWidth = 0.8;
      ctx.setLineDash([]);
      ctx.stroke();
      ctx.restore();
      return;
    }

    hexPath(ctx, x, y, s);
    ctx.strokeStyle = hovered
      ? 'rgba(240, 160, 48, 0.5)'
      : 'rgba(139, 148, 158, 0.22)';
    ctx.lineWidth = hovered ? 1.4 : 1;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Subtle + glyph in the center — only in city/street/interior
    if (zoomLevel !== 'region') {
      ctx.fillStyle = hovered
        ? 'rgba(240, 160, 48, 0.55)'
        : 'rgba(139, 148, 158, 0.28)';
      ctx.font = `400 ${Math.round(HEX_SIZE * 0.4)}px Inter, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('+', x, y + 1);
    }
  }

  ctx.restore();
}

function getBorderState(gitStatus, testStatus) {
  if (gitStatus === 'conflict') return BORDER_STATES.conflict;
  if (testStatus === 'fail') return BORDER_STATES.testFail;
  if (gitStatus === 'modified') return BORDER_STATES.modified;
  if (gitStatus === 'staged') return BORDER_STATES.staged;
  if (gitStatus === 'untracked') return BORDER_STATES.untracked;
  return BORDER_STATES.clean;
}
