/**
 * CommandPalette — VS Code-style Cmd+K / Ctrl+K command palette.
 * Fuzzy searches across files, commands, and git branches.
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useGitStore } from '../../stores/gitStore.js';
import { useSymbolIndexStore } from '../../stores/symbolIndexStore.js';
import { SYMBOL_STYLE } from '../editor/symbols.js';
import { Icon } from '../common/Icon.jsx';
import { W } from '../../theme/window-tokens.js';

// ─── Built-in commands ───
//
// `icon` is the Codicon name — rendered via the shared <Icon/> component.
// Category-specific icons make scanning the palette much faster.

const COMMANDS = [
  { id: 'git:commit',        title: 'Git: Commit',            icon: 'git-commit',    shortcut: null,    category: 'git' },
  { id: 'git:push',          title: 'Git: Push',              icon: 'repo-push',     shortcut: null,    category: 'git' },
  { id: 'git:pull',          title: 'Git: Pull',              icon: 'repo-pull',     shortcut: null,    category: 'git' },
  { id: 'git:ship-it',       title: 'Git: Ship It',           icon: 'rocket',        shortcut: null,    category: 'git' },
  { id: 'git:stash',         title: 'Git: Stash',             icon: 'archive',       shortcut: null,    category: 'git' },
  { id: 'git:create-branch', title: 'Git: Create Branch',     icon: 'git-branch',    shortcut: null,    category: 'git' },
  { id: 'ai:new-task',       title: 'AI: New Task',           icon: 'sparkle',       shortcut: null,    category: 'ai' },
  { id: 'view:git-panel',    title: 'View: Toggle Git Panel', icon: 'source-control', shortcut: 'Ctrl+G', category: 'view' },
  { id: 'view:ai-panel',     title: 'View: Toggle AI Panel',  icon: 'hubot',         shortcut: 'Ctrl+I', category: 'view' },
  { id: 'view:timeline',     title: 'View: Toggle Timeline',  icon: 'history',       shortcut: 'Ctrl+T', category: 'view' },
  { id: 'file:save',         title: 'File: Save',             icon: 'save',          shortcut: 'Ctrl+S', category: 'file' },
  { id: 'file:close-tab',    title: 'File: Close Tab',        icon: 'close',         shortcut: null,    category: 'file' },
];

const MAX_RESULTS = 12;

// ─── Fuzzy matching ───

function fuzzyMatch(query, target) {
  if (!query) return { match: true, score: 0, indices: [] };

  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const indices = [];
  let qi = 0;
  let score = 0;
  let lastIndex = -1;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      indices.push(ti);
      // Bonus for consecutive matches
      if (lastIndex === ti - 1) {
        score += 10;
      }
      // Bonus for matching at start of string or after separator
      if (ti === 0 || t[ti - 1] === '/' || t[ti - 1] === '.' || t[ti - 1] === ' ' || t[ti - 1] === ':') {
        score += 5;
      }
      // Penalize by position (earlier matches = better)
      score += Math.max(0, 5 - ti * 0.1);
      lastIndex = ti;
      qi++;
    }
  }

  if (qi < q.length) return { match: false, score: 0, indices: [] };

  return { match: true, score, indices };
}

// ─── Highlighted text with fuzzy match indices ───

function HighlightedText({ text, indices }) {
  if (!indices || indices.length === 0) {
    return <span>{text}</span>;
  }

  const indexSet = new Set(indices);
  const parts = [];
  let current = '';
  let isHighlighted = false;

  for (let i = 0; i < text.length; i++) {
    const shouldHighlight = indexSet.has(i);
    if (shouldHighlight !== isHighlighted) {
      if (current) {
        parts.push(
          isHighlighted
            ? <span key={i} style={{ color: W.text, fontWeight: 600 }}>{current}</span>
            : <span key={i}>{current}</span>
        );
      }
      current = '';
      isHighlighted = shouldHighlight;
    }
    current += text[i];
  }
  if (current) {
    parts.push(
      isHighlighted
        ? <span key="last" style={{ color: W.text, fontWeight: 600 }}>{current}</span>
        : <span key="last">{current}</span>
    );
  }

  return <>{parts}</>;
}

// ─── Main Component ───

export default function CommandPalette({ open, onClose, files = [], onOpenFile, onCommand }) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const branches = useGitStore(s => s.branches);
  const currentBranch = useGitStore(s => s.currentBranch);
  const checkoutBranch = useGitStore(s => s.checkoutBranch);
  const fetchBranches = useGitStore(s => s.fetchBranches);
  const searchSymbols = useSymbolIndexStore(s => s.search);

  // Fetch branches when palette opens
  useEffect(() => {
    if (open) {
      fetchBranches();
      setQuery('');
      setSelectedIndex(0);
      // Focus input after render
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Allow other components (e.g. menu bar's "Go to Symbol in Workspace…")
  // to seed a query prefix when the palette opens.
  useEffect(() => {
    if (!open) return;
    const onSeed = (e) => {
      const prefix = e.detail?.prefix;
      if (typeof prefix === 'string') setQuery(prefix);
    };
    window.addEventListener('hexis:palette-seed', onSeed);
    return () => window.removeEventListener('hexis:palette-seed', onSeed);
  }, [open]);

  // Build unified result list with fuzzy scoring
  const results = useMemo(() => {
    const items = [];

    // Symbol mode: queries starting with '#' search the workspace
    // symbol index and ONLY return symbols — not files/commands/branches.
    // This mirrors VS Code's "#" symbol picker style.
    if (query.startsWith('#')) {
      const symQuery = query.slice(1).trim();
      const syms = searchSymbols(symQuery, MAX_RESULTS);
      for (const sym of syms) {
        const style = SYMBOL_STYLE[sym.kind] || SYMBOL_STYLE.variable;
        const shortPath = sym.path.split('/').slice(-2).join('/');
        items.push({
          type: 'symbol',
          id: `sym:${sym.path}:${sym.from}`,
          icon: style.icon,
          iconColor: style.color,
          title: sym.name,
          subtitle: `${style.label} · ${shortPath}`,
          score: sym.score || 1,
          indices: [],
          action: () => {
            onOpenFile?.(sym.path);
            // After the file opens, scroll to symbol position. We rely on
            // the editor's own restoration; jumplist push is handled by
            // the editor's tab-change effect.
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                const editorEvent = new CustomEvent('hexis:jump-to-pos', {
                  detail: { path: sym.path, from: sym.from, to: sym.to },
                });
                window.dispatchEvent(editorEvent);
              });
            });
          },
        });
      }
      return items.sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS);
    }

    // Commands
    for (const cmd of COMMANDS) {
      const { match, score, indices } = fuzzyMatch(query, cmd.title);
      if (match) {
        items.push({
          type: 'command',
          id: cmd.id,
          icon: cmd.icon,
          title: cmd.title,
          subtitle: cmd.shortcut || '',
          score: score + 2, // slight boost for commands when no query
          indices,
          action: () => onCommand?.(cmd.id),
        });
      }
    }

    // Files
    for (const file of files) {
      const label = file.name || file.path.split('/').pop();
      const { match, score, indices } = fuzzyMatch(query, label);
      // Also try matching against full path
      const pathMatch = fuzzyMatch(query, file.path);
      const best = pathMatch.score > score ? pathMatch : { match, score, indices };

      if (best.match) {
        items.push({
          type: 'file',
          id: `file:${file.path}`,
          icon: '\uD83D\uDCC4',
          title: label,
          subtitle: file.path,
          score: best.score,
          indices: best === pathMatch ? [] : best.indices, // only highlight on title
          action: () => onOpenFile?.(file.path),
        });
      }
    }

    // Git branches (exclude current)
    const branchList = (branches || []).filter(b => {
      const name = typeof b === 'string' ? b : b?.name;
      return name && name !== currentBranch;
    });
    for (const branch of branchList) {
      const branchName = typeof branch === 'string' ? branch : branch?.name || '';
      const { match, score, indices } = fuzzyMatch(query, branchName);
      if (match) {
        items.push({
          type: 'branch',
          id: `branch:${branchName}`,
          icon: '\u2387',
          title: branchName,
          subtitle: 'Switch branch',
          score: score,
          indices,
          action: () => {
            checkoutBranch(branchName);
            onClose?.();
          },
        });
      }
    }

    // Sort by score descending, then alphabetically
    items.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (a.title || '').localeCompare(b.title || '');
    });

    return items.slice(0, MAX_RESULTS);
  }, [query, files, branches, currentBranch, onCommand, onOpenFile, checkoutBranch, onClose, searchSymbols]);

  // Clamp selection when results change
  useEffect(() => {
    if (selectedIndex >= results.length) {
      setSelectedIndex(Math.max(0, results.length - 1));
    }
  }, [results.length]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const item = listRef.current.children[selectedIndex];
    if (item) {
      item.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  // Execute selected result
  const executeSelected = useCallback(() => {
    const item = results[selectedIndex];
    if (!item) return;
    item.action();
    if (item.type !== 'branch') {
      onClose?.();
    }
  }, [results, selectedIndex, onClose]);

  // Keyboard navigation
  const handleKeyDown = useCallback((e) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(i => Math.min(i + 1, results.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(i => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        executeSelected();
        break;
      case 'Escape':
        e.preventDefault();
        onClose?.();
        break;
      default:
        break;
    }
  }, [results.length, executeSelected, onClose]);

  if (!open) return null;

  const typeLabel = { command: 'Command', file: 'File', branch: 'Branch' };
  const typeColor = { command: W.accent, file: W.textDim, branch: W.textMuted };

  return (
    <div
      className="fixed inset-0 z-[999] flex items-start justify-center"
      style={{ paddingTop: 'min(20vh, 140px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0"
        style={{
          background: 'rgba(0, 0, 0, 0.6)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
        }}
      />

      {/* Palette */}
      <div
        style={{
          position: 'relative',
          width: 550,
          maxHeight: 400,
          background: W.bg0,
          border: '1px solid rgba(139, 148, 158, 0.15)',
          borderRadius: 12,
          boxShadow: '0 24px 80px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(139, 148, 158, 0.05)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          animation: 'cmdPaletteIn 0.15s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        {/* Search input */}
        <div
          style={{
            padding: '14px 16px',
            borderBottom: '1px solid rgba(139, 148, 158, 0.08)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <Icon name="search" size={W.iconMd} color={W.textGhost} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0); }}
            onKeyDown={handleKeyDown}
            placeholder="Type a command, file, or branch..."
            spellCheck={false}
            autoComplete="off"
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: W.text,
              fontSize: 14,
              fontFamily: '"JetBrains Mono", "Fira Code", monospace',
              caretColor: W.accent,
              letterSpacing: '0.01em',
            }}
          />
          <kbd
            style={{
              padding: '2px 6px',
              fontSize: 10,
              fontFamily: '"JetBrains Mono", monospace',
              color: W.textGhost,
              background: 'rgba(139, 148, 158, 0.06)',
              border: '1px solid rgba(139, 148, 158, 0.1)',
              borderRadius: 4,
              flexShrink: 0,
            }}
          >
            ESC
          </kbd>
        </div>

        {/* Results list */}
        <div
          ref={listRef}
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '4px 0',
          }}
        >
          {results.length === 0 && (
            <div
              style={{
                padding: '24px 16px',
                textAlign: 'center',
                color: W.textGhost,
                fontSize: 13,
                fontFamily: '"JetBrains Mono", monospace',
              }}
            >
              {query ? 'No results found' : 'Start typing to search...'}
            </div>
          )}

          {results.map((item, i) => {
            const isSelected = i === selectedIndex;
            return (
              <div
                key={item.id}
                onClick={() => { setSelectedIndex(i); item.action(); if (item.type !== 'branch') onClose?.(); }}
                onMouseEnter={() => setSelectedIndex(i)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 16px',
                  cursor: 'pointer',
                  background: isSelected ? 'rgba(240, 160, 48, 0.08)' : 'transparent',
                  borderLeft: isSelected ? `2px solid ${W.accent}` : '2px solid transparent',
                  transition: 'background 0.1s, border-color 0.1s',
                }}
              >
                {/* Icon — Codicon name (string) or a symbol SVG (file results) */}
                <span style={{
                  width: W.iconMd,
                  height: W.iconMd,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  color: isSelected ? W.accent : W.textDim,
                }}>
                  {typeof item.icon === 'string' && item.icon.length > 2
                    ? <Icon name={item.icon} size={W.icon} color="inherit" />
                    : item.icon}
                </span>

                {/* Title + subtitle */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontFamily: '"JetBrains Mono", monospace',
                      color: isSelected ? W.text : W.textDim,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      transition: 'color 0.1s',
                    }}
                  >
                    <HighlightedText text={item.title} indices={item.indices} />
                  </div>
                  {item.subtitle && (
                    <div
                      style={{
                        fontSize: 11,
                        color: W.textGhost,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        marginTop: 1,
                        fontFamily: '"JetBrains Mono", monospace',
                      }}
                    >
                      {item.subtitle}
                    </div>
                  )}
                </div>

                {/* Type badge */}
                <span
                  style={{
                    fontSize: 9,
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    color: typeColor[item.type],
                    background: `${typeColor[item.type]}15`,
                    padding: '2px 6px',
                    borderRadius: 4,
                    flexShrink: 0,
                  }}
                >
                  {typeLabel[item.type]}
                </span>
              </div>
            );
          })}
        </div>

        {/* Footer hint */}
        <div
          style={{
            padding: '8px 16px',
            borderTop: '1px solid rgba(139, 148, 158, 0.06)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            fontSize: 10,
            color: W.textMuted,
            fontFamily: '"JetBrains Mono", monospace',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <kbd style={kbdStyle}>{'\u2191'}</kbd>
            <kbd style={kbdStyle}>{'\u2193'}</kbd>
            <span>navigate</span>
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <kbd style={kbdStyle}>{'\u21B5'}</kbd>
            <span>select</span>
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <kbd style={kbdStyle}>esc</kbd>
            <span>close</span>
          </span>
          <span style={{ marginLeft: 'auto', color: W.textGhost }}>
            {results.length} result{results.length !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {/* Animation keyframes */}
      <style>{`
        @keyframes cmdPaletteIn {
          from {
            opacity: 0;
            transform: translateY(-8px) scale(0.98);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
      `}</style>
    </div>
  );
}

const kbdStyle = {
  padding: '1px 4px',
  fontSize: 9,
  color: W.textGhost,
  background: 'rgba(139, 148, 158, 0.06)',
  border: '1px solid rgba(139, 148, 158, 0.1)',
  borderRadius: 3,
  lineHeight: '14px',
};
