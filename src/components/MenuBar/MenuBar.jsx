/**
 * MenuBar — native-looking horizontal menu bar for Hexis.
 *
 * Matches the look of VS Code / Cursor / Zed on Windows: a strip below
 * the title bar with top-level menus (File, Edit, View, Go, Run, AI,
 * Help). Each menu opens a floating dropdown with items, shortcuts,
 * separators, and nested submenus.
 *
 * Design:
 *   - Structure is a PURE DATA TREE passed as `menus` — no JSX coupling.
 *     This keeps the menu definition in one place and lets us memoize
 *     the whole thing so the bar doesn't re-render on unrelated state
 *     changes.
 *   - Dropdowns are LAZY-MOUNTED — closed menus render nothing at all,
 *     so 7 closed menus cost zero DOM nodes.
 *   - Keyboard nav: Alt+<letter> opens a menu (mnemonic), ArrowLeft/Right
 *     cycles menus while one is open, ArrowUp/Down moves inside a menu,
 *     Enter triggers, Escape closes.
 *   - All menu actions are dispatched through a single `onAction` prop;
 *     the parent routes action IDs to their implementations. This means
 *     the menu bar is completely reusable and has no store dependencies.
 *
 * Menu item shape:
 *   { id: 'file:openFolder', label: 'Open Folder…', shortcut: 'Ctrl+O',
 *     mnemonic: 'O', enabled: true, checked: false, submenu: [...] }
 *   { separator: true }
 */

import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { W } from '../../theme/window-tokens.js';

// ═════════════════════════════════════════════════════════════════════
// MenuBar — the top-level horizontal strip
// ═════════════════════════════════════════════════════════════════════

