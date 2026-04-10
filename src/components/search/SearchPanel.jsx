/**
 * SearchPanel — workspace-wide search UI.
 *
 * Powered by ripgrep (via searchStore → Tauri command or Express
 * endpoint). Results are grouped by file. Click a match to open the
 * file in the editor and jump to the line.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useSearchStore } from '../../stores/searchStore.js';
import { useEditorStore } from '../../stores/editorStore.js';
import { useJumplistStore } from '../../stores/jumplistStore.js';
import { W } from '../../theme/window-tokens.js';
import { Search, Regex, CaseSensitive, X, AlertCircle } from 'lucide-react';

export default function SearchPanel() {
  const query = useSearchStore(s => s.query);
  const regex = useSearchStore(s => s.regex);
  const caseSensitive = useSearchStore(s => s.caseSensitive);
  const glob = useSearchStore(s => s.glob);
  const results = useSearchStore(s => s.results);
  const running = useSearchStore(s => s.running);
  const error = useSearchStore(s => s.error);
  const truncated = useSearchStore(s => s.truncated);
  const setQuery = useSearchStore(s => s.setQuery);
  const setRegex = useSearchStore(s => s.setRegex);
  const setCaseSensitive = useSearchStore(s => s.setCaseSensitive);
  const setGlob = useSearchStore(s => s.setGlob);
  const runSearch = useSearchStore(s => s.run);
  const clear = useSearchStore(s => s.clear);

  const openFile = useEditorStore(s => s.openFile);
  const jumpPush = useJumplistStore(s => s.push);

  // Debounce search — fires 250ms after last keystroke or flag change
  const debounceRef = useRef(null);
  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      runSearch();
    }, 250);
    return () => clearTimeout(debounceRef.current);
  }, [query, regex, caseSensitive, glob, runSearch]);

  // Group results by file
  const grouped = useMemo(() => {
    const map = new Map();
    for (const r of results) {
      if (!map.has(r.path)) map.set(r.path, []);
      map.get(r.path).push(r);
    }
    return [...map.entries()];
  }, [results]);

  const handleMatchClick = (match) => {
    jumpPush({
      path: match.path,
      line: match.line - 1, // jumplist is 0-indexed
      col: match.col,
      label: `search: ${query}`,
    });
    openFile(match.path).then(() => {
      // Best-effort line seek — EditorPanel's jumplist effect handles it
    });
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: W.bg1,
        color: W.text,
      }}
    >
      {/* Search input */}
      <div
        style={{
          flexShrink: 0,
          padding: W.s3,
          borderBottom: `1px solid ${W.border}`,
          background: W.bg2,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: W.s2,
            padding: `${W.s2}px ${W.s2}px`,
            background: W.bg0,
            border: `1px solid ${W.border}`,
            borderRadius: W.radius1,
          }}
        >
          <Search size={14} color={W.textDim} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search workspace…"
            autoFocus
            style={{
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: W.text,
              fontSize: W.fontMd,
              flex: 1,
              fontFamily: '"JetBrains Mono", monospace',
            }}
          />
          {query && (
            <button
              onClick={() => { setQuery(''); clear(); }}
              style={{ background: 'transparent', border: 'none', color: W.textDim, cursor: 'pointer', padding: 0, display: 'flex' }}
            >
              <X size={12} />
            </button>
          )}

          {/* Flag toggles */}
          <FlagButton active={caseSensitive} onClick={() => setCaseSensitive(!caseSensitive)} title="Match case">
            <CaseSensitive size={12} />
          </FlagButton>
          <FlagButton active={regex} onClick={() => setRegex(!regex)} title="Regex">
            <Regex size={12} />
          </FlagButton>
        </div>

        {/* Glob filter */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: W.s2,
            padding: `${W.s1}px ${W.s2}px`,
            background: W.bg0,
            border: `1px solid ${W.border}`,
            borderRadius: W.radius1,
            marginTop: W.s2,
          }}
        >
          <span style={{ fontSize: W.fontSm, color: W.textDim, fontFamily: '"JetBrains Mono", monospace' }}>files:</span>
          <input
            value={glob}
            onChange={(e) => setGlob(e.target.value)}
            placeholder="*.{js,ts} or src/**"
            style={{
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: W.text,
              fontSize: W.fontSm,
              flex: 1,
              fontFamily: '"JetBrains Mono", monospace',
            }}
          />
        </div>

        {/* Status line */}
        <div style={{ fontSize: W.fontSm, color: W.textDim, marginTop: W.s2, minHeight: 14 }}>
          {running && 'Searching…'}
          {!running && !error && query && results.length === 0 && 'No matches.'}
          {!running && results.length > 0 && (
            <span>
              {results.length} match{results.length === 1 ? '' : 'es'} in {grouped.length} file{grouped.length === 1 ? '' : 's'}
              {truncated && <span style={{ color: W.accent }}> (truncated)</span>}
            </span>
          )}
          {error && (
            <span style={{ color: W.red, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <AlertCircle size={12} /> {error}
            </span>
          )}
        </div>
      </div>

      {/* Results list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {grouped.map(([path, matches]) => (
          <div key={path} style={{ borderBottom: `1px solid ${W.borderSubtle}` }}>
            <div
              style={{
                padding: `${W.s2}px ${W.s3}px`,
                fontSize: W.fontSm,
                color: W.textDim,
                fontFamily: '"JetBrains Mono", monospace',
                background: W.bg0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span
                style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}
                title={path}
              >
                {path}
              </span>
              <span style={{ color: W.accent, fontSize: W.fontXs }}>{matches.length}</span>
            </div>
            {matches.map((m, i) => (
              <button
                key={`${m.line}-${i}`}
                onClick={() => handleMatchClick(m)}
                style={{
                  display: 'flex',
                  width: '100%',
                  padding: `3px ${W.s3}px`,
                  background: 'transparent',
                  border: 'none',
                  color: W.text,
                  fontFamily: '"JetBrains Mono", monospace',
                  fontSize: 11,
                  textAlign: 'left',
                  cursor: 'pointer',
                  alignItems: 'flex-start',
                  gap: W.s2,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = W.bg2; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <span style={{ color: W.textGhost, width: 40, textAlign: 'right', flexShrink: 0 }}>
                  {m.line}
                </span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {renderHighlighted(m.text, m.matches)}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function FlagButton({ active, onClick, title, children }) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        background: active ? W.accentBg : 'transparent',
        border: 'none',
        color: active ? W.accent : W.textDim,
        cursor: 'pointer',
        padding: 3,
        display: 'flex',
        alignItems: 'center',
        borderRadius: W.radius1,
      }}
    >
      {children}
    </button>
  );
}

/** Render a line with matched byte ranges highlighted. */
function renderHighlighted(text, matches) {
  if (!matches || matches.length === 0) return text;
  const parts = [];
  let cursor = 0;
  for (const [start, end] of matches) {
    if (start > cursor) parts.push(<span key={`p-${cursor}`}>{text.slice(cursor, start)}</span>);
    parts.push(
      <span key={`m-${start}`} style={{ background: 'rgba(240, 160, 48, 0.35)', color: W.text, borderRadius: 2 }}>
        {text.slice(start, end)}
      </span>
    );
    cursor = end;
  }
  if (cursor < text.length) parts.push(<span key={`e-${cursor}`}>{text.slice(cursor)}</span>);
  return parts;
}
