/**
 * <Window> — the unified container primitive used by EVERY panel, modal, and popover.
 *
 * Variants:
 *   - panel:   docked or floating tool window (sharp corners, full-height)
 *   - modal:   centered overlay with backdrop (rounded, dismissable on outside click + Esc)
 *   - popover: anchored, lightweight floater (rounded, no backdrop)
 *
 * Props are intentionally consistent across variants:
 *   <Window variant="panel" title="AI Agents" icon="🐝" onClose={...}>...</Window>
 *
 * All windows share the same header style, padding, border, and animation.
 */

import React, { useEffect, useRef } from 'react';
import { W } from '../../theme/window-tokens.js';
import { Icon } from '../common/Icon.jsx';

/* ─── Window Header ─── */

export function WindowHeader({ icon, title, subtitle, controls, onMouseDown, dragging, focused }) {
  return (
    <div
      onMouseDown={onMouseDown}
      style={{
        flexShrink: 0,
        height: W.headerHeight,
        display: 'flex',
        alignItems: 'center',
        gap: W.s2,
        padding: `0 ${W.s3}px`,
        background: focused ? W.bg2 : W.bg2,
        borderBottom: `1px solid ${focused ? W.borderHi : W.border}`,
        cursor: onMouseDown ? (dragging ? 'grabbing' : 'grab') : 'default',
        userSelect: 'none',
        transition: `border-color ${W.animFast}`,
      }}
    >
      {icon && (
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: W.iconMd,
          height: W.iconMd,
          flexShrink: 0,
          color: focused ? W.accent : W.textDim,
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
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: W.s2 }}>
        <span style={{
          fontSize: W.fontLg,
          fontWeight: W.fontWeightSemi,
          color: W.text,
          letterSpacing: '-0.01em',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>{title}</span>
        {subtitle && (
          <span style={{
            fontSize: W.fontSm,
            color: W.textMuted,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>{subtitle}</span>
        )}
      </div>
      {controls && (
        <div style={{ display: 'flex', alignItems: 'center', gap: W.s1 }}>
          {controls}
        </div>
      )}
    </div>
  );
}

/* ─── Header control button (X, minimize, maximize, etc.) ─── */

export function HeaderButton({ icon, label, onClick, color = W.textDim, hoverColor = W.text, hoverBg = W.bg3 }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick?.(); }}
      title={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: W.dockBtnSize,
        height: W.dockBtnSize,
        border: 'none',
        background: 'transparent',
        color,
        borderRadius: W.radius1,
        cursor: 'pointer',
        padding: 0,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = hoverBg;
        e.currentTarget.style.color = hoverColor;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.color = color;
      }}
    >{icon}</button>
  );
}

/* ─── Window: panel variant ─── */

export function Window({ children, style, focused = false, ...rest }) {
  return (
    <div
      {...rest}
      style={{
        display: 'flex',
        flexDirection: 'column',
        background: W.bg1,
        border: `1px solid ${focused ? W.borderHi : W.border}`,
        overflow: 'hidden',
        transition: `border-color ${W.animFast}`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/* ─── Window body — scrollable content area with consistent padding ─── */

export function WindowBody({ children, padded = true, scroll = true, style, ...rest }) {
  return (
    <div
      {...rest}
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: scroll ? 'auto' : 'visible',
        overflowX: 'hidden',
        padding: padded ? W.s3 : 0,
        background: W.bg1,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/* ─── Window footer (optional, for action buttons) ─── */

export function WindowFooter({ children, align = 'right', style }) {
  const justifyContent = align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start';
  return (
    <div style={{
      flexShrink: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent,
      gap: W.s2,
      padding: `${W.s3}px ${W.s4}px`,
      borderTop: `1px solid ${W.border}`,
      background: W.bg2,
      ...style,
    }}>{children}</div>
  );
}

/* ─── Modal — centered overlay with backdrop ─── */

export function Modal({
  open,
  onClose,
  title,
  icon,
  subtitle,
  children,
  width = 480,
  maxHeight = '70vh',
  footer,
  closable = true,
}) {
  const backdropRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape' && closable) onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, closable]);

  if (!open) return null;

  return (
    <div
      ref={backdropRef}
      onClick={(e) => { if (e.target === backdropRef.current && closable) onClose?.(); }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: W.zModalBackdrop,
        background: 'rgba(0, 0, 0, 0.6)',
        backdropFilter: 'blur(2px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: `windowFadeIn ${W.animMed}`,
      }}
    >
      <div style={{
        zIndex: W.zModal,
        width,
        maxWidth: '90vw',
        maxHeight,
        display: 'flex',
        flexDirection: 'column',
        background: W.bg1,
        border: `1px solid ${W.border}`,
        borderRadius: W.radius3,
        boxShadow: W.shadow3,
        overflow: 'hidden',
        animation: `windowPopIn ${W.animMed}`,
      }}>
        {(title || icon) && (
          <WindowHeader
            icon={icon}
            title={title}
            subtitle={subtitle}
            controls={closable && (
              <HeaderButton icon={<Icon name="close" size={W.iconSm} />} label="Close" onClick={onClose} hoverColor={W.red} hoverBg={W.redBg} />
            )}
          />
        )}
        <div style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: W.s4,
          background: W.bg1,
        }}>{children}</div>
        {footer && (
          <WindowFooter>{footer}</WindowFooter>
        )}
      </div>

      <style>{`
        @keyframes windowFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes windowPopIn {
          from { opacity: 0; transform: translateY(8px) scale(0.98); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}

/* ─── Popover — anchored floating panel without backdrop ─── */

export function Popover({ open, onClose, anchor = { top: 0, left: 0 }, children, width = 320, maxHeight = 480 }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose?.();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    setTimeout(() => document.addEventListener('mousedown', onClick), 0);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        zIndex: W.zPopover,
        top: anchor.top,
        left: anchor.left,
        width,
        maxHeight,
        background: W.bg1,
        border: `1px solid ${W.border}`,
        borderRadius: W.radius3,
        boxShadow: W.shadow2,
        overflow: 'hidden',
        animation: `windowPopIn ${W.animFast}`,
        display: 'flex',
        flexDirection: 'column',
      }}
    >{children}</div>
  );
}

/* ─── Tooltip — small floating label, no interactivity ─── */

export function Tooltip({ children, anchor, placement = 'top' }) {
  return (
    <div style={{
      position: 'fixed',
      zIndex: W.zTooltip,
      top: anchor.top,
      left: anchor.left,
      padding: `${W.s1}px ${W.s2}px`,
      background: W.bg4,
      border: `1px solid ${W.border}`,
      borderRadius: W.radius1,
      fontSize: W.fontSm,
      color: W.text,
      boxShadow: W.shadow1,
      pointerEvents: 'none',
      whiteSpace: 'nowrap',
    }}>{children}</div>
  );
}