function MenuBarImpl({ menus, onAction }) {
  // `openIndex` = which top-level menu is currently open, or -1 for none
  const [openIndex, setOpenIndex] = useState(-1);
  const barRef = useRef(null);

  // Close on any outside click
  useEffect(() => {
    if (openIndex === -1) return;
    const onClick = (e) => {
      if (barRef.current && !barRef.current.contains(e.target)) {
        setOpenIndex(-1);
      }
    };
    // Defer to next tick so the click that opened us doesn't immediately close
    const id = setTimeout(() => {
      document.addEventListener('mousedown', onClick);
    }, 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener('mousedown', onClick);
    };
  }, [openIndex]);

  // Alt+<letter> mnemonic — opens the menu whose first letter matches.
  // Also: ArrowLeft/Right cycles while open, Escape closes.
  useEffect(() => {
    const onKey = (e) => {
      // Alt+letter = menu mnemonic (only when no menu open)
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && openIndex === -1 && e.key.length === 1) {
        const letter = e.key.toLowerCase();
        const idx = menus.findIndex((m) => m.label[0].toLowerCase() === letter);
        if (idx !== -1) {
          e.preventDefault();
          setOpenIndex(idx);
        }
        return;
      }
      if (openIndex === -1) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpenIndex(-1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setOpenIndex((i) => (i - 1 + menus.length) % menus.length);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setOpenIndex((i) => (i + 1) % menus.length);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openIndex, menus]);

  const handleTopClick = useCallback((idx) => {
    setOpenIndex((cur) => (cur === idx ? -1 : idx));
  }, []);

  // Hover-switch: when a menu is open, hovering a different top-level
  // switches to it without needing a click (standard menu bar UX).
  const handleTopHover = useCallback((idx) => {
    setOpenIndex((cur) => (cur === -1 ? cur : idx));
  }, []);

  const handleAction = useCallback((actionId) => {
    setOpenIndex(-1);
    if (onAction && actionId) onAction(actionId);
  }, [onAction]);

  return (
    <div
      ref={barRef}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'stretch',
        height: 28,
        flexShrink: 0,
        background: W.bg2,
        borderBottom: `1px solid ${W.border}`,
        userSelect: 'none',
        fontSize: 13,
        fontFamily: 'Inter, system-ui, sans-serif',
        zIndex: 100,
      }}
    >
      {/* Hexis logo */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '0 12px',
          color: W.accent,
          fontWeight: 700,
          fontSize: 14,
          borderRight: `1px solid ${W.borderSubtle}`,
        }}
      >
        <span style={{ fontSize: 15, lineHeight: 1 }}>⬡</span>
        <span style={{ color: W.text, fontWeight: 600, fontSize: 13 }}>Hexis</span>
      </div>

      {menus.map((menu, idx) => {
        const isOpen = openIndex === idx;
        return (
          <div key={menu.label} style={{ position: 'relative' }}>
            <button
              onClick={() => handleTopClick(idx)}
              onMouseEnter={() => handleTopHover(idx)}
              style={{
                background: isOpen ? W.bg3 : 'transparent',
                border: 'none',
                color: W.text,
                padding: '0 10px',
                height: '100%',
                fontSize: 13,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                outline: 'none',
                fontFamily: 'inherit',
              }}
              onMouseOver={(e) => { if (!isOpen) e.currentTarget.style.background = W.bg3; }}
              onMouseOut={(e) => { if (!isOpen) e.currentTarget.style.background = 'transparent'; }}
            >
              <MnemonicLabel label={menu.label} />
            </button>
            {isOpen && (
              <MenuDropdown
                items={menu.items}
                onAction={handleAction}
                onClose={() => setOpenIndex(-1)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export const MenuBar = memo(MenuBarImpl);

// ═════════════════════════════════════════════════════════════════════
// MenuDropdown — the floating pane that opens under a top-level menu
// ═════════════════════════════════════════════════════════════════════

function MenuDropdown({ items, onAction, onClose, position = 'below' }) {
  const [hoverIndex, setHoverIndex] = useState(-1);
  const dropdownRef = useRef(null);

  // Arrow key nav inside the dropdown
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
        const item = items[hoverIndex];
        if (item?.submenu) {
          // No-op; submenus auto-open on hover
        } else if (item?.id) {
          onAction(item.id);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hoverIndex, items, onAction]);

  return (
    <div
      ref={dropdownRef}
      style={{
        position: 'absolute',
        top: position === 'below' ? '100%' : 0,
        left: position === 'below' ? 0 : '100%',
        minWidth: 260,
        background: W.bg1,
        border: `1px solid ${W.border}`,
        borderRadius: W.radius2,
        boxShadow: W.shadow2,
        padding: 4,
        zIndex: 200,
        fontSize: 13,
      }}
    >
      {items.map((item, i) => {
        if (item.separator) {
          return (
            <div
              key={`sep-${i}`}
              style={{
                height: 1,
                background: W.borderSubtle,
                margin: '4px 6px',
              }}
            />
          );
        }
        return (
          <MenuItem
            key={item.id || item.label}
            item={item}
            active={i === hoverIndex}
            onHover={() => setHoverIndex(i)}
            onAction={onAction}
            onClose={onClose}
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

// ═════════════════════════════════════════════════════════════════════
// MenuItem — a single clickable row (with optional submenu)
// ═════════════════════════════════════════════════════════════════════

function MenuItem({ item, active, onHover, onAction, onClose }) {
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const hasSubmenu = item.submenu && item.submenu.length > 0;
  const disabled = item.enabled === false;

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
      // Delay submenu close so the user has time to cross the gap
      setTimeout(() => setSubmenuOpen(false), 150);
    }
  };

  return (
    <div
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        padding: '5px 10px 5px 26px',
        color: disabled ? W.textGhost : W.text,
        background: active && !disabled ? W.accentBg : 'transparent',
        borderRadius: 3,
        cursor: disabled ? 'default' : 'pointer',
        gap: 16,
      }}
    >
      {/* Check/radio indicator (left gutter) */}
      {item.checked && (
        <span
          style={{
            position: 'absolute',
            left: 8,
            top: '50%',
            transform: 'translateY(-50%)',
            color: W.accent,
            fontSize: 11,
          }}
        >
          ✓
        </span>
      )}

      {/* Label with mnemonic underline */}
      <span style={{ flex: 1, whiteSpace: 'nowrap' }}>
        <MnemonicLabel label={item.label} mnemonic={item.mnemonic} />
      </span>

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
      {hasSubmenu && (
        <span style={{ color: W.textDim, fontSize: 10 }}>▸</span>
      )}

      {/* Submenu popup */}
      {submenuOpen && hasSubmenu && (
        <MenuDropdown
          items={item.submenu}
          onAction={(id) => { onAction(id); onClose?.(); }}
          onClose={onClose}
          position="right"
        />
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════
// Mnemonic label: underlines the first matching character for Alt+<c>
// ═════════════════════════════════════════════════════════════════════

function MnemonicLabel({ label, mnemonic }) {
  const target = (mnemonic || label[0] || '').toLowerCase();
  const idx = label.toLowerCase().indexOf(target);
  if (idx === -1) return <span>{label}</span>;
  return (
    <span>
      {label.slice(0, idx)}
      <span style={{ textDecoration: 'underline' }}>{label[idx]}</span>
      {label.slice(idx + 1)}
    </span>
  );
}
