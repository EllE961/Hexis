import { useRef, useCallback, useEffect, useState, useMemo } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { useGraphStore, isNodeVisible } from '../../hooks/useGraph.js';
import { renderNode } from './NodeRenderer.js';
import { drawHexBackground } from './HexBackground.js';
import { getEdgeColor, hexToRgba, getSectionColor } from '../../utils/colors.js';
import { colors, HEX_SIZE } from '../../theme/tokens.js';
import { computeHexLayout, pixelToHex } from '../../utils/hexLayout.js';
import { hexToPixel } from '../../utils/hexGrid.js';

const EDGE_TYPE_LABELS = {
  'markdown-link': 'link',
  'frontmatter-related': 'related',
  'shared-tag': 'shared tag',
  'co-change': 'co-change',
  'applied-to': 'applied to',
};

export const cachedGroupsRef = { current: {} };

export default function GraphCanvas({ onGraphRef }) {
  const graphRef = useRef();
  const wrapperRef = useRef();
  const dragStartRef = useRef(null);
  const layoutRef = useRef(null); // hex layout data
  const rawNodes = useGraphStore(s => s.nodes);
  const edges = useGraphStore(s => s.edges);
  const selectedNode = useGraphStore(s => s.selectedNode);
  const hoveredNode = useGraphStore(s => s.hoveredNode);
  const hoveredEdge = useGraphStore(s => s.hoveredEdge);
  const filters = useGraphStore(s => s.filters);
  const gitStatus = useGraphStore(s => s.gitStatus);
  const showChanges = useGraphStore(s => s.showChanges);
  const setSelectedNode = useGraphStore(s => s.setSelectedNode);
  const setHoveredNode = useGraphStore(s => s.setHoveredNode);
  const setHoveredEdge = useGraphStore(s => s.setHoveredEdge);
  const setPendingMove = useGraphStore(s => s.setPendingMove);
  const setDragOverGroup = useGraphStore(s => s.setDragOverGroup);

  const activeTarget = selectedNode || hoveredNode;

  // ─── Hex grid layout (replaces force simulation) ───
  const nodes = useMemo(() => {
    if (rawNodes.length === 0) return rawNodes;

    const layout = computeHexLayout(rawNodes, HEX_SIZE);
    layoutRef.current = layout;

    // All nodes now have fx/fy set — no physics needed
    return rawNodes;
  }, [rawNodes]);

  // Build connected set for highlighting
  const connectedRef = useRef(new Set());
  useEffect(() => {
    const connected = new Set();
    if (activeTarget) {
      connected.add(activeTarget);
      for (const edge of edges) {
        const srcId = edge.source?.id ?? edge.source;
        const tgtId = edge.target?.id ?? edge.target;
        if (srcId === activeTarget) connected.add(tgtId);
        if (tgtId === activeTarget) connected.add(srcId);
      }
    }
    connectedRef.current = connected;
  }, [activeTarget, edges]);

  const graphData = useMemo(() => ({ nodes, links: edges }), [nodes, edges]);

  // No forces — hex grid is static. Disable simulation immediately.
  useEffect(() => {
    if (!graphRef.current) return;
    const fg = graphRef.current;
    // Kill all forces
    fg.d3Force('charge', null);
    fg.d3Force('link', null);
    fg.d3Force('center', null);
    fg.d3Force('cluster', null);
  }, [nodes]);

  useEffect(() => {
    if (!graphRef.current) return;
    try {
      const dpr = window.devicePixelRatio || 1;
      if (typeof graphRef.current.pixelRatio === 'function') graphRef.current.pixelRatio(dpr);
    } catch {}
  }, []);

  useEffect(() => {
    if (graphRef.current && onGraphRef) onGraphRef(graphRef.current);
  }, [graphRef.current, onGraphRef]);

  // Zoom to fit after layout
  const [layoutDone, setLayoutDone] = useState(false);
  useEffect(() => {
    if (nodes.length > 0 && graphRef.current && !layoutDone) {
      setTimeout(() => {
        if (graphRef.current) graphRef.current.zoomToFit(400, 100);
        setLayoutDone(true);
      }, 200);
    }
  }, [nodes, layoutDone]);

  // ─── Draw background (hex grid + group territories) ───
  const drawBackground = useCallback((ctx, globalScale) => {
    const sectionColors = useGraphStore.getState().sectionColors;
    drawHexBackground(ctx, nodes, layoutRef.current?.groupCells, sectionColors);

    // Build cached group data for GroupOverlay labels
    const groupCells = layoutRef.current?.groupCells;
    if (groupCells) {
      const newCached = {};
      for (const [key, cells] of groupCells.entries()) {
        if (cells.length === 0) continue;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const cell of cells) {
          const pos = hexToPixel(cell.q, cell.r, HEX_SIZE);
          minX = Math.min(minX, pos.x - HEX_SIZE);
          maxX = Math.max(maxX, pos.x + HEX_SIZE);
          minY = Math.min(minY, pos.y - HEX_SIZE);
          maxY = Math.max(maxY, pos.y + HEX_SIZE);
        }
        const section = key.split('/')[0];
        const label = key.includes('/') ? key.split('/').pop() : key;
        const depth = (key.match(/\//g) || []).length;

        if (depth === 0) {
          newCached[key] = { minX, maxX, minY, maxY, nodes: [], depth: 0, label, section, children: {} };
        } else {
          const topKey = key.split('/')[0];
          if (!newCached[topKey]) {
            newCached[topKey] = { minX, maxX, minY, maxY, nodes: [], depth: 0, label: topKey, section, children: {} };
          }
          newCached[topKey].children[key] = { minX, maxX, minY, maxY, nodes: [], depth, label, section };
          // Expand parent to contain child
          newCached[topKey].minX = Math.min(newCached[topKey].minX, minX);
          newCached[topKey].maxX = Math.max(newCached[topKey].maxX, maxX);
          newCached[topKey].minY = Math.min(newCached[topKey].minY, minY);
          newCached[topKey].maxY = Math.max(newCached[topKey].maxY, maxY);
        }
      }
      cachedGroupsRef.current = newCached;
    }
  }, [nodes]);

  // ─── Node rendering ───
  const nodeCanvasObject = useCallback((node, ctx, globalScale) => {
    const connected = connectedRef.current;
    node._isConnected = !activeTarget || connected.has(node.id);
    node._isFiltered = !isNodeVisible(node, filters);
    if (showChanges && gitStatus) {
      node._gitChange = gitStatus.modified?.includes(node.id) ? 'modified'
        : gitStatus.staged?.includes(node.id) ? 'staged'
        : gitStatus.not_added?.includes(node.id) ? 'untracked'
        : null;
    } else {
      node._gitChange = null;
    }
    renderNode(node, ctx, globalScale, selectedNode, hoveredNode);
  }, [selectedNode, hoveredNode, activeTarget, filters, gitStatus, showChanges]);

  // ─── Node interaction ───
  const handleNodeClick = useCallback((node) => {
    if (node._isFiltered) return;
    setSelectedNode(node.id === selectedNode ? null : node.id);
    if (graphRef.current && node.id !== selectedNode) {
      graphRef.current.centerAt(node.x, node.y, 300);
      graphRef.current.zoom(2, 300);
    }
  }, [selectedNode, setSelectedNode]);

  const handleNodeHover = useCallback((node) => {
    if (node && node._isFiltered) { setHoveredNode(null); return; }
    setHoveredNode(node?.id || null);
    if (wrapperRef.current) {
      wrapperRef.current.style.cursor = node ? 'pointer' : 'default';
    }
  }, [setHoveredNode]);

  const handleBackgroundClick = useCallback(() => {
    setSelectedNode(null);
    if (graphRef.current) graphRef.current.zoomToFit(400, 100);
  }, [setSelectedNode]);

  // ─── Node drag → snap to hex grid ───
  const handleNodeDrag = useCallback((node) => {
    if (!dragStartRef.current || dragStartRef.current.id !== node.id) {
      dragStartRef.current = { id: node.id, x: node.fx ?? node.x, y: node.fy ?? node.y, q: node._hexQ, r: node._hexR };
    }
    // Show drop target
    const targetCell = pixelToHex(node.x, node.y, HEX_SIZE);
    const targetKey = `${targetCell.q},${targetCell.r}`;
    const layout = layoutRef.current;
    // Find which group this cell belongs to
    let targetGroup = null;
    if (layout?.groupCells) {
      for (const [gk, cells] of layout.groupCells.entries()) {
        if (cells.some(c => c.q === targetCell.q && c.r === targetCell.r)) {
          targetGroup = gk; break;
        }
      }
    }
    const currentGroup = node.groupPath?.length > 0 ? node.groupPath[node.groupPath.length - 1] : null;
    setDragOverGroup(targetGroup !== currentGroup ? targetGroup : null);
  }, [setDragOverGroup]);

  const handleNodeDragEnd = useCallback((node) => {
    setDragOverGroup(null);

    // Snap to nearest hex cell
    const targetCell = pixelToHex(node.x, node.y, HEX_SIZE);
    const layout = layoutRef.current;

    // Check if this cell is in a different group → file move
    let targetGroup = null;
    if (layout?.groupCells) {
      for (const [gk, cells] of layout.groupCells.entries()) {
        if (cells.some(c => c.q === targetCell.q && c.r === targetCell.r)) {
          targetGroup = gk; break;
        }
      }
    }
    const currentGroup = node.groupPath?.length > 0 ? node.groupPath[node.groupPath.length - 1] : null;

    if (targetGroup && targetGroup !== currentGroup) {
      // Cross-group move
      const fileName = node.id.split('/').pop();
      const toPath = targetGroup + '/' + fileName;
      if (toPath !== node.id) {
        const snapPos = hexToPixel(targetCell.q, targetCell.r, HEX_SIZE);
        node.x = snapPos.x; node.y = snapPos.y;
        node.fx = snapPos.x; node.fy = snapPos.y;
        setPendingMove({
          nodeId: node.id, fromPath: node.id, toGroup: targetGroup, toPath,
          snapBack: dragStartRef.current ? { x: dragStartRef.current.x, y: dragStartRef.current.y } : null,
        });
        dragStartRef.current = null;
        return;
      }
    }

    // Same group → snap to cell
    const occupancy = layout?.occupancy;
    const cellKey = `${targetCell.q},${targetCell.r}`;
    const isOccupied = occupancy?.has(cellKey) && occupancy.get(cellKey) !== node.id;

    if (isOccupied) {
      // Cell occupied → snap back to original
      if (dragStartRef.current) {
        node.x = dragStartRef.current.x; node.y = dragStartRef.current.y;
        node.fx = dragStartRef.current.x; node.fy = dragStartRef.current.y;
      }
    } else {
      // Snap to hex cell center
      const snapPos = hexToPixel(targetCell.q, targetCell.r, HEX_SIZE);
      node.x = snapPos.x; node.y = snapPos.y;
      node.fx = snapPos.x; node.fy = snapPos.y;
      node._hexQ = targetCell.q; node._hexR = targetCell.r;

      // Update occupancy
      if (occupancy && dragStartRef.current) {
        const oldKey = `${dragStartRef.current.q},${dragStartRef.current.r}`;
        occupancy.delete(oldKey);
        occupancy.set(cellKey, node.id);
      }
    }

    dragStartRef.current = null;
    if (graphRef.current) graphRef.current.d3ReheatSimulation();
  }, [setPendingMove, setDragOverGroup]);

  // ─── Edge rendering ───
  const showEdges = useGraphStore(s => s.showEdges);

  const linkColor = useCallback((link) => {
    if (!showEdges) return 'rgba(0,0,0,0)';
    const srcId = typeof link.source === 'object' ? link.source.id : link.source;
    const tgtId = typeof link.target === 'object' ? link.target.id : link.target;
    const srcNode = nodes.find(n => n.id === srcId);
    const tgtNode = nodes.find(n => n.id === tgtId);
    if (srcNode?._isFiltered || tgtNode?._isFiltered) return 'rgba(0,0,0,0)';
    const isActive = activeTarget && (srcId === activeTarget || tgtId === activeTarget);
    if (isActive) return getEdgeColor(link, nodes);
    if (activeTarget) return 'rgba(180,140,60,0.05)';
    return getEdgeColor(link, nodes);
  }, [activeTarget, nodes, showEdges]);

  const handleLinkHover = useCallback((link) => {
    setHoveredEdge(link || null);
  }, [setHoveredEdge]);

  const linkCanvasObject = useCallback((link, ctx, globalScale) => {
    if (!hoveredEdge || link !== hoveredEdge) return;
    const src = link.source, tgt = link.target;
    if (!src || !tgt || !isFinite(src.x) || !isFinite(tgt.x)) return;

    const midX = (src.x + tgt.x) / 2, midY = (src.y + tgt.y) / 2;
    const s = 1 / globalScale;
    const label = EDGE_TYPE_LABELS[link.type] || link.type;

    ctx.save();
    const fontSize = 11 * s;
    ctx.font = `500 ${fontSize}px Inter, system-ui, sans-serif`;
    const tw = ctx.measureText(label).width;
    const px = 6 * s, py = 3 * s, r = 4 * s;
    const rx = midX - tw / 2 - px, ry = midY - fontSize / 2 - py;
    const rw = tw + px * 2, rh = fontSize + py * 2;

    ctx.beginPath();
    ctx.roundRect(rx, ry, rw, rh, r);
    ctx.fillStyle = 'rgba(255, 243, 214, 0.95)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(180, 140, 60, 0.3)';
    ctx.lineWidth = 1 * s;
    ctx.stroke();

    ctx.fillStyle = colors.textSecondary;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, midX, midY);
    ctx.restore();
  }, [hoveredEdge]);

  return (
    <div ref={wrapperRef} className="absolute inset-0" style={{ cursor: 'default' }}>
      <ForceGraph2D
        ref={graphRef}
        graphData={graphData}
        nodeId="id"
        linkSource="source"
        linkTarget="target"
        onRenderFramePre={drawBackground}
        nodeCanvasObject={nodeCanvasObject}
        nodePointerAreaPaint={(node, color, ctx, globalScale) => {
          const sc = 1 / globalScale;
          const rad = (node._visualRadius || 40) * sc;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(node.x, node.y, rad, 0, 2 * Math.PI);
          ctx.fill();
        }}
        linkCurvature={0.15}
        linkColor={linkColor}
        linkWidth={link => {
          if (link === hoveredEdge) return 2;
          return link.type === 'shared-tag' ? 0.3 : link.type === 'co-change' ? 1.5 : 0.7;
        }}
        linkLineDash={link => link.type === 'frontmatter-related' ? [5, 5] : link.type === 'shared-tag' ? [2, 5] : null}
        linkDirectionalArrowLength={link => link.type === 'applied-to' ? 5 : 0}
        linkDirectionalArrowRelPos={1}
        linkCanvasObjectMode={() => 'after'}
        linkCanvasObject={linkCanvasObject}
        onNodeClick={handleNodeClick}
        onNodeHover={handleNodeHover}
        onNodeDrag={handleNodeDrag}
        onNodeDragEnd={handleNodeDragEnd}
        onBackgroundClick={handleBackgroundClick}
        onLinkHover={handleLinkHover}
        backgroundColor="transparent"
        cooldownTicks={0}
        warmupTicks={0}
        d3AlphaMin={1}
        enableNodeDrag={true}
        minZoom={0.1}
        maxZoom={6}
      />
    </div>
  );
}
