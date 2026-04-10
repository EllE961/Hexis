import { colors, statusColor } from '../theme/tokens.js';
import { useGraphStore } from '../hooks/useGraph.js';

/** Get node color from dynamic server-provided section colors */
export function getNodeColor(node) {
  const dynColors = useGraphStore.getState().sectionColors;
  return dynColors[node.section] || node.color || colors.neutral;
}

export function getStatusColor(status) {
  return statusColor[status] || colors.neutral;
}

/** Get section color dynamically */
export function getSectionColor(section) {
  const dynColors = useGraphStore.getState().sectionColors;
  return dynColors[section] || colors.neutral;
}

export function getEdgeColor(edge, nodes) {
  switch (edge.type) {
    case 'markdown-link': {
      const sourceNode = nodes.find(n => n.id === edge.source);
      return sourceNode ? getNodeColor(sourceNode) : colors.neutral;
    }
    case 'frontmatter-related': return 'rgba(180,140,60,0.2)';
    case 'shared-tag': return 'rgba(180,140,60,0.06)';
    case 'co-change': return colors.accent;
    case 'applied-to': return colors.decisions || colors.warning;
    default: return 'rgba(180,140,60,0.1)';
  }
}

export function hexToRgba(hex, alpha) {
  if (!hex || hex.startsWith('rgba')) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
