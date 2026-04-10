/**
 * AiEditModal — Cursor-style Ctrl+K inline AI edit.
 *
 * Shows a small input over the editor. User describes the change in
 * natural language, hits Enter. The selection (or current line if no
 * selection) + surrounding context are sent to Claude via the server.
 * The returned code is previewed inline; user accepts (Enter) or
 * rejects (Escape).
 */

import { useState, useEffect, useRef } from 'react';
import { W } from '../../theme/window-tokens.js';
import { Sparkles, Loader2, Check, X as XIcon } from 'lucide-react';

export default function AiEditModal({ open, selection, onClose, onApply }) {
  const [instruction, setInstruction] = useState('');
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setInstruction('');
      setPreview(null);
      setError(null);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  if (!open) return null;

  const run = async () => {
    if (!instruction.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/ai/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: selection.filePath,
          before: selection.before,
          selection: selection.text,
          after: selection.after,
          instruction: instruction.trim(),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setPreview(data.newCode || '');
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleApply = () => {
    if (preview != null) {
      onApply(preview);
      onClose();
    }
  };

  const handleKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (preview != null) handleApply();
      else run();
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 z-50"
        style={{ background: 'rgba(0,0,0,0.45)' }}
        onClick={onClose}
      />
      <div
        className="fixed z-50"
        style={{
          top: '15%',
          left: '50%',
          transform: 'translateX(-50%)',
          width: 680,
          maxWidth: '92vw',
          background: W.bg1,
          border: `1px solid ${W.borderHi}`,
          borderRadius: W.radius3,
          boxShadow: W.shadow2,
          overflow: 'hidden',
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
            gap: W.s2,
          }}
        >
          <Sparkles size={14} color={W.accent} />
          <span style={{ fontSize: W.fontLg, fontWeight: W.fontWeightSemi, color: W.text, flex: 1 }}>
            Edit with AI
          </span>
          <span style={{ fontSize: W.fontSm, color: W.textGhost, fontFamily: '"JetBrains Mono", monospace' }}>
            {selection.text ? `${selection.text.split('\n').length}L selected` : 'current line'}
          </span>
        </div>

        {/* Instruction input */}
        <div style={{ padding: W.s3 }}>
          <textarea
            ref={inputRef}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Describe the change… e.g. 'convert to async/await' or 'add error handling'"
            rows={2}
            disabled={loading}
            style={{
              width: '100%',
              background: W.bg0,
              border: `1px solid ${W.border}`,
              borderRadius: W.radius1,
              color: W.text,
              fontSize: W.fontMd,
              padding: `${W.s2}px ${W.s3}px`,
              outline: 'none',
              fontFamily: 'inherit',
              resize: 'vertical',
              minHeight: 48,
            }}
          />

          {error && (
            <div
              style={{
                marginTop: W.s2,
                padding: `${W.s2}px ${W.s3}px`,
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                borderRadius: W.radius1,
                color: W.red,
                fontSize: W.fontSm,
              }}
            >
              {error}
            </div>
          )}

          {preview != null && (
            <div style={{ marginTop: W.s3 }}>
              <div
                style={{
                  fontSize: W.fontSm,
                  color: W.textMuted,
                  marginBottom: W.s2,
                  display: 'flex',
                  alignItems: 'center',
                  gap: W.s2,
                }}
              >
                <span>Preview</span>
                <span style={{ flex: 1, height: 1, background: W.borderSubtle }} />
              </div>
              <pre
                style={{
                  background: W.bg0,
                  border: `1px solid ${W.border}`,
                  borderRadius: W.radius1,
                  padding: W.s3,
                  fontSize: 12,
                  fontFamily: '"JetBrains Mono", monospace',
                  color: W.text,
                  maxHeight: 320,
                  overflow: 'auto',
                  margin: 0,
                  whiteSpace: 'pre',
                }}
              >
                {preview}
              </pre>
            </div>
          )}

          {/* Footer actions */}
          <div
            style={{
              marginTop: W.s3,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: W.s2,
            }}
          >
            <div style={{ fontSize: W.fontSm, color: W.textGhost }}>
              {preview == null
                ? 'Enter to generate · Esc to cancel'
                : 'Enter to apply · Esc to cancel'}
            </div>
            <div style={{ display: 'flex', gap: W.s2 }}>
              {preview != null && (
                <button
                  onClick={() => { setPreview(null); setInstruction(''); }}
                  style={{
                    padding: `${W.s2}px ${W.s3}px`,
                    background: 'transparent',
                    border: `1px solid ${W.border}`,
                    borderRadius: W.radius1,
                    color: W.textDim,
                    fontSize: W.fontSm,
                    cursor: 'pointer',
                  }}
                >
                  Try again
                </button>
              )}
              {preview != null ? (
                <button
                  onClick={handleApply}
                  style={{
                    padding: `${W.s2}px ${W.s4}px`,
                    background: W.accent,
                    border: 'none',
                    borderRadius: W.radius1,
                    color: W.bg0,
                    fontWeight: W.fontWeightSemi,
                    fontSize: W.fontSm,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <Check size={12} /> Apply
                </button>
              ) : (
                <button
                  onClick={run}
                  disabled={loading || !instruction.trim()}
                  style={{
                    padding: `${W.s2}px ${W.s4}px`,
                    background: loading || !instruction.trim() ? W.bg3 : W.accent,
                    border: 'none',
                    borderRadius: W.radius1,
                    color: loading || !instruction.trim() ? W.textGhost : W.bg0,
                    fontWeight: W.fontWeightSemi,
                    fontSize: W.fontSm,
                    cursor: loading || !instruction.trim() ? 'default' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  {loading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                  {loading ? 'Thinking…' : 'Generate'}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
