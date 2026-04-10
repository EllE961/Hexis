import { useState, useRef, useEffect, useCallback } from 'react';
import { useGraphStore } from '../../hooks/useGraph.js';
import { getSectionColor } from '../../utils/colors.js';

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function flattenGroups(cached) {
  const flat = [];
  for (const [key, g] of Object.entries(cached)) {
    flat.push({ key, ...g });
    if (g.children) {
      for (const [childKey, child] of Object.entries(g.children)) {
        flat.push({ key: childKey, ...child });
      }
    }
  }
  flat.sort((a, b) => (a.depth || 0) - (b.depth || 0));
  return flat;
}

export default function GroupOverlay({ graphRef, cachedGroupsRef }) {
  const [allGroups, setAllGroups] = useState([]);
  const [hoveredGroup, setHoveredGroup] = useState(null);
  const [dragging, setDragging] = useState(null);
  const groupRefs = useRef({});
  const countRefs = useRef({});
  const prevKeysRef = useRef('');
  const dragStart = useRef(null);
  const didDrag = useRef(false);
  const setSelectedGroup = useGraphStore(s => s.setSelectedGroup);
  const setSelectedNode = useGraphStore(s => s.setSelectedNode);
  const selectedGroup = useGraphStore(s => s.selectedGroup);
  const dragOverGroup = useGraphStore(s => s.dragOverGroup);
  const setGroupMinSize = useGraphStore(s => s.setGroupMinSize);
  const resizeRef = useRef(null); // { key, startX, startY, startW, startH }

  // Resize handle drag — uses screen delta converted to graph delta
  const handleResizeStart = useCallback((e, groupKey) => {
    e.preventDefault();
    e.stopPropagation();
    const fg = graphRef.current;
    if (!fg) return;

    // Get current group dimensions in graph space
    const cached = cachedGroupsRef.current;
    let bbox = cached[groupKey];
    if (!bbox) {
      for (const k in cached) {
        if (cached[k].children?.[groupKey]) { bbox = cached[k].children[groupKey]; break; }
      }
    }
    if (!bbox) return;

    const startW = bbox.maxX - bbox.minX;
    const startH = bbox.maxY - bbox.minY;
    const startMouse = { x: e.clientX, y: e.clientY };

    // Compute minimum size from node positions — can't shrink smaller than this
    const groupNodes = bbox.nodes || [];
    let nodeMinX = Infinity, nodeMaxX = -Infinity, nodeMinY = Infinity, nodeMaxY = -Infinity;
    const pad = 80; // padding around nodes
    for (const n of groupNodes) {
      if (!isFinite(n.x) || !isFinite(n.y)) continue;
      nodeMinX = Math.min(nodeMinX, n.x);
      nodeMaxX = Math.max(nodeMaxX, n.x);
      nodeMinY = Math.min(nodeMinY, n.y);
      nodeMaxY = Math.max(nodeMaxY, n.y);
    }
    const floorW = isFinite(nodeMinX) ? (nodeMaxX - nodeMinX) + pad * 2 : 150;
    const floorH = isFinite(nodeMinY) ? (nodeMaxY - nodeMinY) + pad * 2 : 100;

    resizeRef.current = { key: groupKey, startW, startH, startMouse, floorW, floorH };

    const onMove = (ev) => {
      if (!resizeRef.current || !graphRef.current) return;
      const fg = graphRef.current;
      const startG = fg.screen2GraphCoords(resizeRef.current.startMouse.x, resizeRef.current.startMouse.y);
      const curG = fg.screen2GraphCoords(ev.clientX, ev.clientY);
      const dw = curG.x - startG.x;
      const dh = curG.y - startG.y;
      // Clamp to floor size so nodes never overflow
      const newW = Math.max(resizeRef.current.floorW, resizeRef.current.startW + dw);
      const newH = Math.max(resizeRef.current.floorH, resizeRef.current.startH + dh);
      setGroupMinSize(resizeRef.current.key, newW, newH, undefined, undefined);
      fg.d3ReheatSimulation();
    };

    const onUp = () => {
      resizeRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [graphRef, cachedGroupsRef, setGroupMinSize]);

  // Position sync
  useEffect(() => {
    let animId;
    const update = () => {
      const fg = graphRef.current;
      const cached = cachedGroupsRef.current;
      if (!fg || !cached || !fg.graph2ScreenCoords) {
        animId = requestAnimationFrame(update);
        return;
      }

      const flat = flattenGroups(cached);
      const keys = flat.map(g => g.key).sort().join(',');
      if (keys !== prevKeysRef.current) {
        prevKeysRef.current = keys;
        setAllGroups(flat);
      }

      for (const g of flat) {
        const el = groupRefs.current[g.key];
        if (!el) continue;
        const tl = fg.graph2ScreenCoords(g.minX, g.minY);
        const br = fg.graph2ScreenCoords(g.maxX, g.maxY);
        if (!isFinite(tl.x) || !isFinite(tl.y) || br.x - tl.x < 20 || br.y - tl.y < 20) {
          el.style.display = 'none';
          continue;
        }
        el.style.display = '';
        el.style.left = `${tl.x}px`;
        el.style.top = `${tl.y}px`;
        el.style.width = `${br.x - tl.x}px`;
        el.style.height = `${br.y - tl.y}px`;

        const countEl = countRefs.current[g.key];
        if (countEl) countEl.textContent = String(g.nodes?.length || 0);
      }

      animId = requestAnimationFrame(update);
    };
    animId = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animId);
  }, [graphRef, cachedGroupsRef]);

  // Label drag/click — labels are the ONLY interactive elements
  const handleLabelDown = useCallback((e, groupKey) => {
    e.preventDefault();
    e.stopPropagation();
    const fg = graphRef.current;
    if (!fg) return;

    // Get LIVE nodes from the cache (not stale React state)
    const cached = cachedGroupsRef.current;
    let groupNodes = null;
    for (const key in cached) {
      if (key === groupKey) { groupNodes = cached[key].nodes; break; }
      if (cached[key].children?.[groupKey]) { groupNodes = cached[key].children[groupKey].nodes; break; }
    }
    if (!groupNodes?.length) return;

    // Disable cluster force during drag
    const origCluster = fg.d3Force('cluster');
    fg.d3Force('cluster', null);

    const startPos = fg.screen2GraphCoords(e.clientX, e.clientY);
    dragStart.current = { key: groupKey, nodes: groupNodes, lastX: startPos.x, lastY: startPos.y };
    didDrag.current = false;
    setDragging(groupKey);

    const onMove = (ev) => {
      const fg = graphRef.current;
      if (!dragStart.current || !fg) return;
      didDrag.current = true;
      const pos = fg.screen2GraphCoords(ev.clientX, ev.clientY);
      const dx = pos.x - dragStart.current.lastX;
      const dy = pos.y - dragStart.current.lastY;
      // Move all nodes in the group
      for (const n of dragStart.current.nodes) {
        n.x += dx; n.y += dy; n.fx = n.x; n.fy = n.y;
      }
      // Also move the frozen origin so the group border follows
      const mins = useGraphStore.getState().groupMinSizes;
      const m = mins[dragStart.current.key];
      if (m && m.originX != null) {
        setGroupMinSize(dragStart.current.key, m.minW, m.minH, m.originX + dx, m.originY + dy);
      }
      // Also move child sub-group origins
      const cached = cachedGroupsRef.current;
      const parentGroup = cached[dragStart.current.key];
      if (parentGroup?.children) {
        for (const ck in parentGroup.children) {
          const cm = mins[ck];
          if (cm && cm.originX != null) {
            setGroupMinSize(ck, cm.minW, cm.minH, cm.originX + dx, cm.originY + dy);
          }
        }
      }
      dragStart.current.lastX = pos.x;
      dragStart.current.lastY = pos.y;
      fg.d3ReheatSimulation();
    };

    const onUp = () => {
      const fg = graphRef.current;
      if (fg && origCluster) fg.d3Force('cluster', origCluster);

      if (!didDrag.current) {
        setSelectedGroup(groupKey);
        setSelectedNode(null);
      }
      dragStart.current = null;
      setDragging(null);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [graphRef, setSelectedGroup, setSelectedNode, setGroupMinSize]);

  return (
    <div className="absolute inset-0 pointer-events-none z-20">
      {allGroups.map((g) => {
        const depth = g.depth || 0;
        const color = getSectionColor(g.section);
        const isActive = selectedGroup === g.key;
        const isHovered = hoveredGroup === g.key;
        const isDragging = dragging === g.key;
        const isDropTarget = dragOverGroup === g.key;

        // Border is now drawn on canvas as hex — HTML div is just for positioning label + handle

        const labelText = capitalize(g.label || g.key.split('/').pop());
        const isTopLevel = depth === 0;

        return (
          <div
            key={g.key}
            ref={(el) => { groupRefs.current[g.key] = el; }}
            className="absolute"
            style={{
              pointerEvents: 'none',
              // No border or background — hex border drawn on canvas
            }}
          >
            {/* ═══ LABEL — the drag handle. Big, visible, clearly interactive ═══ */}
            <div
              className="absolute flex items-center"
              style={{
                pointerEvents: 'auto',
                top: isTopLevel ? -16 : -12,
                left: isTopLevel ? 10 : 6,
                cursor: isDragging ? 'grabbing' : 'grab',
                padding: isTopLevel ? '5px 12px' : '3px 10px',
                borderRadius: 8,
                background: isActive || isHovered
                  ? `${color}30`
                  : `${color}${isTopLevel ? '18' : '10'}`,
                border: `1px solid ${isActive || isHovered
                  ? `${color}50`
                  : `${color}${isTopLevel ? '25' : '18'}`}`,
                transition: 'all 150ms ease',
                fontSize: isTopLevel ? 14 : 12,
                fontWeight: isTopLevel ? 700 : 600,
                fontFamily: 'Inter, system-ui, sans-serif',
                color: isActive || isHovered ? color : `${color}${isTopLevel ? 'DD' : 'AA'}`,
                whiteSpace: 'nowrap',
                userSelect: 'none',
                gap: 6,
                letterSpacing: isTopLevel ? '-0.01em' : '0',
              }}
              onPointerDown={(e) => handleLabelDown(e, g.key)}
              onMouseEnter={() => setHoveredGroup(g.key)}
              onMouseLeave={() => setHoveredGroup(null)}
            >
              {/* Drag handle icon */}
              <svg width={isTopLevel ? 14 : 12} height={isTopLevel ? 14 : 12} viewBox="0 0 16 16" fill="currentColor" opacity="0.4">
                <circle cx="5" cy="4" r="1.5"/>
                <circle cx="11" cy="4" r="1.5"/>
                <circle cx="5" cy="8" r="1.5"/>
                <circle cx="11" cy="8" r="1.5"/>
                <circle cx="5" cy="12" r="1.5"/>
                <circle cx="11" cy="12" r="1.5"/>
              </svg>
              <span>{labelText}</span>
              <span
                ref={(el) => { countRefs.current[g.key] = el; }}
                style={{ opacity: 0.4, fontWeight: 400, fontSize: isTopLevel ? 12 : 10 }}
              />
            </div>

            {/* ═══ RESIZE HANDLE — bottom-right corner ═══ */}
            {isTopLevel && (
              <div
                className="absolute"
                style={{
                  pointerEvents: 'auto',
                  right: -4,
                  bottom: -4,
                  width: 18,
                  height: 18,
                  cursor: 'nwse-resize',
                  borderRadius: 4,
                  background: isHovered || isActive ? `${color}25` : `${color}10`,
                  border: `1.5px solid ${isHovered || isActive ? `${color}50` : `${color}20`}`,
                  transition: 'all 150ms ease',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                onPointerDown={(e) => handleResizeStart(e, g.key)}
                onMouseEnter={e => { e.currentTarget.style.background = `${color}40`; e.currentTarget.style.borderColor = `${color}70`; }}
                onMouseLeave={e => { e.currentTarget.style.background = isHovered || isActive ? `${color}25` : `${color}10`; e.currentTarget.style.borderColor = isHovered || isActive ? `${color}50` : `${color}20`; }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10">
                  <path d="M9 1L1 9M9 4L4 9M9 7L7 9" stroke={color} strokeWidth="1.5" strokeLinecap="round" opacity="0.6" />
                </svg>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
