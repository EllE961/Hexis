/**
 * DockContainer — dockable panels OVERLAY the hex grid (don't steal its space).
 *
 * The hex grid always fills 100% of the container.
 * Docked panels float over the edges with absolute positioning.
 * Floating panels overlay anywhere.
 *
 * When 2+ panels share a dock zone, they render as TABS — the DockPanel's
 * internal header is hidden (via hideHeader prop) and the tab strip becomes
 * the unified header with drag-to-undock, maximize, and close controls.
 *
 * Corner wrap: bottom dock is inset between left and right dock widths,
 * so left/right reach the full height and no visual overlap occurs.
 */

import React, { cloneElement } from 'react';
import { usePanelStore } from '../../stores/panelStore.js';
import { W } from '../../theme/window-tokens.js';
import { HeaderButton } from '../window/Window.jsx';
import { Icon } from '../common/Icon.jsx';

// Width/height of the narrow edge-collapsed strip
const EDGE_STRIP_SIZE = 32;

const DOCK_SNAP = 60;

export default function DockContainer({ children, panels }) {
  const panelState = usePanelStore(s => s.panels);
  const dockPreview = usePanelStore(s => s.dockPreview);
  const activeTab = usePanelStore(s => s.activeTab);
  const setActiveTab = usePanelStore(s => s.setActiveTab);

  const leftPanels = [];          // expanded left-docked panels
  const rightPanels = [];         // expanded right-docked panels
  const bottomPanels = [];        // expanded bottom-docked panels
  const leftCollapsed = [];       // edge-collapsed panels on left
  const rightCollapsed = [];      // edge-collapsed panels on right
  const bottomCollapsed = [];     // edge-collapsed panels on bottom
  const floatingPanels = [];

  const panelElements = {};
  if (panels) {
    for (const p of (Array.isArray(panels) ? panels : [panels])) {
      if (p?.props?.id) panelElements[p.props.id] = p;
    }
  }

  for (const [id, state] of Object.entries(panelState)) {
    if (!state.visible || !panelElements[id]) continue;
    if (state.maximized) {
      // Maximized panels render as floating (above everything)
      floatingPanels.push({ id, state, el: panelElements[id] });
      continue;
    }
    if (state.mode === 'docked') {
      const entry = { id, state, el: panelElements[id] };
      if (state.edgeCollapsed) {
        if (state.dock === 'left') leftCollapsed.push(entry);
        else if (state.dock === 'right') rightCollapsed.push(entry);
        else if (state.dock === 'bottom') bottomCollapsed.push(entry);
      } else {
        if (state.dock === 'left') leftPanels.push(entry);
        else if (state.dock === 'right') rightPanels.push(entry);
        else if (state.dock === 'bottom') bottomPanels.push(entry);
      }
    } else {
      floatingPanels.push({ id, state, el: panelElements[id] });
    }
  }

  leftPanels.sort((a, b) => a.state.order - b.state.order);
  rightPanels.sort((a, b) => a.state.order - b.state.order);
  bottomPanels.sort((a, b) => a.state.order - b.state.order);
  leftCollapsed.sort((a, b) => a.state.order - b.state.order);
  rightCollapsed.sort((a, b) => a.state.order - b.state.order);
  bottomCollapsed.sort((a, b) => a.state.order - b.state.order);
  floatingPanels.sort((a, b) => a.state.zIndex - b.state.zIndex);

  // Compute total reserved space on each edge
  const leftPanelWidth = leftPanels.length > 0 ? Math.max(...leftPanels.map(p => p.state.width || 400)) : 0;
  const rightPanelWidth = rightPanels.length > 0 ? Math.max(...rightPanels.map(p => p.state.width || 400)) : 0;
  const bottomPanelHeight = bottomPanels.length > 0 ? (bottomPanels[0]?.state?.height || 240) : 0;
  const leftRailWidth = leftCollapsed.length > 0 ? EDGE_STRIP_SIZE : 0;
  const rightRailWidth = rightCollapsed.length > 0 ? EDGE_STRIP_SIZE : 0;
  const bottomRailHeight = bottomCollapsed.length > 0 ? EDGE_STRIP_SIZE : 0;

  // Total width/height reserved on each edge (rail + panel), used so corners line up
  const leftWidth = leftRailWidth + leftPanelWidth;
  const rightWidth = rightRailWidth + rightPanelWidth;
  const bottomHeight = bottomRailHeight + bottomPanelHeight;

  // Find center content (HexCanvas etc.)
  const centerChildren = [];
  const childArray = Array.isArray(children) ? children : [children];
  for (const child of childArray) {
    if (child?.props?.id && panelElements[child.props.id]) continue;
    centerChildren.push(child);
  }

  return (
    <div className="relative w-full h-full" style={{ overflow: 'hidden', background: W.bg0 }}>
      {/* Center content fills 100% — hex grid is always full size */}
      <div className="absolute inset-0">
        {centerChildren}
      </div>

      {/* Left edge rail (collapsed panels) — owns the very left edge */}
      {leftCollapsed.length > 0 && (
        <EdgeRail side="left" panels={leftCollapsed}
          style={{ top: 0, left: 0, height: '100%', width: EDGE_STRIP_SIZE }} />
      )}

      {/* Right edge rail */}
      {rightCollapsed.length > 0 && (
        <EdgeRail side="right" panels={rightCollapsed}
          style={{ top: 0, right: 0, height: '100%', width: EDGE_STRIP_SIZE }} />
      )}

      {/* Bottom edge rail */}
      {bottomCollapsed.length > 0 && (
        <EdgeRail side="bottom" panels={bottomCollapsed}
          style={{ bottom: 0, left: leftWidth, right: rightWidth, height: EDGE_STRIP_SIZE }} />
      )}

      {/* Left dock — shifted right by the rail width */}
      {leftPanels.length > 0 && (
        <DockZone
          zone="left"
          panels={leftPanels}
          activeTab={activeTab.left}
          setActiveTab={(id) => setActiveTab('left', id)}
          style={{ top: 0, left: leftRailWidth, height: '100%', width: leftPanelWidth }}
        />
      )}

      {/* Right dock — shifted left by the rail width */}
      {rightPanels.length > 0 && (
        <DockZone
          zone="right"
          panels={rightPanels}
          activeTab={activeTab.right}
          setActiveTab={(id) => setActiveTab('right', id)}
          style={{ top: 0, right: rightRailWidth, height: '100%', width: rightPanelWidth }}
        />
      )}

      {/* Bottom dock — sits BETWEEN left and right reserved widths (rail + panel) */}
      {bottomPanels.length > 0 && (
        <DockZone
          zone="bottom"
          panels={bottomPanels}
          activeTab={activeTab.bottom}
          setActiveTab={(id) => setActiveTab('bottom', id)}
          style={{
            bottom: bottomRailHeight, left: leftWidth, right: rightWidth,
            height: bottomPanelHeight,
          }}
        />
      )}

      {/* Floating panels (including maximized) */}
      {floatingPanels.map(p => (
        <div key={p.id}>{p.el}</div>
      ))}

      {/* Dock preview overlay */}
      {dockPreview && (
        <div className="absolute inset-0 pointer-events-none" style={{ zIndex: W.zDropZone }}>
          {dockPreview.edge === 'left' && (
            <DropPreview
              style={{ top: 0, left: 0, height: '100%', width: leftPanels.length > 0 ? leftWidth : 320 }}
              side="left"
              willTab={leftPanels.length > 0}
              count={leftPanels.length}
            />
          )}
          {dockPreview.edge === 'right' && (
            <DropPreview
              style={{ top: 0, right: 0, height: '100%', width: rightPanels.length > 0 ? rightWidth : 320 }}
              side="right"
              willTab={rightPanels.length > 0}
              count={rightPanels.length}
            />
          )}
          {dockPreview.edge === 'bottom' && (
            <DropPreview
              style={{
                bottom: 0, left: leftWidth, right: rightWidth,
                height: bottomPanels.length > 0 ? bottomHeight : 220,
              }}
              side="bottom"
              willTab={bottomPanels.length > 0}
              count={bottomPanels.length}
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * DropPreview — highlighted overlay shown while dragging a panel over a dock zone.
 * Shows a "+tab" badge when dropping into an occupied zone (will become a tab).
 */
function DropPreview({ style, side, willTab, count }) {
  const borderKey = side === 'left' ? 'borderRight' : side === 'right' ? 'borderLeft' : 'borderTop';
  return (
    <div className="absolute" style={{
      ...style,
      background: W.accentBg,
      [borderKey]: `2px solid ${W.accent}`,
      boxShadow: `inset 0 0 24px -6px ${W.accentSoft}`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}>
      <div style={{
        padding: `${W.s2}px ${W.s3}px`,
        background: W.bg2,
        border: `1px solid ${W.borderHi}`,
        borderRadius: W.radius2,
        boxShadow: W.shadow2,
        display: 'flex',
        alignItems: 'center',
        gap: W.s2,
        color: W.text,
        fontSize: W.fontMd,
        fontWeight: W.fontWeightSemi,
      }}>
        <Icon name={willTab ? 'add' : 'layout'} size={W.iconMd} color={W.accent} />
        <span>
          {willTab
            ? `Add as tab (${count + 1} total)`
            : `Dock ${side}`}
        </span>
      </div>
    </div>
  );
}

/**
 * EdgeRail — a narrow strip on a dock edge holding icon-only buttons
 * for edge-collapsed panels. Clicking a button expands that panel back.
 */
function EdgeRail({ side, panels, style }) {
  const toggleEdgeCollapse = usePanelStore(s => s.toggleEdgeCollapse);
  const focusPanel = usePanelStore(s => s.focusPanel);
  const isHorizontal = side === 'bottom';
  return (
    <div
      className="absolute"
      style={{
        ...style,
        zIndex: W.zPanelDocked + 1,
        background: W.bg2,
        borderRight: side === 'left' ? `1px solid ${W.border}` : undefined,
        borderLeft: side === 'right' ? `1px solid ${W.border}` : undefined,
        borderTop: side === 'bottom' ? `1px solid ${W.border}` : undefined,
        display: 'flex',
        flexDirection: isHorizontal ? 'row' : 'column',
        alignItems: 'center',
        padding: W.s1,
        gap: W.s1,
      }}
    >
      {panels.map(p => {
        const icon = p.el?.props?.icon;
        const title = p.el?.props?.title || p.id;
        return (
          <button
            key={p.id}
            title={`Expand ${title}`}
            onClick={() => { toggleEdgeCollapse(p.id); focusPanel(p.id); }}
            style={{
              width: isHorizontal ? 'auto' : EDGE_STRIP_SIZE - W.s1 * 2,
              height: isHorizontal ? EDGE_STRIP_SIZE - W.s1 * 2 : 'auto',
              minHeight: 28,
              padding: isHorizontal ? `0 ${W.s3}px` : `${W.s2}px 0`,
              border: `1px solid ${W.border}`,
              background: W.bg1,
              color: W.textDim,
              borderRadius: W.radius1,
              cursor: 'pointer',
              display: 'flex',
              flexDirection: isHorizontal ? 'row' : 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 4,
              fontSize: W.fontMd,
              fontWeight: W.fontWeightMed,
              transition: `all ${W.animFast}`,
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = W.bg3;
              e.currentTarget.style.color = W.accent;
              e.currentTarget.style.borderColor = W.borderHi;
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = W.bg1;
              e.currentTarget.style.color = W.textDim;
              e.currentTarget.style.borderColor = W.border;
            }}
          >
            {icon && (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: W.iconMd,
                height: W.iconMd,
              }}>
                {typeof icon === 'string'
                  ? icon
                  : React.isValidElement(icon)
                    ? React.cloneElement(icon, { size: W.iconMd })
                    : icon}
              </span>
            )}
            {/* For horizontal rail (bottom), also show title next to icon */}
            {isHorizontal && <span>{title}</span>}
            {/* Expand arrow pointing INTO the viewport */}
            <Icon
              name={side === 'left' ? 'chevron-right' : side === 'right' ? 'chevron-left' : 'chevron-up'}
              size={W.iconSm}
              style={{ opacity: 0.7 }}
            />
          </button>
        );
      })}
    </div>
  );
}

/**
 * DockZone — renders one or more panels in a single zone.
 *
 * Single panel → render the panel with its own header (normal DockPanel chrome).
 * Multiple panels → render a unified TabBar that acts as the shared header
 *                   (title/icon per tab, draggable tabs, active-panel controls),
 *                   and hide each inner DockPanel header via hideHeader prop.
 */
function DockZone({ zone, panels, activeTab, setActiveTab, style }) {
  const hasMultiple = panels.length > 1;
  const validActive = activeTab && panels.find(p => p.id === activeTab) ? activeTab : panels[0]?.id;

  // Single panel — render directly with its own header (full DockPanel chrome)
  if (!hasMultiple) {
    return (
      <div className="absolute" style={{ ...style, zIndex: W.zPanelDocked, display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>{panels[0].el}</div>
      </div>
    );
  }

  // Multi-panel — tab bar replaces inner DockPanel headers
  return (
    <div className="absolute" style={{
      ...style,
      zIndex: W.zPanelDocked,
      display: 'flex',
      flexDirection: 'column',
      background: W.bg1,
      border: `1px solid ${W.border}`,
    }}>
      <TabBar
        zone={zone}
        panels={panels}
        activeId={validActive}
        setActiveTab={setActiveTab}
      />
      {/* Panel content — active only visible, others mounted but display: none */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {panels.map(p => (
          <div
            key={p.id}
            style={{
              position: 'absolute',
              inset: 0,
              display: p.id === validActive ? 'flex' : 'none',
              flexDirection: 'column',
            }}
          >
            {/* Hide the inner DockPanel header — tab bar is the header */}
            {cloneElement(p.el, { hideHeader: true })}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * TabBar — unified header for a multi-panel dock zone.
 *
 * Features:
 *   - Click tab to activate
 *   - Drag tab to undock (>6px movement starts drag; on drop, docks to nearest edge or floats)
 *   - Active tab shows accent underline
 *   - Right side shows maximize + close for the active panel
 */
function TabBar({ zone, panels, activeId, setActiveTab }) {
  const focusPanel = usePanelStore(s => s.focusPanel);
  const hidePanel = usePanelStore(s => s.hidePanel);
  const toggleMaximize = usePanelStore(s => s.toggleMaximize);
  const toggleEdgeCollapse = usePanelStore(s => s.toggleEdgeCollapse);
  const undockPanel = usePanelStore(s => s.undockPanel);
  const dockPanel = usePanelStore(s => s.dockPanel);
  const setDockPreview = usePanelStore(s => s.setDockPreview);

  // Collapse icon points toward the dock edge for this zone
  const collapseCodicon = zone === 'left' ? 'chevron-left' : zone === 'right' ? 'chevron-right' : 'chevron-down';

  const startTabDrag = (panelId, e) => {
    if (e.target.closest('button[data-tab-control]')) return;
    e.preventDefault();
    // Always activate on mousedown
    setActiveTab(panelId);
    focusPanel(panelId);

    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    let undocked = false;

    const onMove = (ev) => {
      if (!moved && Math.abs(ev.clientX - sx) < 6 && Math.abs(ev.clientY - sy) < 6) return;
      moved = true;
      if (!undocked) {
        // Undock immediately — panel becomes floating at mouse position
        undockPanel(panelId, ev.clientX - 100, ev.clientY - 16);
        undocked = true;
      }
      // Snap detection — edges
      const vw = window.innerWidth, vh = window.innerHeight;
      const mx = ev.clientX, my = ev.clientY;
      if (mx < DOCK_SNAP) setDockPreview({ edge: 'left', panelId });
      else if (mx > vw - DOCK_SNAP) setDockPreview({ edge: 'right', panelId });
      else if (my > vh - DOCK_SNAP - 34) setDockPreview({ edge: 'bottom', panelId });
      else setDockPreview(null);
    };

    const onUp = (ev) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const preview = usePanelStore.getState().dockPreview;
      setDockPreview(null);
      if (!moved) return; // pure click — already activated
      if (preview) {
        dockPanel(panelId, preview.edge);
      } else {
        // Leave floating at release position
        usePanelStore.getState().updatePanel(panelId, {
          mode: 'floating', dock: null,
          x: Math.max(0, ev.clientX - 100),
          y: Math.max(0, ev.clientY - 16),
        });
      }
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const activePanel = panels.find(p => p.id === activeId);

  return (
    <div style={{
      flexShrink: 0,
      display: 'flex',
      alignItems: 'stretch',
      background: W.bg2,
      borderBottom: `1px solid ${W.border}`,
      height: W.headerHeight,
      userSelect: 'none',
    }}>
      {/* Scrollable tab row */}
      <div style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        alignItems: 'stretch',
        overflowX: 'auto',
        overflowY: 'hidden',
      }}>
        {panels.map(p => {
          const isActive = p.id === activeId;
          const title = p.el?.props?.title || p.id;
          const icon = p.el?.props?.icon;
          return (
            <div
              key={p.id}
              onMouseDown={(e) => startTabDrag(p.id, e)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: W.s2,
                padding: `0 ${W.s3}px`,
                height: '100%',
                borderRight: `1px solid ${W.border}`,
                background: isActive ? W.bg1 : 'transparent',
                color: isActive ? W.text : W.textDim,
                fontSize: W.fontMd,
                fontWeight: isActive ? W.fontWeightSemi : W.fontWeightMed,
                cursor: 'grab',
                position: 'relative',
                transition: `background ${W.animFast}, color ${W.animFast}`,
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
              onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = W.bg3; }}
              onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
            >
              {icon && (
                <span style={{
                  color: isActive ? W.accent : W.textDim,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: W.icon,
                  height: W.icon,
                }}>
                  {typeof icon === 'string'
                    ? icon
                    : React.isValidElement(icon)
                      ? React.cloneElement(icon, { size: W.icon, color: isActive ? W.accent : W.textDim })
                      : icon}
                </span>
              )}
              <span>{title}</span>
              {/* Per-tab close button */}
              <button
                data-tab-control
                title="Close"
                onClick={(e) => { e.stopPropagation(); hidePanel(p.id); }}
                style={{
                  marginLeft: W.s1,
                  width: 18,
                  height: 18,
                  border: 'none',
                  background: 'transparent',
                  color: W.textMuted,
                  cursor: 'pointer',
                  borderRadius: W.radius1,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 0,
                }}
                onMouseEnter={e => { e.currentTarget.style.background = W.redBg; e.currentTarget.style.color = W.red; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = W.textMuted; }}
              >
                <Icon name="close" size={W.iconSm} />
              </button>
              {/* Active indicator line */}
              {isActive && (
                <span style={{
                  position: 'absolute',
                  bottom: 0,
                  left: 0,
                  right: 0,
                  height: 2,
                  background: W.accent,
                }} />
              )}
            </div>
          );
        })}
      </div>

      {/* Active-tab window controls (right side) */}
      {activePanel && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 0, padding: `0 ${W.s1}px`, borderLeft: `1px solid ${W.border}`, flexShrink: 0 }}>
          <HeaderButton
            icon={<Icon name={collapseCodicon} size={W.iconSm} />}
            label="Collapse active tab to edge"
            onClick={() => toggleEdgeCollapse(activePanel.id)}
          />
          <HeaderButton
            icon={<Icon name="chrome-maximize" size={W.iconSm} />}
            label="Maximize"
            onClick={() => toggleMaximize(activePanel.id)}
          />
        </div>
      )}
    </div>
  );
}
