/**
 * OutlinePanel — hierarchical symbol outline for the active file.
 *
 * Reads from an `outline` prop (list of items produced by buildOutline()
 * in ../symbols.js). Click an item to jump to it. Fuzzy filter at the
 * top. Breadcrumbs at the top show the current cursor context.
 *
 * The panel is self-contained: it doesn't know about CodeMirror — it
 * just takes items and calls onJump(item). EditorPanel owns the CM
 * instance and translates the jump request into a dispatch.
 */

import { useMemo, useState, useCallback } from 'react';
import { SYMBOL_STYLE } from './symbols.js';
import { W } from '../../theme/window-tokens.js';
import { Search, X } from 'lucide-react';

export default function OutlinePanel({ outline, breadcrumb, onJump, onClose }) {
  const [query, setQuery] = useState('');

  const flat = useMemo(() => flatten(outline, 0), [outline]);
  const filtered = useMemo(() => {
    if (!query) return flat;
    const q = query.toLowerCase();
    return flat.filter((item) => fuzzyMatch(q, item.name.toLowerCase()));
  }, [flat, query]);

  const activePath = useMemo(
    () => (breadcrumb && breadcrumb.length > 0 ? breadcrumb.map((b) => `${b.from}:${b.to}`).join('|') : ''),
    [breadcrumb]
  );

  const activeItem = breadcrumb && breadcrumb.length > 0
    ? breadcrumb[breadcrumb.length - 1]
    : null;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: W.bg1,
        color: W.text,
        fontSize: W.fontMd,
      }}
    >
      {/* Header */}
      <div
        style={{
          flexShrink: 0,
          padding: `${W.s3}px ${W.s3}px ${W.s2}px`,
          borderBottom: `1px solid ${W.border}`,
          background: W.bg2,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: W.s2 }}>
          <span style={{ fontSize: W.fontLg, fontWeight: W.fontWeightSemi, color: W.text, flex: 1 }}>
            Outline
          </span>
          <span style={{ fontSize: W.fontSm, color: W.textMuted, marginRight: W.s2 }}>
            {flat.length}
          </span>
          {onClose && (
            <button
              onClick={onClose}
              style={{
                background: 'transparent',
                border: 'none',
                color: W.textDim,
                cursor: 'pointer',
                padding: 2,
                display: 'flex',
              }}
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* Search */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: W.s2,
            padding: `4px ${W.s2}px`,
            background: W.bg0,
            border: `1px solid ${W.border}`,
            borderRadius: W.radius1,
          }}
        >
          <Search size={12} color={W.textDim} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter symbols…"
            style={{
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: W.text,
              fontSize: W.fontMd,
              flex: 1,
              fontFamily: 'inherit',
            }}
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              style={{ background: 'transparent', border: 'none', color: W.textDim, cursor: 'pointer', padding: 0 }}
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Breadcrumb strip */}
      {breadcrumb && breadcrumb.length > 0 && (
        <div
          style={{
            flexShrink: 0,
            padding: `${W.s2}px ${W.s3}px`,
            fontSize: W.fontSm,
            color: W.textMuted,
            borderBottom: `1px solid ${W.borderSubtle}`,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            flexWrap: 'wrap',
            background: W.bg0,
          }}
        >
          {breadcrumb.map((b, i) => {
            const style = SYMBOL_STYLE[b.kind] || SYMBOL_STYLE.variable;
            return (
              <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                {i > 0 && <span style={{ color: W.textDim, margin: '0 2px' }}>›</span>}
                <span style={{ color: style.color, fontWeight: 700 }}>{style.icon}</span>
                <button
                  onClick={() => onJump(b)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: i === breadcrumb.length - 1 ? W.text : W.textMuted,
                    fontSize: 'inherit',
                    cursor: 'pointer',
                    padding: 0,
                    fontWeight: i === breadcrumb.length - 1 ? 600 : 400,
                  }}
                >
                  {b.name}
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto', padding: `${W.s2}px 0` }}>
        {filtered.length === 0 && (
          <div
            style={{
              padding: W.s4,
              textAlign: 'center',
              color: W.textDim,
              fontSize: W.fontSm,
            }}
          >
            {outline.length === 0 ? 'No symbols in this file.' : 'No matches.'}
          </div>
        )}
        {filtered.map((item) => {
          const style = SYMBOL_STYLE[item.kind] || SYMBOL_STYLE.variable;
          const isActive = activeItem && activeItem.from === item.from && activeItem.to === item.to;
          return (
            <button
              key={`${item.from}-${item.to}`}
              onClick={() => onJump(item)}
              style={{
                display: 'flex',
                alignItems: 'center',
                width: '100%',
                padding: `4px ${W.s3}px 4px ${W.s3 + item.depth * 14}px`,
                background: isActive ? 'rgba(240, 160, 48, 0.12)' : 'transparent',
                border: 'none',
                color: W.text,
                fontSize: W.fontMd,
                textAlign: 'left',
                cursor: 'pointer',
                gap: W.s2,
                borderLeft: isActive ? `2px solid ${W.accent}` : '2px solid transparent',
              }}
              onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = W.bg2; }}
              onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
            >
              <span
                style={{
                  color: style.color,
                  fontWeight: 700,
                  width: 14,
                  textAlign: 'center',
                  fontFamily: '"JetBrains Mono", monospace',
                  fontSize: 12,
                  flexShrink: 0,
                }}
              >
                {style.icon}
              </span>
              <span
                style={{
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontFamily: '"JetBrains Mono", monospace',
                  fontSize: 12,
                }}
              >
                {item.name}
              </span>
              <span style={{ color: W.textDim, fontSize: 10 }}>{style.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function flatten(items, depth) {
  const out = [];
  for (const item of items) {
    out.push({ ...item, depth });
    if (item.children && item.children.length > 0) {
      out.push(...flatten(item.children, depth + 1));
    }
  }
  return out;
}

function fuzzyMatch(needle, haystack) {
  let j = 0;
  for (let i = 0; i < haystack.length && j < needle.length; i++) {
    if (haystack[i] === needle[j]) j++;
  }
  return j === needle.length;
}
