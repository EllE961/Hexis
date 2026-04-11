/**
 * EditorPanel — CodeMirror 6 editor with tab bar.
 * Opens when a file is selected. Honey-themed.
 * Now a simple content component that fills its DockPanel parent.
 * Shows/hides via panelStore based on whether tabs exist.
 */

import { useRef, useEffect, useState, useCallback } from 'react';
import { useEditorStore } from '../../stores/editorStore.js';
import { useJumplistStore } from '../../stores/jumplistStore.js';
import { useSymbolIndexStore } from '../../stores/symbolIndexStore.js';
import { useBookmarksStore } from '../../stores/bookmarksStore.js';
import { useLspStore, lspConfigForExt } from '../../stores/lspStore.js';
import { usePrefsStore } from '../../stores/prefsStore.js';
import { W } from '../../theme/window-tokens.js';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import {
  stickyScroll,
  goToDefinitionKeymap,
  peekDefinitionExt,
  smartSelectionKeymap,
  localAutocomplete,
  indentGuides,
  bracketColorization,
  cursorReporter,
  outlineReporter,
  initialOutline,
} from './extensions.js';
import { SYMBOL_STYLE } from './symbols.js';
import OutlinePanel from './OutlinePanel.jsx';
import AiEditModal from './AiEditModal.jsx';
import { Icon } from '../common/Icon.jsx';
import { markdown } from '@codemirror/lang-markdown';
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { cpp } from '@codemirror/lang-cpp';
import { java } from '@codemirror/lang-java';
import { sql } from '@codemirror/lang-sql';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { go } from '@codemirror/lang-go';
import { sass } from '@codemirror/lang-sass';
import { less } from '@codemirror/lang-less';
import { php } from '@codemirror/lang-php';
import { StreamLanguage } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { csharp } from '@codemirror/legacy-modes/mode/clike';

// Build a file:// URI for an absolute path (handles Windows drive letters)
function toFileUri(absPath) {
  if (!absPath) return '';
  let p = String(absPath).replace(/\\/g, '/');
  if (!p.startsWith('/')) p = '/' + p;
  return `file://${p}`;
}

// Language extension by file extension
function getLanguage(ext) {
  switch (ext) {
    // JavaScript / TypeScript
    case 'js': case 'jsx': case 'mjs': return javascript({ jsx: true });
    case 'ts': case 'tsx': return javascript({ jsx: true, typescript: true });
    // Markup & Markdown
    case 'md': case 'mdx': return markdown();
    case 'html': case 'htm': return html();
    case 'xml': case 'svg': return xml();
    // Stylesheets
    case 'css': return css();
    case 'scss': return sass({ indented: false });
    case 'sass': return sass({ indented: true });
    case 'less': return less();
    // Data formats
    case 'json': return json();
    case 'yaml': case 'yml': return yaml();
    case 'toml': return StreamLanguage.define(toml);
    // Systems languages
    case 'rs': return rust();
    case 'go': return go();
    case 'c': case 'h': return cpp();
    case 'cpp': case 'cc': case 'cxx': case 'hpp': case 'hxx': return cpp();
    case 'java': return java();
    case 'cs': return StreamLanguage.define(csharp);
    // Scripting
    case 'py': case 'pyw': return python();
    case 'php': return php();
    // Database
    case 'sql': return sql();
    // Shell & DevOps
    case 'sh': case 'bash': case 'zsh': return StreamLanguage.define(shell);
    case 'dockerfile': return StreamLanguage.define(dockerFile);
    default: return [];
  }
}

