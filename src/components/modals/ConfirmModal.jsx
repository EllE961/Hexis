/**
 * ConfirmModal — reusable confirmation dialog for destructive or
 * irreversible operations (delete, move between groups, drop of a
 * folder, batch operations).
 *
 * Props:
 *   open          — show / hide
 *   title         — heading line
 *   message       — string OR JSX for the body (can show source→dest, counts)
 *   confirmLabel  — confirm button text (default "Confirm")
 *   cancelLabel   — cancel button text (default "Cancel")
 *   destructive   — red confirm button + warning icon
 *   onConfirm     — called on accept
 *   onClose       — called on cancel OR after confirm
 *   details       — optional monospace details block (e.g. file list)
 *
 * Keyboard: Enter confirms, Escape cancels.
 */

import { useEffect, useRef } from 'react';
import { W } from '../../theme/window-tokens.js';
import { Icon } from '../common/Icon.jsx';

export default function ConfirmModal({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onClose,
  details,
}) {
  const confirmBtnRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    // Focus the confirm button so Enter triggers it immediately
    requestAnimationFrame(() => confirmBtnRef.current?.focus());
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Enter') {
        e.stopPropagation();
        onConfirm();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onConfirm, onClose]);

  if (!open) return null;

  const accent = destructive ? W.red : W.accent;

  return (
    <>
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.55)',
          zIndex: 10001,
        }}
        onClick={onClose}
      />
      <div
        style={{
          position: 'fixed',
          top: '22%',
          left: '50%',
          transform: 'translateX(-50%)',
          width: 480,
          maxWidth: '92vw',
          background: W.bg1,
          border: `1px solid ${destructive ? W.red : W.borderHi}`,
          borderRadius: W.radius3,
          boxShadow: W.shadow2,
          overflow: 'hidden',
          zIndex: 10002,
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: `${W.s3}px ${W.s4}px`,
            background: W.bg2,
            borderBottom: `1px solid ${W.border}`,
            display: 'flex',
            alignItems: 'center',
            gap: W.s3,
          }}
        >
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: W.radius2,
              background: destructive ? W.redBg : W.accentBg,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: accent,
              flexShrink: 0,
            }}
          >
            <Icon name={destructive ? 'warning' : 'file-symlink-file'} size={W.iconMd} color={accent} />
          </div>
          <div
            style={{
              fontSize: W.fontLg,
              fontWeight: W.fontWeightSemi,
              color: W.text,
              flex: 1,
            }}
          >
            {title}
          </div>
        </div>

        {/* Body */}
        <div style={{ padding: W.s4 }}>
          <div
            style={{
              fontSize: W.fontMd,
              color: W.textDim,
              lineHeight: 1.55,
              marginBottom: details ? W.s3 : 0,
            }}
          >
            {message}
          </div>
          {details && (
            <div
              style={{
                padding: `${W.s2}px ${W.s3}px`,
                background: W.bg0,
                border: `1px solid ${W.border}`,
                borderRadius: W.radius1,
                fontFamily: '"JetBrains Mono", monospace',
                fontSize: W.fontSm,
                color: W.textMuted,
                maxHeight: 180,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {details}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: `${W.s3}px ${W.s4}px`,
            background: W.bg2,
            borderTop: `1px solid ${W.border}`,
            display: 'flex',
            gap: W.s2,
            justifyContent: 'flex-end',
          }}
        >
          <button
            onClick={onClose}
            style={{
              padding: `${W.s2}px ${W.s4}px`,
              background: 'transparent',
              border: `1px solid ${W.border}`,
              borderRadius: W.radius1,
              color: W.textDim,
              cursor: 'pointer',
              fontSize: W.fontMd,
              fontFamily: 'inherit',
            }}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmBtnRef}
            onClick={onConfirm}
            style={{
              padding: `${W.s2}px ${W.s4}px`,
              background: accent,
              border: 'none',
              borderRadius: W.radius1,
              color: destructive ? '#fff' : W.bg0,
              cursor: 'pointer',
              fontWeight: W.fontWeightSemi,
              fontSize: W.fontMd,
              fontFamily: 'inherit',
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </>
  );
}
