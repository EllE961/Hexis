/**
 * DockPanel — fully polished dockable panel.
 *
 * Big readable header, wide grab areas, corner docking,
 * visible resize handles, proper window controls.
 */

import React, { useRef } from 'react';
import { usePanelStore } from '../../stores/panelStore.js';
import { W } from '../../theme/window-tokens.js';
import { HeaderButton } from '../window/Window.jsx';
import { Icon } from '../common/Icon.jsx';

const DOCK_SNAP = 60; // bigger snap zone

/** Codicon name pointing toward the dock edge (for the collapse button). */
function collapseCodiconForDock(dock) {
  if (dock === 'left') return 'chevron-left';
  if (dock === 'right') return 'chevron-right';
  if (dock === 'bottom') return 'chevron-down';
  return 'chevron-left';
}

export default function DockPanel({ id, title, icon, children, hideHeader = false }) {
  const panel = usePanelStore(s => s.panels[id]);
  const focused = usePanelStore(s => s.focusedPanel === id);
  const focusPanel = usePanelStore(s => s.focusPanel);
  const hidePanel = usePanelStore(s => s.hidePanel);
  const toggleMaximize = usePanelStore(s => s.toggleMaximize);
  const toggleEdgeCollapse = usePanelStore(s => s.toggleEdgeCollapse);
  const updatePanel = usePanelStore(s => s.updatePanel);
  const dockPanel = usePanelStore(s => s.dockPanel);
  const undockPanel = usePanelStore(s => s.undockPanel);
  const setDockPreview = usePanelStore(s => s.setDockPreview);

  const panelRef = useRef(null);
  const isDragging = useRef(false);

  if (!panel || !panel.visible) return null;

  const isFloating = panel.mode === 'floating';
  const isDocked = panel.mode === 'docked';
  const maximized = !!panel.maximized;

  // ─── Drag ───
  const onHeaderMouseDown = (e) => {
    if (e.target.closest('button')) return;
    e.preventDefault();
    focusPanel(id);
    if (maximized) return;

    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;

    const offX = e.clientX - rect.left;
    const offY = e.clientY - rect.top;
    const sx = e.clientX, sy = e.clientY;
    const wasDocked = isDocked;
    let moved = false, undocked = false;
    isDragging.current = true;

    const onMove = (ev) => {
      if (!moved && Math.abs(ev.clientX - sx) < 4 && Math.abs(ev.clientY - sy) < 4) return;
      moved = true;
      if (wasDocked && !undocked) { undockPanel(id, ev.clientX - offX, ev.clientY - offY); undocked = true; }
      if (panelRef.current) {
        panelRef.current.style.left = `${ev.clientX - offX}px`;
        panelRef.current.style.top = `${ev.clientY - offY}px`;
        panelRef.current.style.position = 'fixed';
        panelRef.current.style.transition = 'none';
      }
      // Snap detection — edges + corners
      const vw = window.innerWidth, vh = window.innerHeight;
      const mx = ev.clientX, my = ev.clientY;
      if (mx < DOCK_SNAP) setDockPreview({ edge: 'left', panelId: id });
      else if (mx > vw - DOCK_SNAP) setDockPreview({ edge: 'right', panelId: id });
      else if (my > vh - DOCK_SNAP - 34) setDockPreview({ edge: 'bottom', panelId: id });
      else setDockPreview(null);
    };

    const onUp = (ev) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      isDragging.current = false;
      const preview = usePanelStore.getState().dockPreview;
      setDockPreview(null);
      if (!moved) return;
      if (panelRef.current) panelRef.current.style.transition = '';
      if (preview) {
        dockPanel(id, preview.edge);
        if (panelRef.current) { panelRef.current.style.position = ''; panelRef.current.style.left = ''; panelRef.current.style.top = ''; }
      } else {
        updatePanel(id, { mode: 'floating', dock: null, x: Math.max(0, ev.clientX - offX), y: Math.max(0, ev.clientY - offY) });
      }
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // ─── Resize ───
  const startResize = (edge, e) => {
    e.preventDefault();
    e.stopPropagation();
    focusPanel(id);

    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sx = e.clientX, sy = e.clientY;
    const sw = panel.width || rect.width, sh = panel.height || rect.height;
    const sl = panel.x || rect.left, st = panel.y || rect.top;
    const minW = panel.minWidth || 200, minH = panel.minHeight || 120;

    const cur = edge.includes('left') || edge.includes('right') ? 'ew-resize' : edge.includes('top') || edge.includes('bottom') ? 'ns-resize' : 'nwse-resize';
    document.body.style.cursor = cur;

    const onMove = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      const u = {};
      if (edge.includes('right')) u.width = Math.max(minW, sw + dx);
      if (edge.includes('left')) { u.width = Math.max(minW, sw - dx); if (isFloating) u.x = sl + (sw - u.width); }
      if (edge.includes('bottom')) u.height = Math.max(minH, sh + dy);
      if (edge.includes('top')) { u.height = Math.max(minH, sh - dy); if (isFloating) u.y = st + (sh - u.height); }
      updatePanel(id, u);
    };
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); document.body.style.cursor = ''; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // ─── Position calc ───
  const fx = panel.x === 'center' ? Math.max(0, (window.innerWidth - (panel.width || 400)) / 2) : (panel.x || 0);
  const fy = panel.y === 'center' ? Math.max(0, (window.innerHeight - (panel.height || 300)) / 2) : (panel.y || 0);

  const style = maximized ? {
    position: 'fixed', left: 0, top: 0,
    width: window.innerWidth, height: window.innerHeight - 34,
    zIndex: W.zPanelFloat + 50,
  } : isFloating ? {
    position: 'fixed', left: fx, top: fy,
    width: panel.width || 400, height: panel.height || 300,
    zIndex: panel.zIndex,
  } : {
    width: panel.dock === 'bottom' ? '100%' : (panel.width || '100%'),
    height: panel.dock === 'bottom' ? (panel.height || 200) : '100%',
    zIndex: panel.zIndex, position: 'relative',
  };

  return (
    <div
      ref={panelRef}
      style={{
        ...style,
        display: 'flex',
        flexDirection: 'column',
        background: W.bg1,
        border: `1px solid ${focused ? W.borderHi : W.border}`,
        borderRadius: isFloating ? W.radius3 : W.radius0,
        boxShadow: isFloating ? W.shadow2 : W.shadow0,
        overflow: 'hidden',
        transition: `border-color ${W.animFast}`,
      }}
      onMouseDown={() => focusPanel(id)}
    >
      {/* ═══ HEADER (hidden when rendered inside a tab group) ═══ */}
      {!hideHeader && (
      <div
        style={{
          flexShrink: 0,
          height: W.dockHeaderHeight,
          display: 'flex',
          alignItems: 'center',
          gap: W.s2,
          padding: `0 ${W.s1}px 0 ${W.s2}px`,
          background: W.bg2,
          borderBottom: `1px solid ${focused ? W.borderHi : W.border}`,
          cursor: maximized ? 'default' : 'grab',
          userSelect: 'none',
          transition: `border-color ${W.animFast}`,
        }}
        onMouseDown={onHeaderMouseDown}
        onDoubleClick={(e) => { if (!e.target.closest('button')) toggleMaximize(id); }}
      >
        {/* Drag grip dots */}
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 2,
          opacity: 0.4, flexShrink: 0,
        }}>
          <div style={{ width: 10, height: 1.5, borderRadius: 1, background: W.textDim }} />
          <div style={{ width: 10, height: 1.5, borderRadius: 1, background: W.textDim }} />
          <div style={{ width: 10, height: 1.5, borderRadius: 1, background: W.textDim }} />
        </div>

        {/* Icon — accepts either a string (legacy) or a React element. Elements
            get cloned with the correct size/color for the header context. */}
        {icon && (
          <span style={{
            color: focused ? W.accent : W.textDim,
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: W.iconMd,
            height: W.iconMd,
          }}>
            {typeof icon === 'string'
              ? icon
              : React.isValidElement(icon)
                ? React.cloneElement(icon, {
                    size: W.iconMd,
                    color: focused ? W.accent : W.textDim,
                  })
                : icon}
          </span>
        )}

        {/* Title — uppercase compact IDE style */}
        <span style={{
          flex: 1,
          minWidth: 0,
          fontSize: W.fontSm,
          fontWeight: W.fontWeightSemi,
          color: W.text,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>{title}</span>

        {/* Window controls — collapse-to-edge + maximize + close */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
          {isDocked && !maximized && (
            <HeaderButton
              icon={<Icon name={collapseCodiconForDock(panel.dock)} size={W.iconSm} />}
              label="Collapse to edge"
              onClick={() => toggleEdgeCollapse(id)}
            />
          )}
          <HeaderButton
            icon={<Icon name={maximized ? 'chrome-restore' : 'chrome-maximize'} size={W.iconSm} />}
            label={maximized ? 'Restore' : 'Maximize'}
            onClick={() => toggleMaximize(id)}
          />
          <HeaderButton
            icon={<Icon name="close" size={W.iconSm} />}
            label="Close"
            onClick={() => hidePanel(id)}
            color={W.textDim}
            hoverColor={W.red}
            hoverBg={W.redBg}
          />
        </div>
      </div>
      )}

      {/* ═══ BODY ═══ */}
      <div className="flex-1 min-h-0 overflow-hidden" style={{ display: 'flex', flexDirection: 'column' }}>
        <PanelErrorBoundary panelId={id} panelTitle={title}>
          {children}
        </PanelErrorBoundary>
      </div>

      {/* ═══ RESIZE HANDLES — wide hit areas (8px), visible amber line on hover ═══ */}
      {!maximized && (
        <>
          {/* Right edge */}
          {(isFloating || panel.dock === 'left') && (
            <div className="absolute top-0 right-0 h-full cursor-ew-resize group" style={{ width: 8, zIndex: 5 }}
              onMouseDown={(e) => startResize('right', e)}>
              <div className="absolute right-0 top-0 h-full w-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150"
                style={{ background: 'rgba(240, 160, 48, 0.7)' }} />
            </div>
          )}
          {/* Left edge */}
          {(isFloating || panel.dock === 'right') && (
            <div className="absolute top-0 left-0 h-full cursor-ew-resize group" style={{ width: 8, zIndex: 5 }}
              onMouseDown={(e) => startResize('left', e)}>
              <div className="absolute left-0 top-0 h-full w-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150"
                style={{ background: 'rgba(240, 160, 48, 0.7)' }} />
            </div>
          )}
          {/* Top edge (for bottom docked) */}
          {(isFloating || panel.dock === 'bottom') && (
            <div className="absolute top-0 left-0 right-0 cursor-ns-resize group" style={{ height: 8, zIndex: 5 }}
              onMouseDown={(e) => startResize('top', e)}>
              <div className="absolute top-0 left-0 right-0 h-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150"
                style={{ background: 'rgba(240, 160, 48, 0.7)' }} />
            </div>
          )}
          {/* Bottom edge (floating only) */}
          {isFloating && (
            <div className="absolute bottom-0 left-0 right-0 cursor-ns-resize group" style={{ height: 8, zIndex: 5 }}
              onMouseDown={(e) => startResize('bottom', e)}>
              <div className="absolute bottom-0 left-0 right-0 h-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150"
                style={{ background: 'rgba(240, 160, 48, 0.7)' }} />
            </div>
          )}
          {/* Corner grips — 16x16 hit areas */}
          {isFloating && (
            <>
              <div className="absolute bottom-0 right-0 cursor-nwse-resize" style={{ width: 16, height: 16, zIndex: 6 }}
                onMouseDown={(e) => startResize('bottom-right', e)}>
                <svg width="10" height="10" viewBox="0 0 10 10" className="absolute bottom-1 right-1 opacity-40">
                  <line x1="9" y1="1" x2="1" y2="9" stroke={W.textGhost} strokeWidth="1.5" />
                  <line x1="9" y1="5" x2="5" y2="9" stroke={W.textGhost} strokeWidth="1.5" />
                </svg>
              </div>
              <div className="absolute top-0 right-0 cursor-nesw-resize" style={{ width: 16, height: 16, zIndex: 6 }}
                onMouseDown={(e) => startResize('top-right', e)} />
              <div className="absolute bottom-0 left-0 cursor-nesw-resize" style={{ width: 16, height: 16, zIndex: 6 }}
                onMouseDown={(e) => startResize('bottom-left', e)} />
              <div className="absolute top-0 left-0 cursor-nwse-resize" style={{ width: 16, height: 16, zIndex: 6 }}
                onMouseDown={(e) => startResize('top-left', e)} />
            </>
          )}
        </>
      )}
    </div>
  );
}

// ─── Per-panel error boundary ───
//
// Wraps every dock panel's body so one crashing panel doesn't take down
// the whole app. Crucial for chat survivability: if the hex grid or
// editor throws, chat must keep working. Shows a compact error card
// with a Reload button that resets the boundary's error state.
class PanelErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error(`[dock panel "${this.props.panelId}" crashed]`, error, info?.componentStack);
  }
  reset = () => this.setState({ error: null });
  render() {
    if (this.state.error) {
      return (
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          gap: 12,
          color: W.textMuted,
          fontFamily: W.fontFamily,
        }}>
          <div style={{
            fontSize: W.fontLg,
            fontWeight: W.fontWeightSemi,
            color: W.red,
          }}>
            {this.props.panelTitle || this.props.panelId} crashed
          </div>
          <div style={{
            fontSize: W.fontSm,
            maxWidth: 360,
            textAlign: 'center',
            color: W.textDim,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}>
            {this.state.error?.message || String(this.state.error)}
          </div>
          <button
            onClick={this.reset}
            style={{
              marginTop: 4,
              padding: `${W.s2}px ${W.s3}px`,
              background: W.bg2,
              border: `1px solid ${W.border}`,
              borderRadius: W.radius1,
              color: W.text,
              fontSize: W.fontMd,
              cursor: 'pointer',
            }}
          >
            Reload panel
          </button>
          <div style={{ fontSize: W.fontSm, color: W.textDim }}>
            Other panels are still working.
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