// CodeMirror theme — structural colors from the active W theme.
// Syntax-highlighting hues stay stable (keyword red, string blue, etc.) because
// those are semantic, not structural.
const honeyTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '14px',
    background: W.bg0,
  },
  '.cm-content': {
    fontFamily: W.fontMono,
    padding: '16px 0',
    color: W.text,
    caretColor: W.blue,
    lineHeight: '1.6',
  },
  '.cm-gutters': {
    background: W.bg0,
    color: W.textGhost,
    border: 'none',
    borderRight: `1px solid ${W.border}`,
    minWidth: '48px',
  },
  '.cm-activeLineGutter': {
    background: W.blueBg,
    color: W.textDim,
  },
  '.cm-activeLine': {
    background: W.blueBg,
  },
  '.cm-cursor': {
    borderLeftColor: W.blue,
    borderLeftWidth: '2px',
  },
  '.cm-selectionBackground': {
    background: 'rgba(88, 166, 255, 0.2) !important',
  },
  '&.cm-focused .cm-selectionBackground': {
    background: 'rgba(88, 166, 255, 0.28) !important',
  },
  '.cm-matchingBracket': {
    background: W.blueBg,
    outline: `1px solid ${W.blue}`,
    borderRadius: '2px',
  },
  '.cm-searchMatch': {
    background: W.accentSoft,
    borderRadius: '2px',
  },
  '.cm-tooltip': {
    background: W.bg2,
    border: `1px solid ${W.border}`,
    color: W.text,
    borderRadius: '6px',
  },
  '.cm-scroller': {
    overflow: 'auto',
  },
  '.cm-line': {
    padding: '0 12px',
  },
  // Syntax highlighting — semantic hues (stable across themes)
  '.ͼb': { color: '#FF7B72' },       // keywords: soft red
  '.ͼc': { color: '#A5D6FF' },       // strings: light blue
  '.ͼd': { color: W.textDim },       // comments
  '.ͼe': { color: '#79C0FF' },       // numbers: blue
  '.ͼm': { color: '#D2A8FF' },       // property: purple
});

const EXPLORER_WIDTH_KEY = 'hexis-editor-explorer-width';
const EXPLORER_COLLAPSED_KEY = 'hexis-editor-explorer-collapsed';
const EXPLORER_WIDTH_DEFAULT = 240;
const EXPLORER_WIDTH_MIN = 180;
const EXPLORER_WIDTH_MAX = 500;

