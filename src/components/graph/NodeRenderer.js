import { colors } from '../../theme/tokens.js';
import { getNodeColor, getStatusColor, hexToRgba } from '../../utils/colors.js';
import { drawIcon as drawSvgIcon } from '../../utils/icons.js';

function getTier(node) {
  if (node.type === 'index' || node.label === 'README') return 1;
  if (node.type === 'decision' || node.type === 'architecture') return 2;
  if (['guide', 'concept', 'design', 'conventions', 'glossary'].includes(node.type)) return 3;
  if (node.type === 'research') return 4;
  return 5;
}

function getTierRadius(tier) {
  switch (tier) {
    case 1: return 40;
    case 2: return 34;
    case 3: return 30;
    case 4: return 28;
    default: return 24;
  }
}

function hexPath(ctx, cx, cy, r) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 6;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

// Old hand-drawn drawIcon removed — now using SVG-based icons from utils/icons.js

export function renderNode(node, ctx, globalScale, selectedId, hoveredId) {
  const isSelected = node.id === selectedId;
  const isHovered = node.id === hoveredId;
  const isDimmed = (selectedId || hoveredId) && !isSelected && !isHovered && !node._isConnected;
  const isFiltered = node._isFiltered;

  if (!isFinite(node.x) || !isFinite(node.y)) return;

  const nodeColor = getNodeColor(node);
  const statusClr = getStatusColor(node.status);
  const tier = getTier(node);
  const baseRadius = getTierRadius(tier);

  const s = 1 / globalScale;

  // Hover micro-animation: subtle scale pop
  const hoverScale = isHovered ? 1.08 : isSelected ? 1.04 : 1;
  const r = baseRadius * s * hoverScale;

  node._visualRadius = baseRadius + 12;

  const opacity = isFiltered ? 0.04 : isDimmed ? 0.06 : (node.opacity || 1);

  ctx.save();
  ctx.globalAlpha = opacity;

  // ─── Glow ───
  if (isSelected) {
    ctx.shadowColor = hexToRgba(colors.accent, 0.6);
    ctx.shadowBlur = 25 * s;
  } else if (isHovered) {
    ctx.shadowColor = hexToRgba(nodeColor, 0.5);
    ctx.shadowBlur = 20 * s;
  } else if (node.connections >= 4 && !isDimmed && !isFiltered) {
    ctx.shadowColor = hexToRgba(nodeColor, 0.2);
    ctx.shadowBlur = 10 * s;
  }

  // ─── Outer status ring ───
  if (!isDimmed && !isFiltered) {
    hexPath(ctx, node.x, node.y, r + 4 * s);
    ctx.strokeStyle = hexToRgba(statusClr, isSelected ? 0.6 : 0.35);
    ctx.lineWidth = 2 * s;
    if (node.status === 'draft' || node.status === 'in-progress') {
      ctx.setLineDash([5 * s, 4 * s]);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ─── Git change indicator ring ───
  if (node._gitChange && !isDimmed && !isFiltered) {
    const changeColor = node._gitChange === 'modified' ? '#F0A030'
      : node._gitChange === 'staged' ? '#22C55E'
      : '#3B82F6'; // untracked
    hexPath(ctx, node.x, node.y, r + 8 * s);
    ctx.strokeStyle = changeColor;
    ctx.lineWidth = 2.5 * s;
    ctx.globalAlpha = opacity * 0.7;
    if (node._gitChange === 'untracked') ctx.setLineDash([4 * s, 3 * s]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = opacity;
  }

  // ─── Main hexagon ───
  hexPath(ctx, node.x, node.y, r);

  const grad = ctx.createRadialGradient(
    node.x - r * 0.2, node.y - r * 0.2, 0,
    node.x, node.y, r
  );
  if (isSelected) {
    grad.addColorStop(0, hexToRgba(nodeColor, 0.3));
    grad.addColorStop(1, hexToRgba(nodeColor, 0.1));
  } else if (isHovered) {
    grad.addColorStop(0, hexToRgba(nodeColor, 0.25));
    grad.addColorStop(1, hexToRgba(nodeColor, 0.08));
  } else {
    grad.addColorStop(0, hexToRgba(nodeColor, 0.18));
    grad.addColorStop(1, hexToRgba(nodeColor, 0.05));
  }
  ctx.fillStyle = grad;
  ctx.fill();

  // Border
  ctx.strokeStyle = isSelected ? colors.accent
    : isHovered ? hexToRgba(nodeColor, 1)
    : hexToRgba(nodeColor, tier <= 2 ? 0.75 : 0.5);
  ctx.lineWidth = (isSelected ? 2.5 : isHovered ? 2 : tier <= 2 ? 1.8 : 1.2) * s;
  ctx.stroke();

  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;

  // Semantic zoom: hide details when zoomed out
  // globalScale < 0.4 = very zoomed out, only show dots
  // globalScale 0.4-0.7 = show icons but no labels
  // globalScale > 0.7 = full detail
  const showIcons = globalScale > 0.4 || isSelected || isHovered;
  const showLabels = globalScale > 0.7 || isSelected || isHovered;
  const showBadges = globalScale > 0.6;

  // ─── Icon (SVG-quality Lucide icons) ───
  if (!isFiltered && showIcons) {
    const iconSize = (tier <= 2 ? 20 : tier <= 3 ? 17 : 14) * s;
    drawSvgIcon(ctx, node.type, node.x, node.y - 1 * s, iconSize, '#2C1810');
  }

  // ─── Label below hexagon ───
  if (!isFiltered && showLabels) {
    const labelFontSize = (tier <= 2 ? 13 : tier <= 3 ? 12 : 11) * s;
    ctx.font = `${isSelected || tier <= 2 ? 600 : 500} ${labelFontSize}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = isSelected || isHovered ? '#2C1810' : (tier <= 2 ? '#3D2415' : '#6B4423');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    const maxW = (tier <= 2 ? 140 : 110) * s;
    let label = node.label;
    if (ctx.measureText(label).width > maxW) {
      while (ctx.measureText(label + '…').width > maxW && label.length > 3) label = label.slice(0, -1);
      label += '…';
    }
    ctx.fillText(label, node.x, node.y + r + 5 * s);

    // ─── Type subtitle for important nodes ───
    if (tier <= 3 && !isDimmed) {
      ctx.font = `400 ${10 * s}px Inter, system-ui, sans-serif`;
      ctx.fillStyle = hexToRgba(nodeColor, 0.6);
      ctx.fillText(node.type, node.x, node.y + r + 5 * s + labelFontSize + 2 * s);
    }
  }

  // ─── Connection badge ───
  if (node.connections >= 3 && !isDimmed && !isFiltered && showBadges) {
    const bx = node.x + r * 0.75;
    const by = node.y - r * 0.75;
    const br = 9 * s;
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(nodeColor, 0.9);
    ctx.fill();
    ctx.font = `700 ${8 * s}px Inter, sans-serif`;
    ctx.fillStyle = '#2C1810';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(node.connections), bx, by);
  }

  // ─── Git recency arc (bottom-left) ───
  // Shows a small colored arc: green = recent, amber = aging, red = stale
  if (!isDimmed && !isFiltered && node.lastModified) {
    const daysSince = Math.floor((Date.now() - new Date(node.lastModified).getTime()) / 86400000);
    let recencyColor;
    let arcFraction; // 0-1, how "full" the arc is (newer = fuller)
    if (daysSince <= 7) {
      recencyColor = '#22C55E'; arcFraction = 1;
    } else if (daysSince <= 30) {
      recencyColor = '#22C55E'; arcFraction = 0.7;
    } else if (daysSince <= 90) {
      recencyColor = '#EAB308'; arcFraction = 0.5;
    } else if (daysSince <= 180) {
      recencyColor = '#F0A030'; arcFraction = 0.3;
    } else {
      recencyColor = '#EF4444'; arcFraction = 0.15;
    }

    const arcR = r + 7 * s;
    const arcStart = Math.PI * 0.6;
    const arcEnd = arcStart + Math.PI * 0.8 * arcFraction;
    ctx.beginPath();
    ctx.arc(node.x, node.y, arcR, arcStart, arcEnd);
    ctx.strokeStyle = recencyColor;
    ctx.globalAlpha = opacity * 0.5;
    ctx.lineWidth = 2.5 * s;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.globalAlpha = opacity;
    ctx.lineCap = 'butt';
  }

  ctx.restore();
}

export function markConnectedNodes(nodes, edges, targetId) {
  const connectedIds = new Set();
  if (targetId) {
    connectedIds.add(targetId);
    for (const edge of edges) {
      const srcId = edge.source?.id ?? edge.source;
      const tgtId = edge.target?.id ?? edge.target;
      if (srcId === targetId) connectedIds.add(tgtId);
      if (tgtId === targetId) connectedIds.add(srcId);
    }
  }
  for (const node of nodes) {
    node._isConnected = !targetId || connectedIds.has(node.id);
  }
}
