/**
 * NameInputModal — generic text-input modal for New File / New Folder
 * / Rename flows.
 *
 * Props:
 *   open       — show/hide
 *   title      — heading (e.g. "New file in src/components")
 *   placeholder — input placeholder
 *   initial    — initial value (rename pre-fills with old name)
 *   validate   — (name) => string|null — returns error message or null
 *   onSubmit   — (name) => void
 *   onClose    — () => void
 */

import { useState, useEffect, useRef } from 'react';
import { W } from '../../theme/window-tokens.js';

export default function NameInputModal({
  open,
  title,
  placeholder = 'name',
  initial = '',
  validate,
  onSubmit,
  onClose,
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setValue(initial);
      setError(null);
      requestAnimationFrame(() => {
        if (!inputRef.current) return;
        inputRef.current.focus();
        // Select the name portion before any extension for quick replacement
        const dot = initial.lastIndexOf('.');
        if (dot > 0) inputRef.current.setSelectionRange(0, dot);
        else inputRef.current.select();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial]);

  if (!open) return null;

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError('Name cannot be empty');
      return;
    }
    if (/[\\/:*?"<>|]/.test(trimmed)) {
      setError('Name contains invalid characters');
      return;
    }
    // Windows reserved names
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(trimmed)) {
      setError(`"${trimmed}" is a reserved name`);
      return;
    }
    if (validate) {
      const err = validate(trimmed);
      if (err) { setError(err); return; }
    }
    onSubmit(trimmed);
  };

  const handleKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <>
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.45)',
          zIndex: 10000,
        }}
        onClick={onClose}
      />
      <div
        style={{
          position: 'fixed',
          top: '20%',
          left: '50%',
          transform: 'translateX(-50%)',
          width: 440,
          maxWidth: '90vw',
          background: W.bg1,
          border: `1px solid ${W.borderHi}`,
          borderRadius: W.radius2,
          boxShadow: W.shadow2,
          padding: W.s4,
          zIndex: 10001,
        }}
      >
        <div
          style={{
            fontSize: W.fontLg,
            fontWeight: W.fontWeightSemi,
            color: W.text,
            marginBottom: W.s3,
          }}
        >
          {title}
        </div>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => { setValue(e.target.value); setError(null); }}
          onKeyDown={handleKey}
          placeholder={placeholder}
          style={{
            width: '100%',
            background: W.bg0,
            border: `1px solid ${error ? W.red : W.border}`,
            borderRadius: W.radius1,
            color: W.text,
            fontSize: W.fontMd,
            padding: `${W.s2}px ${W.s3}px`,
            outline: 'none',
            fontFamily: '"JetBrains Mono", monospace',
          }}
        />
        {error && (
          <div
            style={{
              marginTop: W.s2,
              fontSize: W.fontSm,
              color: W.red,
            }}
          >
            {error}
          </div>
        )}
        <div
          style={{
            display: 'flex',
            gap: W.s2,
            justifyContent: 'flex-end',
            marginTop: W.s4,
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
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            style={{
              padding: `${W.s2}px ${W.s4}px`,
              background: W.accent,
              border: 'none',
              borderRadius: W.radius1,
              color: W.bg0,
              cursor: 'pointer',
              fontWeight: W.fontWeightSemi,
              fontSize: W.fontMd,
            }}
          >
            OK
          </button>
        </div>
      </div>
    </>
  );
}