export default function EditorPanel({
  explorer,
}) {
  // `explorer` is an optional React element (the FileTreePanel) rendered
  // as a collapsible left sidebar. If not supplied, the editor fills its
  // whole DockPanel (legacy behaviour).
  const [explorerWidth, setExplorerWidth] = useState(() => {
    try {
      const raw = localStorage.getItem(EXPLORER_WIDTH_KEY);
      const n = raw ? parseInt(raw, 10) : EXPLORER_WIDTH_DEFAULT;
      return Number.isFinite(n) ? Math.max(EXPLORER_WIDTH_MIN, Math.min(EXPLORER_WIDTH_MAX, n)) : EXPLORER_WIDTH_DEFAULT;
    } catch { return EXPLORER_WIDTH_DEFAULT; }
  });
  const [explorerCollapsed, setExplorerCollapsed] = useState(() => {
    try { return localStorage.getItem(EXPLORER_COLLAPSED_KEY) === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(EXPLORER_WIDTH_KEY, String(explorerWidth)); } catch {}
  }, [explorerWidth]);
  useEffect(() => {
    try { localStorage.setItem(EXPLORER_COLLAPSED_KEY, explorerCollapsed ? '1' : '0'); } catch {}
  }, [explorerCollapsed]);

  // Listen for external toggle requests (e.g. View → Explorer / Ctrl+Shift+E)
  useEffect(() => {
    const onToggle = () => setExplorerCollapsed(c => !c);
    window.addEventListener('hexis:toggle-explorer', onToggle);
    return () => window.removeEventListener('hexis:toggle-explorer', onToggle);
  }, []);

  // Divider drag state
  const dividerDragRef = useRef(null);
  const onDividerDown = useCallback((e) => {
    dividerDragRef.current = { startX: e.clientX, startWidth: explorerWidth };
    e.preventDefault();
    const onMove = (ev) => {
      const d = dividerDragRef.current;
      if (!d) return;
      const next = Math.max(EXPLORER_WIDTH_MIN, Math.min(EXPLORER_WIDTH_MAX, d.startWidth + (ev.clientX - d.startX)));
      setExplorerWidth(next);
    };
    const onUp = () => {
      dividerDragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [explorerWidth]);
  const onDividerDouble = useCallback(() => setExplorerWidth(EXPLORER_WIDTH_DEFAULT), []);

  return <EditorPanelInner
    explorer={explorer}
    explorerWidth={explorerWidth}
    explorerCollapsed={explorerCollapsed}
    setExplorerCollapsed={setExplorerCollapsed}
    onDividerDown={onDividerDown}
    onDividerDouble={onDividerDouble}
  />;
}

function EditorPanelInner({ explorer, explorerWidth, explorerCollapsed, setExplorerCollapsed, onDividerDown, onDividerDouble }) {
  const tabs = useEditorStore(s => s.tabs);
  const activeTab = useEditorStore(s => s.activeTab);
  const closeTab = useEditorStore(s => s.closeTab);
  const closeAll = useEditorStore(s => s.closeAll);
  const closeOthers = useEditorStore(s => s.closeOthers);
  const closeToRight = useEditorStore(s => s.closeToRight);
  const setActiveTab = useEditorStore(s => s.setActiveTab);
  const [contextMenu, setContextMenu] = useState(null); // { x, y, path }
  const [outline, setOutline] = useState([]);
  const [breadcrumb, setBreadcrumb] = useState([]);
  // Outline panel is closed by default — users open it explicitly with
  // Ctrl+Shift+O or the toolbar toggle when they want the symbol tree.
  const [outlineOpen, setOutlineOpen] = useState(false);
  const upsertSymbols = useSymbolIndexStore(s => s.upsert);
  const toggleBookmark = useBookmarksStore(s => s.toggle);
  const nextBookmark = useBookmarksStore(s => s.next);
  const prevBookmark = useBookmarksStore(s => s.prev);
  const [gotoOpen, setGotoOpen] = useState(false);
  const [gotoValue, setGotoValue] = useState('');
  const [aiEdit, setAiEdit] = useState(null); // null | { filePath, text, before, after, from, to }

  // Jumplist
  const jumpPush = useJumplistStore(s => s.push);
  const jumpBack = useJumplistStore(s => s.back);
  const jumpForward = useJumplistStore(s => s.forward);
  const canBack = useJumplistStore(s => s.index > 0);
  const canForward = useJumplistStore(s => s.index < s.entries.length - 1);

  const editorRef = useRef(null);
  const viewRef = useRef(null);
  const saveTimerRef = useRef(null);
  // Compartment for LSP extension so it can be reconfigured when the
  // language server becomes ready asynchronously after the editor mounts.
  const lspCompartmentRef = useRef(null);
  const ensureLspServer = useLspStore(s => s.ensureServer);

  const activeFile = tabs.find(t => t.path === activeTab);

  // Push to jumplist whenever the active tab changes
  useEffect(() => {
    if (activeTab) jumpPush({ path: activeTab });
  }, [activeTab, jumpPush]);

  // Navigate via jumplist entry — open the file and (after mount) move to its line
  const goToJumpEntry = useCallback((entry) => {
    if (!entry) return;
    if (entry.path !== activeTab) {
      useEditorStore.getState().openFile(entry.path);
    }
    // Line/col restore happens after the editor re-mounts; we wait one frame
    requestAnimationFrame(() => {
      const view = viewRef.current;
      if (!view) return;
      if (entry.line != null) {
        const lineNum = Math.min(Math.max(1, entry.line + 1), view.state.doc.lines);
        const line = view.state.doc.line(lineNum);
        const pos = line.from + Math.min(entry.col || 0, line.length);
        view.dispatch({
          selection: { anchor: pos },
          effects: EditorView.scrollIntoView(pos, { y: 'center' }),
        });
      }
    });
  }, [activeTab]);

  // Global keybindings:
  //   Alt+Left/Right          — jumplist back/forward
  //   Ctrl+Shift+O            — toggle outline panel
  //   Ctrl+G                  — jump to line
  //   Ctrl+F2                 — toggle bookmark at cursor
  //   Ctrl+Shift+F2           — next bookmark
  //   Ctrl+Alt+F2             — previous bookmark
  useEffect(() => {
    const onKey = (e) => {
      if (e.altKey && !e.ctrlKey && !e.shiftKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        goToJumpEntry(jumpBack());
      } else if (e.altKey && !e.ctrlKey && !e.shiftKey && e.key === 'ArrowRight') {
        e.preventDefault();
        goToJumpEntry(jumpForward());
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'O' || e.key === 'o')) {
        e.preventDefault();
        setOutlineOpen((o) => !o);
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault();
        setGotoOpen(true);
        setGotoValue('');
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
        // Ctrl+K: AI inline edit on selection (or current line if none)
        const view = viewRef.current;
        if (!view || !activeTab) return;
        // Don't intercept if the command palette or some other modal
        // is already open — Ctrl+K is also the palette shortcut. We
        // only take over when the editor has focus.
        if (!view.hasFocus) return;
        e.preventDefault();
        const sel = view.state.selection.main;
        let from = sel.from, to = sel.to;
        if (from === to) {
          // No selection → pick the current line
          const line = view.state.doc.lineAt(from);
          from = line.from;
          to = line.to;
        }
        const text = view.state.sliceDoc(from, to);
        const CTX_CHARS = 1500;
        const before = view.state.sliceDoc(Math.max(0, from - CTX_CHARS), from);
        const after = view.state.sliceDoc(to, Math.min(view.state.doc.length, to + CTX_CHARS));
        setAiEdit({ filePath: activeTab, text, before, after, from, to });
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === 'F2') {
        e.preventDefault();
        const view = viewRef.current;
        if (!view || !activeTab) return;
        const pos = view.state.selection.main.head;
        const line = view.state.doc.lineAt(pos);
        toggleBookmark({
          path: activeTab,
          line: line.number - 1,
          col: pos - line.from,
          label: line.text.trim().slice(0, 60),
        });
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'F2') {
        e.preventDefault();
        const bm = nextBookmark();
        if (bm) goToJumpEntry(bm);
      } else if ((e.ctrlKey || e.metaKey) && e.altKey && e.key === 'F2') {
        e.preventDefault();
        const bm = prevBookmark();
        if (bm) goToJumpEntry(bm);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [jumpBack, jumpForward, goToJumpEntry, activeTab, toggleBookmark, nextBookmark, prevBookmark]);

  // Execute the goto-line dialog
  const handleGoto = useCallback(() => {
    const view = viewRef.current;
    if (!view) { setGotoOpen(false); return; }
    const match = gotoValue.trim().match(/^(\d+)(?::(\d+))?$/);
    if (!match) { setGotoOpen(false); return; }
    const lineNum = Math.max(1, Math.min(parseInt(match[1], 10), view.state.doc.lines));
    const col = match[2] ? Math.max(0, parseInt(match[2], 10) - 1) : 0;
    const line = view.state.doc.line(lineNum);
    const pos = line.from + Math.min(col, line.length);
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    });
    view.focus();
    setGotoOpen(false);
  }, [gotoValue]);

  // Listen for external jump-to-position requests (e.g. from the command
  // palette's workspace symbol picker). The palette fires a CustomEvent
  // with {path, from, to}; we wait for the corresponding tab to become
  // active, then dispatch the selection.
  useEffect(() => {
    const onJump = (e) => {
      const { path, from, to } = e.detail || {};
      if (!path) return;
      if (path !== activeTab) {
        // Tab will switch shortly; schedule the jump for the next effect
        pendingJumpRef.current = { path, from, to };
        return;
      }
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        selection: { anchor: from, head: to ?? from },
        effects: EditorView.scrollIntoView(from, { y: 'center' }),
      });
      view.focus();
    };
    window.addEventListener('hexis:jump-to-pos', onJump);
    return () => window.removeEventListener('hexis:jump-to-pos', onJump);
  }, [activeTab]);

  // After a tab change, flush any pending jump-to-position request
  const pendingJumpRef = useRef(null);
  useEffect(() => {
    const pending = pendingJumpRef.current;
    if (!pending || pending.path !== activeTab) return;
    pendingJumpRef.current = null;
    requestAnimationFrame(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        selection: { anchor: pending.from, head: pending.to ?? pending.from },
        effects: EditorView.scrollIntoView(pending.from, { y: 'center' }),
      });
      view.focus();
    });
  }, [activeTab, outline]);

  // Jump to a symbol in the current file (from outline / breadcrumb click)
  const handleOutlineJump = useCallback((item) => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      selection: { anchor: item.nameFrom, head: item.nameTo },
      effects: EditorView.scrollIntoView(item.nameFrom, { y: 'center' }),
    });
    view.focus();
    // Push current location into jumplist before jumping
    const line = view.state.doc.lineAt(item.nameFrom);
    jumpPush({
      path: activeTab,
      line: line.number - 1,
      col: item.nameFrom - line.from,
      label: item.name,
    });
  }, [activeTab, jumpPush]);

  // Create/recreate editor when active tab changes. This component only
  // mounts while the editor panel is visible (DockPanel gates on .visible),
  // so we don't need a separate panelVisible check — mount == visible.
  useEffect(() => {
    if (!activeTab || !editorRef.current) return;

    // Always read the file FRESH from the store — the closure-captured
    // `activeFile` from render can be stale if the tab was just added via
    // an async fetch that completed between render and effect.
    const file = useEditorStore.getState().tabs.find(t => t.path === activeTab);
    if (!file) return;

    const ext = file.extension || '';
    const lang = getLanguage(ext);

    // LSP compartment — starts empty; we populate it asynchronously
    // if a language server is available for this file's language.
    const lspCompartment = new Compartment();
    lspCompartmentRef.current = lspCompartment;

    const view = new EditorView({
      state: EditorState.create({
        doc: file.content,
        extensions: [
          basicSetup,
          ...(Array.isArray(lang) ? lang : [lang]),
          honeyTheme,
          lspCompartment.of([]),

          // ─── Hexis power extensions ───
          stickyScroll,
          goToDefinitionKeymap,
          peekDefinitionExt,
          smartSelectionKeymap,
          localAutocomplete,
          indentGuides,
          bracketColorization,
          cursorReporter((pos, chain) => setBreadcrumb(chain)),
          outlineReporter((items) => {
            setOutline(items);
            upsertSymbols(activeTab, items);
          }),

          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const newContent = update.state.doc.toString();
              useEditorStore.getState().updateContent(activeTab, newContent);

              // Auto-save (respects usePrefsStore.autoSave + autoSaveDelay)
              clearTimeout(saveTimerRef.current);
              const prefs = usePrefsStore.getState();
              if (prefs.autoSave) {
                saveTimerRef.current = setTimeout(() => {
                  useEditorStore.getState().saveFile(activeTab);
                }, prefs.autoSaveDelay || 2000);
              }
            }
          }),
          // Ctrl+S instant save
          EditorView.domEventHandlers({
            keydown(event) {
              if ((event.metaKey || event.ctrlKey) && event.key === 's') {
                event.preventDefault();
                useEditorStore.getState().saveFile(activeTab);
                return true;
              }
            },
          }),
        ],
      }),
      parent: editorRef.current,
    });

    viewRef.current = view;

    // Seed initial outline + breadcrumb synchronously (outlineReporter
    // fires on doc change; on first mount there's no change, so prime it)
    const seeded = initialOutline(view.state);
    setOutline(seeded);
    setBreadcrumb([]);
    upsertSymbols(activeTab, seeded);

    // ─── Async LSP activation ───
    // If this file's extension has a configured language server AND the
    // binary is installed on PATH, spawn it (or reuse the cached instance)
    // and reconfigure the compartment to add the LSP extension.
    //
    // This is fire-and-forget: if the server isn't installed or init
    // fails, the editor keeps working with Layer 1 features.
    const lspConfig = lspConfigForExt(ext);
    if (lspConfig) {
      (async () => {
        try {
          const client = await ensureLspServer(lspConfig, null /* TODO: workspace */);
          if (!client || viewRef.current !== view) return; // tab changed
          const { languageServerSupport } = await import('@codemirror/lsp-client');
          const uri = toFileUri(activeTab);
          const lspExt = languageServerSupport(client, uri, lspConfig.languageId);
          view.dispatch({ effects: lspCompartment.reconfigure(lspExt) });
        } catch (err) {
          console.warn('[LSP] activation failed:', err);
        }
      })();
    }

    // On first mount the dock panel may still be laying out, giving the
    // editor parent a 0x0 rect. CodeMirror virtualizes line rendering based
    // on that measurement, so without this it draws nothing on first open.
    // Force a remeasure after layout settles.
    const raf = requestAnimationFrame(() => {
      if (viewRef.current === view) view.requestMeasure();
    });

    // CRITICAL: the cleanup MUST destroy the view. In StrictMode React
    // double-invokes effects (setup → cleanup → setup) to expose leaks.
    // If we don't destroy here, the second setup orphans the first view and
    // CodeMirror's internal state gets confused about the parent element,
    // resulting in an empty editor on the first open.
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(saveTimerRef.current);
      view.destroy();
      if (viewRef.current === view) viewRef.current = null;
    };
  }, [activeTab]);

  return (
    <div
      className="flex-1 flex min-w-0 min-h-0"
      style={{ background: W.bg1 }}
    >
      {/* ─── Embedded Explorer sidebar ─── */}
      {explorer && !explorerCollapsed && (
        <div
          style={{
            width: explorerWidth,
            minWidth: EXPLORER_WIDTH_MIN,
            maxWidth: EXPLORER_WIDTH_MAX,
            flexShrink: 0,
            borderRight: `1px solid ${W.border}`,
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            background: W.bg1,
          }}
        >
          {explorer}
        </div>
      )}
      {explorer && !explorerCollapsed && (
        <div
          onPointerDown={onDividerDown}
          onDoubleClick={onDividerDouble}
          title="Drag to resize • Double-click to reset"
          style={{
            width: 4,
            cursor: 'col-resize',
            background: W.border,
            flexShrink: 0,
          }}
        />
      )}
      {explorer && explorerCollapsed && (
        <button
          onClick={() => setExplorerCollapsed(false)}
          title="Show explorer"
          style={{
            width: 22,
            flexShrink: 0,
            background: W.bg2,
            border: 'none',
            borderRight: `1px solid ${W.border}`,
            color: W.textDim,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            paddingTop: 8,
            fontSize: 14,
          }}
        >
          ▸
        </button>
      )}

      {/* ─── Editor content (tabs + nav + CM6 + outline) ─── */}
      <div
        className="flex-1 flex flex-col min-w-0 min-h-0"
        style={{ background: W.bg1 }}
      >
      {/* Tab bar */}
      <div
        className="flex-shrink-0 flex items-center overflow-x-auto"
        style={{
          borderBottom: `1px solid ${W.border}`,
          background: W.bg2,
        }}
      >
        {tabs.map(tab => (
          <button
            key={tab.path}
            className="flex items-center gap-2 px-4 py-2.5 text-[13px] relative flex-shrink-0"
            style={{
              color: tab.path === activeTab ? W.text : W.textMuted,
              background: tab.path === activeTab ? W.bg0 : 'transparent',
              borderRight: `1px solid ${W.borderSubtle}`,
            }}
            onClick={() => setActiveTab(tab.path)}
            onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, path: tab.path }); }}
          >
            <span style={{ fontWeight: tab.path === activeTab ? 600 : 400 }}>
              {tab.name}
            </span>
            {tab.dirty && (
              <span
                className="w-2 h-2 rounded-full"
                style={{ background: W.accent }}
                title="Unsaved changes"
              />
            )}
            <span
              className="ml-1 p-0.5 rounded"
              style={{ color: W.textGhost }}
              onClick={(e) => { e.stopPropagation(); closeTab(tab.path); }}
            >
              <Icon name="close" size={W.iconSm} />
            </span>
            {tab.path === activeTab && (
              <div
                className="absolute bottom-0 left-2 right-2 h-[2px] rounded-full"
                style={{ background: W.accent }}
              />
            )}
          </button>
        ))}
      </div>

      {/* Navigation strip: jumplist back/forward + file path + outline toggle */}
      {activeFile && (
        <div
          className="flex-shrink-0 flex items-center gap-2 px-2 py-1"
          style={{
            background: W.bg0,
            borderBottom: `1px solid ${W.borderSubtle}`,
          }}
        >
          {/* Back */}
          <button
            title="Back (Alt+Left)"
            disabled={!canBack}
            onClick={() => goToJumpEntry(jumpBack())}
            style={{
              background: 'transparent',
              border: 'none',
              color: canBack ? W.textDim : W.textGhost,
              cursor: canBack ? 'pointer' : 'default',
              padding: 3,
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <Icon name="arrow-left" size={W.icon} />
          </button>
          {/* Forward */}
          <button
            title="Forward (Alt+Right)"
            disabled={!canForward}
            onClick={() => goToJumpEntry(jumpForward())}
            style={{
              background: 'transparent',
              border: 'none',
              color: canForward ? W.textDim : W.textGhost,
              cursor: canForward ? 'pointer' : 'default',
              padding: 3,
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <Icon name="arrow-right" size={W.icon} />
          </button>

          {/* Path + cursor breadcrumb chain */}
          <div
            className="flex-1 flex items-center gap-1 overflow-hidden font-mono"
            style={{ fontSize: 11, color: W.textGhost, minWidth: 0 }}
          >
            <span style={{ color: W.textMuted }}>{activeFile.path}</span>
            {activeFile.dirty && (
              <span style={{ color: W.accent, marginLeft: 6 }}>●</span>
            )}
            {breadcrumb.length > 0 && (
              <>
                <span style={{ color: W.textGhost, margin: '0 4px' }}>│</span>
                {breadcrumb.map((b, i) => {
                  const style = SYMBOL_STYLE[b.kind] || SYMBOL_STYLE.variable;
                  return (
                    <span
                      key={i}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 2, whiteSpace: 'nowrap' }}
                    >
                      {i > 0 && <span style={{ color: W.textGhost, margin: '0 2px' }}>›</span>}
                      <span style={{ color: style.color, fontWeight: 700 }}>{style.icon}</span>
                      <button
                        onClick={() => handleOutlineJump(b)}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: i === breadcrumb.length - 1 ? W.text : W.textMuted,
                          fontSize: 'inherit',
                          fontFamily: 'inherit',
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
              </>
            )}
          </div>

          {/* Outline toggle */}
          <button
            title="Toggle outline (Ctrl+Shift+O)"
            onClick={() => setOutlineOpen((o) => !o)}
            style={{
              background: outlineOpen ? W.accentBg : 'transparent',
              border: 'none',
              color: outlineOpen ? W.accent : W.textDim,
              cursor: 'pointer',
              padding: 3,
              display: 'flex',
              alignItems: 'center',
              borderRadius: W.radius1,
            }}
          >
            <Icon name="list-unordered" size={W.icon} />
          </button>
        </div>
      )}

      {/* Editor area + outline panel side-by-side */}
      <div className="flex-1 flex min-h-0">
        <div ref={editorRef} className="flex-1 overflow-hidden" style={{ position: 'relative' }} />
        {outlineOpen && activeFile && (
          <div
            style={{
              width: 260,
              flexShrink: 0,
              borderLeft: `1px solid ${W.border}`,
            }}
          >
            <OutlinePanel
              outline={outline}
              breadcrumb={breadcrumb}
              onJump={handleOutlineJump}
              onClose={() => setOutlineOpen(false)}
            />
          </div>
        )}
      </div>

      {/* Ctrl+K AI inline edit */}
      {aiEdit && (
        <AiEditModal
          open={!!aiEdit}
          selection={aiEdit}
          onClose={() => setAiEdit(null)}
          onApply={(newCode) => {
            const view = viewRef.current;
            if (!view) return;
            view.dispatch({
              changes: { from: aiEdit.from, to: aiEdit.to, insert: newCode },
              selection: { anchor: aiEdit.from, head: aiEdit.from + newCode.length },
            });
            view.focus();
          }}
        />
      )}

      {/* Ctrl+G jump to line dialog */}
      {gotoOpen && (
        <>
          <div className="fixed inset-0 z-50" style={{ background: 'rgba(0,0,0,0.4)' }} onClick={() => setGotoOpen(false)} />
          <div
            className="fixed z-50"
            style={{
              top: '20%',
              left: '50%',
              transform: 'translateX(-50%)',
              background: W.bg1,
              border: `1px solid ${W.borderHi}`,
              borderRadius: W.radius2,
              boxShadow: W.shadow2,
              padding: W.s3,
              width: 320,
            }}
          >
            <div style={{ fontSize: W.fontSm, color: W.textMuted, marginBottom: W.s2 }}>
              Go to line (line or line:col)
            </div>
            <input
              autoFocus
              value={gotoValue}
              onChange={(e) => setGotoValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleGoto();
                if (e.key === 'Escape') setGotoOpen(false);
              }}
              placeholder="e.g. 42 or 42:15"
              style={{
                width: '100%',
                background: W.bg0,
                border: `1px solid ${W.border}`,
                borderRadius: W.radius1,
                color: W.text,
                fontSize: W.fontMd,
                padding: `${W.s2}px ${W.s3}px`,
                outline: 'none',
                fontFamily: '"JetBrains Mono", monospace',
              }}
            />
          </div>
        </>
      )}

      {/* Tab context menu */}
      {contextMenu && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setContextMenu(null)} />
          <div
            className="fixed z-50 rounded-lg py-1 min-w-[160px]"
            style={{
              left: contextMenu.x,
              top: contextMenu.y,
              background: W.bg2,
              border: `1px solid ${W.border}`,
              boxShadow: W.shadow2,
            }}
          >
            {[
              { label: 'Close', action: () => closeTab(contextMenu.path) },
              { label: 'Close Others', action: () => closeOthers(contextMenu.path) },
              { label: 'Close to the Right', action: () => closeToRight(contextMenu.path) },
              { label: 'Close All', action: () => closeAll() },
            ].map(item => (
              <button
                key={item.label}
                className="w-full text-left px-4 py-2 text-[13px]"
                style={{ color: W.textDim }}
                onMouseEnter={e => e.currentTarget.style.background = W.bg3}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                onClick={() => { item.action(); setContextMenu(null); }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </>
      )}
      </div>
    </div>
  );
}
