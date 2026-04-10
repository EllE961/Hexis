/**
 * ContextMenu — portal-rendered right-click menu.
 *
 * Data-driven API matching MenuBar's dropdowns. Items can have:
 *   - id, label, shortcut, icon, enabled, checked, destructive, submenu, separator
 *
 * Mounts at document.body via a React portal. Closed on:
 *   - Outside click (mousedown)
 *   - Escape key
 *   - Action click (unless the item has a submenu, in which case it
 *     navigates into the submenu)
 *
 * Keyboard nav:
 *   - ArrowUp/Down → next/prev enabled item
 *   - ArrowRight → enter submenu
 *   - ArrowLeft → back out of submenu
 *   - Enter → activate
 *   - Escape → close (or exit submenu)
 *
 * Positioning:
 *   - Given (x, y), mounts the menu at that point
 *   - If the menu would overflow the viewport, flips to the other side
 */

import { useState, useEffect, useRef, useLayoutEffect, memo } from 'react';
import { createPortal } from 'react-dom';
import { W } from '../../theme/window-tokens.js';

const MIN_WIDTH = 220;

function ContextMenuImpl({ x, y, items, onClose, onAction }) {
  const rootRef = useRef(null);
  const [adjusted, setAdjusted] = useState({ x, y });

  // Adjust position so the menu stays in the viewport
  useLayoutEffect(() => {
    if (!rootRef.current) return;
    const rect = rootRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let nx = x;
    let ny = y;
    if (nx + rect.width > vw - 4) nx = Math.max(4, vw - rect.width - 4);
    if (ny + rect.height > vh - 4) ny = Math.max(4, vh - rect.height - 4);
    if (nx !== adjusted.x || ny !== adjusted.y) setAdjusted({ x: nx, y: ny });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y, items]);

  // Outside click + Escape
  useEffect(() => {
    const onMouseDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        onClose();
      }
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    // Defer so the opening click doesn't immediately close
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onMouseDown);
    }, 0);
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={rootRef}
      style={{
        position: 'fixed',
        top: adjusted.y,
        left: adjusted.x,
        zIndex: 10000,
        minWidth: MIN_WIDTH,
      }}
    >
      <ContextMenuPane items={items} onAction={onAction} onClose={onClose} />
    </div>,
    document.body,
  );
}

export const ContextMenu = memo(ContextMenuImpl);

// ─────────────────────────────────────────────────────────────────────
// Pane — the list body of a menu or submenu
// ─────────────────────────────────────────────────────────────────────

function ContextMenuPane({ items, onAction, onClose }) {
  const [hoverIndex, setHoverIndex] = useState(-1);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHoverIndex((i) => nextEnabled(items, i, 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHoverIndex((i) => nextEnabled(items, i, -1));
      } else if (e.key === 'Enter' && hoverIndex >= 0) {
        e.preventDefault();
        const it = items[hoverIndex];
        if (it?.id && !it.submenu) {
          onAction(it.id);
          onClose();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hoverIndex, items, onAction, onClose]);

  return (
    <div
      style={{
        background: W.bg1,
        border: `1px solid ${W.border}`,
        borderRadius: W.radius2,
        boxShadow: W.shadow2,
        padding: 4,
        fontSize: 13,
        minWidth: MIN_WIDTH,
        userSelect: 'none',
      }}
    >
      {items.map((item, i) => {
        if (item.separator) {
          return (
            <div
              key={`sep-${i}`}
              style={{ height: 1, background: W.borderSubtle, margin: '4px 6px' }}
            />
          );
        }
        return (
          <ContextMenuItem
            key={item.id || item.label}
            item={item}
            active={i === hoverIndex}
            onHover={() => setHoverIndex(i)}
            onAction={(id) => { onAction(id); onClose(); }}
          />
        );
      })}
    </div>
  );
}

function nextEnabled(items, from, dir) {
  let i = from;
  for (let step = 0; step < items.length; step++) {
    i = (i + dir + items.length) % items.length;
    const it = items[i];
    if (!it.separator && it.enabled !== false) return i;
  }
  return from;
}

// ─────────────────────────────────────────────────────────────────────
// ContextMenuItem — one row with optional submenu
// ─────────────────────────────────────────────────────────────────────

function ContextMenuItem({ item, active, onHover, onAction }) {
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const hasSubmenu = item.submenu && item.submenu.length > 0;
  const disabled = item.enabled === false;
  const rowRef = useRef(null);

  const handleClick = () => {
    if (disabled) return;
    if (hasSubmenu) {
      setSubmenuOpen((o) => !o);
      return;
    }
    if (item.id) onAction(item.id);
  };

  const handleMouseEnter = () => {
    onHover?.();
    if (hasSubmenu) setSubmenuOpen(true);
  };

  const handleMouseLeave = () => {
    if (hasSubmenu) {
      // Small delay so diagonal cursor motion into the submenu doesn't close it
      setTimeout(() => setSubmenuOpen(false), 180);
    }
  };

  return (
    <div
      ref={rowRef}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '5px 10px 5px 24px',
        color: disabled
          ? W.textGhost
          : item.destructive
          ? W.red
          : W.text,
        background: active && !disabled ? W.accentBg : 'transparent',
        borderRadius: 3,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {/* Check indicator */}
      {item.checked && (
        <span
          style={{
            position: 'absolute',
            left: 6,
            top: '50%',
            transform: 'translateY(-50%)',
            color: W.accent,
            fontSize: 11,
          }}
        >
          ✓
        </span>
      )}
      {/* Icon */}
      {item.icon && (
        <span
          style={{
            width: 14,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: disabled ? W.textGhost : item.destructive ? W.red : W.textDim,
            fontSize: 12,
          }}
        >
          {item.icon}
        </span>
      )}
      {/* Label */}
      <span style={{ flex: 1, whiteSpace: 'nowrap' }}>{item.label}</span>
      {/* Shortcut hint */}
      {item.shortcut && !hasSubmenu && (
        <span
          style={{
            color: W.textGhost,
            fontSize: 11,
            fontFamily: '"JetBrains Mono", monospace',
            marginLeft: 12,
          }}
        >
          {item.shortcut}
        </span>
      )}
      {/* Submenu arrow */}
      {hasSubmenu && <span style={{ color: W.textDim, fontSize: 10 }}>▸</span>}

      {/* Submenu pane */}
      {submenuOpen && hasSubmenu && (
        <div
          style={{
            position: 'absolute',
            top: -4,
            left: '100%',
            marginLeft: 2,
            zIndex: 1,
          }}
        >
          <ContextMenuPane
            items={item.submenu}
            onAction={onAction}
            onClose={() => setSubmenuOpen(false)}
          />
        </div>
      )}
    </div>
  );
}
