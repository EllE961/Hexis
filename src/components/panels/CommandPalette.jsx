import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useGraphStore } from '../../hooks/useGraph.js';
import { colors } from '../../theme/tokens.js';
import { getSectionColor } from '../utils/colors.js';
import { Search, Hash, CornerDownLeft } from 'lucide-react';

function fuzzyMatch(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q)) return { match: true, score: t.indexOf(q) === 0 ? 2 : 1 };
  // Simple fuzzy: all query chars appear in order
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return { match: qi === q.length, score: qi === q.length ? 0.5 : 0 };
}

export default function CommandPalette({ graphRef }) {
  const searchOpen = useGraphStore(s => s.searchOpen);
  const setSearchOpen = useGraphStore(s => s.setSearchOpen);
  const nodes = useGraphStore(s => s.nodes);
  const setSelectedNode = useGraphStore(s => s.setSelectedNode);
  const setSelectedGroup = useGraphStore(s => s.setSelectedGroup);

  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef();
  const listRef = useRef();

  // Reset on open
  useEffect(() => {
    if (searchOpen) {
      setQuery('');
      setSelectedIdx(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [searchOpen]);

  // Keyboard shortcut: Ctrl/Cmd+K
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen(!searchOpen);
      }
      if (e.key === 'Escape' && searchOpen) {
        e.preventDefault();
        setSearchOpen(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [searchOpen, setSearchOpen]);

  const results = useMemo(() => {
    if (!query.trim()) {
      // Show recent/important nodes when no query
      return [...nodes]
        .sort((a, b) => (b.connections || 0) - (a.connections || 0))
        .slice(0, 12);
    }
    return nodes
      .map(node => {
        const titleMatch = fuzzyMatch(query, node.title || node.label);
        const typeMatch = fuzzyMatch(query, node.type);
        const tagMatch = node.tags.some(t => fuzzyMatch(query, t).match);
        const sectionMatch = fuzzyMatch(query, node.section);
        const score = titleMatch.score * 3 + typeMatch.score + (tagMatch ? 1 : 0) + sectionMatch.score * 0.5;
        return { node, match: titleMatch.match || typeMatch.match || tagMatch || sectionMatch.match, score };
      })
      .filter(r => r.match)
      .sort((a, b) => b.score - a.score)
      .slice(0, 15)
      .map(r => r.node);
  }, [query, nodes]);

  useEffect(() => { setSelectedIdx(0); }, [query]);

  // Scroll selected into view
  useEffect(() => {
    if (listRef.current) {
      const el = listRef.current.children[selectedIdx];
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIdx]);

  const selectNode = useCallback((node) => {
    setSelectedNode(node.id);
    setSelectedGroup(null);
    setSearchOpen(false);
    if (graphRef?.current) {
      graphRef.current.centerAt(node.x, node.y, 300);
      graphRef.current.zoom(1.5, 300);
    }
  }, [setSelectedNode, setSelectedGroup, setSearchOpen, graphRef]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && results[selectedIdx]) {
      e.preventDefault();
      selectNode(results[selectedIdx]);
    }
  }, [results, selectedIdx, selectNode]);

  if (!searchOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]"
      style={{ background: 'rgba(0, 0, 0, 0.6)', backdropFilter: 'blur(8px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) setSearchOpen(false); }}
    >
      <div
        className="w-full max-w-[560px] rounded-xl overflow-hidden"
        style={{
          background: colors.bgBase,
          border: `1px solid ${colors.borderHover}`,
          boxShadow: '0 24px 80px rgba(120,80,20,0.25), 0 0 1px rgba(180,140,60,0.1)',
        }}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-5 py-4" style={{ borderBottom: `1px solid ${colors.border}` }}>
          <Search size={18} style={{ color: colors.textTertiary, flexShrink: 0 }} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search nodes..."
            className="flex-1 bg-transparent outline-none text-[16px]"
            style={{ color: colors.textPrimary, caretColor: colors.accent }}
          />
          <kbd
            className="px-2 py-0.5 rounded text-[11px] font-medium"
            style={{ background: 'rgba(180,140,60,0.06)', color: colors.textTertiary, border: `1px solid ${colors.border}` }}
          >
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[400px] overflow-y-auto py-2">
          {results.length === 0 ? (
            <div className="px-5 py-8 text-center text-[14px]" style={{ color: colors.textTertiary }}>
              No results found
            </div>
          ) : (
            results.map((node, i) => {
              const isActive = i === selectedIdx;
              const secColor = getSectionColor(node.section);
              return (
                <button
                  key={node.id}
                  className="w-full text-left px-5 py-3 flex items-center gap-3 transition-fast"
                  style={{
                    background: isActive ? 'rgba(99, 102, 241, 0.08)' : 'transparent',
                    borderLeft: isActive ? `2px solid ${colors.accent}` : '2px solid transparent',
                  }}
                  onClick={() => selectNode(node)}
                  onMouseEnter={() => setSelectedIdx(i)}
                >
                  {/* Section indicator */}
                  <div
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ background: secColor }}
                  />

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="text-[14px] font-medium truncate" style={{ color: isActive ? colors.textPrimary : colors.textSecondary }}>
                      {node.title || node.label}
                    </div>
                    <div className="text-[12px] mt-0.5 flex items-center gap-1.5" style={{ color: colors.textTertiary }}>
                      <span style={{ color: secColor }}>{node.type}</span>
                      <span>·</span>
                      <span>{node.section}</span>
                      {node.tags.length > 0 && (
                        <>
                          <span>·</span>
                          <Hash size={10} style={{ opacity: 0.5 }} />
                          <span>{node.tags.slice(0, 2).join(', ')}</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Enter hint */}
                  {isActive && (
                    <CornerDownLeft size={14} style={{ color: colors.textTertiary, flexShrink: 0 }} />
                  )}
                </button>
              );
            })
          )}
        </div>

        {/* Footer hints */}
        <div
          className="flex items-center gap-4 px-5 py-2.5 text-[11px]"
          style={{ borderTop: `1px solid ${colors.border}`, color: colors.textTertiary }}
        >
          <span className="flex items-center gap-1">
            <kbd className="px-1.5 py-0.5 rounded" style={{ background: 'rgba(180,140,60,0.06)' }}>↑↓</kbd>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1.5 py-0.5 rounded" style={{ background: 'rgba(180,140,60,0.06)' }}>↵</kbd>
            select
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1.5 py-0.5 rounded" style={{ background: 'rgba(180,140,60,0.06)' }}>esc</kbd>
            close
          </span>
        </div>
      </div>
    </div>
  );
}
