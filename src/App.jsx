import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import HexCanvas from './components/HexGrid/HexCanvas.jsx';
import EditorPanel from './components/Editor/EditorPanel.jsx';
import SearchPanel from './components/search/SearchPanel.jsx';
import BookmarksPanel from './components/panels/BookmarksPanel.jsx';
import LocalHistoryPanel from './components/panels/LocalHistoryPanel.jsx';
import GitPanel from './components/GitPanel/GitPanel.jsx';
import AIPanel from './components/AIPanel/AIPanel.jsx';
import HistoryTimeline from './components/Timeline/HistoryTimeline.jsx';
import TerminalPanel from './components/Terminal/TerminalPanel.jsx';
import CommandPalette from './components/CommandPalette/CommandPalette.jsx';
import DockContainer from './components/dock/DockContainer.jsx';
import DockPanel from './components/dock/DockPanel.jsx';
import { useEditorStore } from './stores/editorStore.js';
import { useWorkspaceStore } from './stores/workspaceStore.js';
import WelcomeScreen from './components/WelcomeScreen.jsx';
import { useGitStore } from './stores/gitStore.js';
import { useAgentStore, AGENT_ROLES } from './stores/agentStore.js';
import { useTestStore } from './stores/testStore.js';
import { usePrefsStore } from './stores/prefsStore.js';
import { usePanelStore } from './stores/panelStore.js';
import TaskBoard from './components/TaskBoard/TaskBoard.jsx';
import Onboarding from './components/Onboarding/Onboarding.jsx';
import { MenuBar } from './components/MenuBar/MenuBar.jsx';
import { W } from './theme/window-tokens.js';

const IS_TAURI = typeof window !== 'undefined' && window.__TAURI_INTERNALS__;

/** Shorten a path to its last two segments for menu display. */
function shortTail(path) {
  const parts = String(path).replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 2) return path;
  return '…/' + parts.slice(-2).join('/');
}

export default function App() {
  const [files, setFiles] = useState([]);
  const [groups, setGroups] = useState([]);
  const [selectedCell, setSelectedCell] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const workspace = useWorkspaceStore(s => s.current);
  const workspaceResolved = useWorkspaceStore(s => s.resolved);
  const resolveWorkspace = useWorkspaceStore(s => s.resolveInitial);
  const setWorkspace = useWorkspaceStore(s => s.setWorkspace);
  const [hoveredFileInfo, setHoveredFileInfo] = useState(null);
  const [selectedBeeId, setSelectedBeeId] = useState(null);
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);

  const togglePanel = usePanelStore(s => s.toggleVisible);
  const panels = usePanelStore(s => s.panels);

  const openFile = useEditorStore(s => s.openFile);
  const activeTab = useEditorStore(s => s.activeTab);
  const tabs = useEditorStore(s => s.tabs);
  const currentBranch = useGitStore(s => s.currentBranch);
  const fetchStatus = useGitStore(s => s.fetchStatus);
  const getFileStatus = useGitStore(s => s.getFileStatus);
  const modified = useGitStore(s => s.modified);
  const staged = useGitStore(s => s.staged);
  const untracked = useGitStore(s => s.untracked);

  const onAgentEvent = useAgentStore(s => s.onAgentEvent);
  const activeAgentTask = useAgentStore(s => s.activeTask);
  const cellActivity = useAgentStore(s => s.cellActivity);
  const activeAgents = useAgentStore(s => s.agents);
  const pendingPlan = useAgentStore(s => s.pendingPlan);

  const testResults = useTestStore(s => s.results);
  const testRunning = useTestStore(s => s.running);
  const runTests = useTestStore(s => s.runTests);
  const fetchLastTestResults = useTestStore(s => s.fetchLastResults);

  const onboarded = usePrefsStore(s => s.onboarded);
  const autoSave = usePrefsStore(s => s.autoSave);
  const setPref = usePrefsStore(s => s.setPref);
  const recentWorkspaces = useWorkspaceStore(s => s.recent);

  const lastClickRef = useRef({ time: 0, path: null });

  // Command palette handler
  const handleCommand = useCallback((commandId) => {
    const gitStore = useGitStore.getState();
    const editorStore = useEditorStore.getState();

    switch (commandId) {
      case 'git:commit':
        usePanelStore.getState().showPanel('git');
        break;
      case 'git:push':
        gitStore.push();
        break;
      case 'git:pull':
        gitStore.pull();
        break;
      case 'git:ship-it':
        gitStore.shipIt();
        break;
      case 'git:stash':
        gitStore.stashPush();
        break;
      case 'git:create-branch':
        usePanelStore.getState().showPanel('git');
        break;
      case 'ai:new-task':
        usePanelStore.getState().showPanel('ai');
        break;
      case 'view:git-panel':
        togglePanel('git');
        break;
      case 'view:ai-panel':
        togglePanel('ai');
        break;
      case 'view:timeline':
        togglePanel('timeline');
        break;
      case 'file:save':
        if (editorStore.activeTab) editorStore.saveFile(editorStore.activeTab);
        break;
      case 'file:close-tab':
        if (editorStore.activeTab) editorStore.closeTab(editorStore.activeTab);
        break;
      default:
        break;
    }
  }, [togglePanel]);

  // ─── Menu bar action router ────────────────────────────────────────
  // Every menu item action ID lands here. Keep this list in sync with
  // the menuStructure memo below.
  const handleMenuAction = useCallback(async (actionId) => {
    const ed = useEditorStore.getState();
    const ws = useWorkspaceStore.getState();

    // Recent workspace open: "file:openRecent:<path>"
    if (actionId.startsWith('file:openRecent:')) {
      const path = actionId.slice('file:openRecent:'.length);
      ws.setWorkspace(path);
      return;
    }

    switch (actionId) {
      // ─── File ───
      case 'file:openFolder': {
        const path = await ws.pickFolder();
        if (path) ws.setWorkspace(path);
        break;
      }
      case 'file:save':
        if (ed.activeTab) ed.saveFile(ed.activeTab);
        break;
      case 'file:saveAll':
        ed.saveAll();
        break;
      case 'file:toggleAutoSave':
        setPref('autoSave', !usePrefsStore.getState().autoSave);
        break;
      case 'file:closeTab':
        if (ed.activeTab) ed.closeTab(ed.activeTab);
        break;
      case 'file:closeAllTabs':
        ed.closeAll();
        break;
      case 'file:closeFolder':
        ws.setWorkspace(null);
        setWorkspace(null);
        ed.closeAll();
        break;
      case 'file:exit':
        if (IS_TAURI) {
          try {
            const { getCurrentWindow } = await import('@tauri-apps/api/window');
            getCurrentWindow().close();
          } catch (err) { console.error(err); }
        } else {
          window.close();
        }
        break;

      // ─── Edit ───
      case 'edit:undo': document.execCommand('undo'); break;
      case 'edit:redo': document.execCommand('redo'); break;
      case 'edit:cut': document.execCommand('cut'); break;
      case 'edit:copy': document.execCommand('copy'); break;
      case 'edit:paste': document.execCommand('paste'); break;
      case 'edit:find':
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true }));
        break;
      case 'edit:findInFiles':
        usePanelStore.getState().showPanel('search');
        break;
      case 'edit:rename':
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2' }));
        break;

      // ─── Selection ───
      case 'selection:selectAll':
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }));
        break;
      case 'selection:expand':
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true }));
        break;
      case 'selection:shrink':
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true }));
        break;

      // ─── View ───
      case 'view:commandPalette':
        setCmdPaletteOpen(true);
        break;
      case 'view:outline':
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true, shiftKey: true }));
        break;
      case 'view:search':          togglePanel('search'); break;
      case 'view:git':             togglePanel('git'); break;
      case 'view:ai':              togglePanel('ai'); break;
      case 'view:bookmarks':       togglePanel('bookmarks'); break;
      case 'view:history':         togglePanel('history'); break;
      case 'view:terminal':        togglePanel('terminal'); break;
      case 'view:timeline':        togglePanel('timeline'); break;
      case 'view:tasks':           togglePanel('taskboard'); break;
      case 'view:toggleFullscreen':
        if (IS_TAURI) {
          try {
            const { getCurrentWindow } = await import('@tauri-apps/api/window');
            const w = getCurrentWindow();
            const fs = await w.isFullscreen();
            await w.setFullscreen(!fs);
          } catch (err) { console.error(err); }
        }
        break;

      // ─── Go ───
      case 'go:back':
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true }));
        break;
      case 'go:forward':
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true }));
        break;
      case 'go:toLine':
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true }));
        break;
      case 'go:toDefinition':
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F12' }));
        break;
      case 'go:peekDefinition':
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F12', altKey: true }));
        break;
      case 'go:fileFinder':
        setCmdPaletteOpen(true);
        break;
      case 'go:workspaceSymbols':
        setCmdPaletteOpen(true);
        // After it mounts, seed a '#' prefix
        requestAnimationFrame(() => {
          const evt = new CustomEvent('hexis:palette-seed', { detail: { prefix: '#' } });
          window.dispatchEvent(evt);
        });
        break;
      case 'go:nextBookmark':
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', ctrlKey: true, shiftKey: true }));
        break;
      case 'go:prevBookmark':
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', ctrlKey: true, altKey: true }));
        break;
      case 'go:toggleBookmark':
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', ctrlKey: true }));
        break;

      // ─── Run ───
      case 'run:tests':            runTests(); break;

      // ─── AI ───
      case 'ai:newTask':
        usePanelStore.getState().showPanel('ai');
        break;
      case 'ai:inlineEdit':
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
        break;

      // ─── Help ───
      case 'help:about':
        alert('Hexis — Honeycomb hex-grid AI-native IDE\nv0.1.0');
        break;
      case 'help:welcome':
        usePrefsStore.getState().resetOnboarding();
        break;
      case 'help:shortcuts':
        alert(
          'Keyboard shortcuts\n\n' +
          'Ctrl+K — Command palette (or AI edit in editor)\n' +
          'Ctrl+Shift+F — Workspace search\n' +
          'Ctrl+Shift+O — Toggle outline\n' +
          'Ctrl+G — Go to line\n' +
          'Ctrl+F2 — Toggle bookmark\n' +
          'F12 — Go to definition\n' +
          'Alt+F12 — Peek definition\n' +
          'F2 — Rename symbol\n' +
          'Alt+← / Alt+→ — Jumplist back / forward\n' +
          'Alt+↑ / Alt+↓ — Grow / shrink selection'
        );
        break;

      default:
        console.warn('[menu] unknown action', actionId);
    }
  }, [togglePanel, setPref, setWorkspace, runTests]);

  // ─── Menu structure ────────────────────────────────────────────────
  // Memoized so the MenuBar doesn't re-render on unrelated state.
  const menuStructure = useMemo(() => [
    {
      label: 'File',
      items: [
        { id: 'file:openFolder', label: 'Open Folder…', shortcut: 'Ctrl+O', mnemonic: 'O' },
        {
          label: 'Open Recent',
          mnemonic: 'R',
          enabled: recentWorkspaces.length > 0,
          submenu: recentWorkspaces.length > 0
            ? recentWorkspaces.map((p) => ({
                id: `file:openRecent:${p}`,
                label: p.split(/[\\/]/).filter(Boolean).pop() || p,
                shortcut: shortTail(p),
              }))
            : [{ id: 'noop', label: '(no recent workspaces)', enabled: false }],
        },
        { separator: true },
        { id: 'file:save', label: 'Save', shortcut: 'Ctrl+S', mnemonic: 'S', enabled: tabs.some((t) => t.dirty) },
        { id: 'file:saveAll', label: 'Save All', shortcut: 'Ctrl+K S', mnemonic: 'l', enabled: tabs.some((t) => t.dirty) },
        { separator: true },
        { id: 'file:toggleAutoSave', label: 'Auto Save', mnemonic: 'A', checked: autoSave },
        { separator: true },
        { id: 'file:closeTab', label: 'Close Editor', shortcut: 'Ctrl+W', enabled: !!activeTab },
        { id: 'file:closeAllTabs', label: 'Close All Editors', enabled: tabs.length > 0 },
        { id: 'file:closeFolder', label: 'Close Folder', enabled: !!workspace },
        { separator: true },
        { id: 'file:exit', label: 'Exit', shortcut: 'Alt+F4', mnemonic: 'x' },
      ],
    },
    {
      label: 'Edit',
      items: [
        { id: 'edit:undo', label: 'Undo', shortcut: 'Ctrl+Z', mnemonic: 'U' },
        { id: 'edit:redo', label: 'Redo', shortcut: 'Ctrl+Y', mnemonic: 'R' },
        { separator: true },
        { id: 'edit:cut', label: 'Cut', shortcut: 'Ctrl+X', mnemonic: 't' },
        { id: 'edit:copy', label: 'Copy', shortcut: 'Ctrl+C', mnemonic: 'C' },
        { id: 'edit:paste', label: 'Paste', shortcut: 'Ctrl+V', mnemonic: 'P' },
        { separator: true },
        { id: 'edit:find', label: 'Find', shortcut: 'Ctrl+F', mnemonic: 'F' },
        { id: 'edit:findInFiles', label: 'Find in Files', shortcut: 'Ctrl+Shift+F', mnemonic: 'i' },
        { separator: true },
        { id: 'edit:rename', label: 'Rename Symbol', shortcut: 'F2', mnemonic: 'e' },
      ],
    },
    {
      label: 'Selection',
      items: [
        { id: 'selection:selectAll', label: 'Select All', shortcut: 'Ctrl+A', mnemonic: 'A' },
        { separator: true },
        { id: 'selection:expand', label: 'Expand Selection', shortcut: 'Alt+↑', mnemonic: 'E' },
        { id: 'selection:shrink', label: 'Shrink Selection', shortcut: 'Alt+↓', mnemonic: 'S' },
      ],
    },
    {
      label: 'View',
      items: [
        { id: 'view:commandPalette', label: 'Command Palette…', shortcut: 'Ctrl+K', mnemonic: 'C' },
        { separator: true },
        { id: 'view:outline', label: 'Outline', shortcut: 'Ctrl+Shift+O', mnemonic: 'O', checked: panels.editor?.visible },
        { id: 'view:search', label: 'Search', shortcut: 'Ctrl+Shift+F', mnemonic: 'S', checked: panels.search?.visible },
        { id: 'view:git', label: 'Source Control', shortcut: 'Ctrl+G', mnemonic: 'G', checked: panels.git?.visible },
        { id: 'view:ai', label: 'AI Agents', shortcut: 'Ctrl+I', mnemonic: 'A', checked: panels.ai?.visible },
        { id: 'view:bookmarks', label: 'Bookmarks', mnemonic: 'B', checked: panels.bookmarks?.visible },
        { id: 'view:history', label: 'Local History', mnemonic: 'H', checked: panels.history?.visible },
        { id: 'view:terminal', label: 'Terminal', shortcut: 'Ctrl+`', mnemonic: 'T', checked: panels.terminal?.visible },
        { id: 'view:timeline', label: 'Git Timeline', shortcut: 'Ctrl+T', mnemonic: 'i', checked: panels.timeline?.visible },
        { id: 'view:tasks', label: 'Tasks', shortcut: 'Ctrl+B', mnemonic: 'k', checked: panels.taskboard?.visible },
        { separator: true },
        { id: 'view:toggleFullscreen', label: 'Toggle Full Screen', shortcut: 'F11', mnemonic: 'F' },
      ],
    },
    {
      label: 'Go',
      items: [
        { id: 'go:back', label: 'Back', shortcut: 'Alt+←', mnemonic: 'B' },
        { id: 'go:forward', label: 'Forward', shortcut: 'Alt+→', mnemonic: 'F' },
        { separator: true },
        { id: 'go:fileFinder', label: 'Go to File…', shortcut: 'Ctrl+P', mnemonic: 'F' },
        { id: 'go:workspaceSymbols', label: 'Go to Symbol in Workspace…', shortcut: 'Ctrl+T', mnemonic: 'S' },
        { id: 'view:outline', label: 'Go to Symbol in File…', shortcut: 'Ctrl+Shift+O', mnemonic: 'y' },
        { separator: true },
        { id: 'go:toDefinition', label: 'Go to Definition', shortcut: 'F12', mnemonic: 'D' },
        { id: 'go:peekDefinition', label: 'Peek Definition', shortcut: 'Alt+F12', mnemonic: 'P' },
        { separator: true },
        { id: 'go:toLine', label: 'Go to Line…', shortcut: 'Ctrl+G', mnemonic: 'L' },
        { separator: true },
        { id: 'go:toggleBookmark', label: 'Toggle Bookmark', shortcut: 'Ctrl+F2', mnemonic: 'k' },
        { id: 'go:nextBookmark', label: 'Next Bookmark', shortcut: 'Ctrl+Shift+F2', mnemonic: 'N' },
        { id: 'go:prevBookmark', label: 'Previous Bookmark', shortcut: 'Ctrl+Alt+F2', mnemonic: 'r' },
      ],
    },
    {
      label: 'Run',
      items: [
        { id: 'run:tests', label: 'Run Tests', mnemonic: 'T', enabled: !testRunning },
      ],
    },
    {
      label: 'AI',
      items: [
        { id: 'ai:newTask', label: 'New AI Task…', mnemonic: 'N' },
        { id: 'ai:inlineEdit', label: 'Inline Edit (selection)', shortcut: 'Ctrl+K', mnemonic: 'I' },
        { separator: true },
        { id: 'view:ai', label: 'Show AI Agents Panel', mnemonic: 'A' },
      ],
    },
    {
      label: 'Help',
      items: [
        { id: 'help:welcome', label: 'Welcome', mnemonic: 'W' },
        { id: 'help:shortcuts', label: 'Keyboard Shortcuts', mnemonic: 'K' },
        { separator: true },
        { id: 'help:about', label: 'About Hexis', mnemonic: 'A' },
      ],
    },
  ], [recentWorkspaces, autoSave, tabs, activeTab, workspace, panels, testRunning]);

  // Resolve which workspace to open on first launch (Tauri only —
  // web mode is locked to whatever the server was started with).
  useEffect(() => {
    resolveWorkspace();
  }, [resolveWorkspace]);

  // Load project. Re-runs whenever the workspace changes (Tauri folder
  // switch). Does nothing while no workspace is selected — the welcome
  // screen takes over the UI in that case.
  useEffect(() => {
    if (!workspaceResolved) return;
    if (IS_TAURI && !workspace) {
      // No workspace yet — welcome screen will render. Stop loading.
      setLoading(false);
      return;
    }

    async function load() {
      try {
        setLoading(true);
        setError(null);
        if (IS_TAURI) {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('scan_project', { path: workspace });
          setFiles(await invoke('get_files'));
          setGroups(await invoke('get_groups'));
        } else {
          const res = await fetch('/api/graph');
          const data = await res.json();

          // Map Nebula API format → Hexis format
          const mappedFiles = (data.nodes || []).map(n => ({
            path: n.id,
            name: n.label || n.id.split('/').pop(),
            extension: n.id.includes('.') ? n.id.split('.').pop() : '',
            group_path: n.groupPath?.length > 0 ? n.groupPath[n.groupPath.length - 1] : (n.section || '.'),
            size_bytes: 0,
            is_landmark: n.label === 'index' || n.label === 'main' || n.label === 'App' || n.label === 'README' || n.label === 'mod' || n.type === 'index',
            is_test: n.id.includes('.test.') || n.id.includes('.spec.') || n.id.includes('__tests__'),
            is_config: ['json', 'yaml', 'yml', 'toml', 'env'].includes(n.id.split('.').pop()),
            gitStatus: null,
          }));

          const mappedGroups = (data.clusters || []).map(c => ({
            path: c.id,
            name: c.label || c.id.split('/').pop(),
            parent_path: c.id.includes('/') ? c.id.slice(0, c.id.lastIndexOf('/')) : null,
            depth: (c.id.match(/\//g) || []).length,
          }));

          setFiles(mappedFiles);
          setGroups(mappedGroups);
        }
        setLoading(false);
        // Fetch git status after project loads
        fetchStatus();
      } catch (err) {
        setError(err.message || 'Failed to load project');
        setLoading(false);
      }
    }
    load();
  }, [workspace, workspaceResolved]);

  // Fetch cached test results on load
  useEffect(() => {
    fetchLastTestResults();
  }, []);

  // Show/hide editor panel based on whether tabs exist
  useEffect(() => {
    if (tabs.length > 0) {
      usePanelStore.getState().showPanel('editor');
    } else {
      usePanelStore.getState().hidePanel('editor');
    }
  }, [tabs.length]);

  // Refresh git status periodically
  useEffect(() => {
    const interval = setInterval(fetchStatus, 10000);
    return () => clearInterval(interval);
  }, []);

  // SSE listener for agent events
  useEffect(() => {
    if (IS_TAURI) return; // Tauri uses its own event system
    const es = new EventSource('/events');
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        // Route agent events to the agent store
        if (data.type?.startsWith('agent_') || data.type?.startsWith('plan_') ||
            data.type?.startsWith('task_') || data.type?.startsWith('subtask_') ||
            data.type === 'tokens_update') {
          onAgentEvent(data);
        }
      } catch { /* ignore parse errors */ }
    };
    return () => es.close();
  }, []);

  // Enrich files with git status for the hex grid (memoized to prevent layout recalc on unrelated re-renders)
  const enrichedFiles = useMemo(() => files.map(f => ({
    ...f,
    gitStatus: getFileStatus(f.path),
  })), [files, modified, staged, untracked]);

  // Single click = select + open file + auto-expand editor if collapsed
  const handleCellClick = useCallback((filePath) => {
    setSelectedCell(filePath || null);
    if (filePath) {
      openFile(filePath);
      const ps = usePanelStore.getState();
      if (ps.panels.editor?.edgeCollapsed) ps.toggleEdgeCollapse('editor');
      ps.showPanel('editor');
      ps.focusPanel('editor');
    }
  }, [openFile]);

  // Double click = zoom to cell (file already open from single click)
  const handleCellDoubleClick = useCallback((filePath) => {
    if (filePath) {
      setSelectedCell(filePath);
    }
  }, []);

  // Keyboard
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') setSelectedCell(null);
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (activeTab) useEditorStore.getState().saveFile(activeTab);
      }
      // Ctrl+K: toggle command palette — UNLESS the editor has focus, in
      // which case Ctrl+K means "AI inline edit on selection" and the
      // EditorPanel handler takes it.
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        const editorFocused = document.activeElement?.closest?.('.cm-editor');
        if (!editorFocused) {
          e.preventDefault();
          setCmdPaletteOpen(p => !p);
        }
      }
      // Ctrl+G: toggle git panel
      if ((e.metaKey || e.ctrlKey) && e.key === 'g') {
        e.preventDefault();
        togglePanel('git');
      }
      // Ctrl+I: toggle AI panel
      if ((e.metaKey || e.ctrlKey) && e.key === 'i') {
        e.preventDefault();
        togglePanel('ai');
      }
      // Ctrl+T: toggle timeline
      if ((e.metaKey || e.ctrlKey) && e.key === 't') {
        e.preventDefault();
        togglePanel('timeline');
      }
      // Ctrl+B: toggle task board
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        togglePanel('taskboard');
      }
      // Ctrl+`: toggle terminal
      if ((e.metaKey || e.ctrlKey) && e.key === '`') {
        e.preventDefault();
        togglePanel('terminal');
      }
      // Ctrl+Shift+F: toggle workspace search
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
        e.preventDefault();
        usePanelStore.getState().showPanel('search');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeTab, togglePanel]);

  const changedCount = modified.length + staged.length + untracked.length;

  // Welcome screen: shown when running under Tauri with no workspace
  // selected yet (fresh install, no CLI arg, no env var, no recents).
  if (IS_TAURI && workspaceResolved && !workspace) {
    return <WelcomeScreen onOpen={(path) => setWorkspace(path)} />;
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen" style={{ background: W.bg0, color: W.red }}>
        <div className="text-center">
          <div className="text-[22px] font-semibold mb-3" style={{ color: W.text }}>⬡ Hexis</div>
          <div className="text-[16px] mb-2">Failed to load project</div>
          <div className="text-[13px] opacity-60 mb-4">{error}</div>
          {IS_TAURI && (
            <button
              onClick={() => setWorkspace(null)}
              style={{
                padding: '8px 16px',
                background: W.accent,
                border: 'none',
                borderRadius: 4,
                color: W.bg0,
                cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              Open another folder
            </button>
          )}
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen" style={{ background: W.bg0 }}>
        <div className="text-center">
          <div className="text-[22px] font-semibold mb-4" style={{ color: W.text }}>⬡ Hexis</div>
          <div className="text-[14px]" style={{ color: W.textDim }}>Building honeycomb...</div>
          <div className="mt-4 w-40 h-1 rounded-full overflow-hidden" style={{ background: 'rgba(139, 148, 158, 0.1)' }}>
            <div className="h-full rounded-full" style={{ background: W.accent, animation: 'loading 1.5s ease-in-out infinite', width: '40%' }} />
          </div>
          <style>{`@keyframes loading { 0% { transform: translateX(-100%); } 100% { transform: translateX(350%); } }`}</style>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-screen h-screen overflow-hidden flex flex-col" style={{ background: W.bg0 }}>
      {/* Native-style menu bar — File, Edit, View, Go, Run, AI, Help */}
      <MenuBar menus={menuStructure} onAction={handleMenuAction} />

      {/* DockContainer takes up the space above the status bar */}
      <div className="flex-1 min-h-0 relative">
        <DockContainer panels={[
          <DockPanel key="ai" id="ai" title="AI Agents" icon="🐝"><AIPanel /></DockPanel>,
          <DockPanel key="git" id="git" title="Source Control" icon="⎇"><GitPanel /></DockPanel>,
          <DockPanel key="search" id="search" title="Search" icon="⌕"><SearchPanel /></DockPanel>,
          <DockPanel key="bookmarks" id="bookmarks" title="Bookmarks" icon="☆"><BookmarksPanel /></DockPanel>,
          <DockPanel key="history" id="history" title="Local History" icon="◷"><LocalHistoryPanel /></DockPanel>,
          <DockPanel key="editor" id="editor" title="Editor"><EditorPanel /></DockPanel>,
          <DockPanel key="terminal" id="terminal" title="Terminal" icon=">_"><TerminalPanel /></DockPanel>,
          <DockPanel key="timeline" id="timeline" title="Timeline" icon="◷"><HistoryTimeline onSelectCommit={(hash) => console.log('commit:', hash)} /></DockPanel>,
          <DockPanel key="taskboard" id="taskboard" title="Tasks" icon="☰"><TaskBoard /></DockPanel>,
        ]}>
          <HexCanvas
            files={enrichedFiles}
            groups={groups}
            selectedCell={selectedCell}
            cellActivity={cellActivity}
            activeAgents={activeAgents}
            pendingPlan={pendingPlan}
            onCellClick={handleCellClick}
            onCellDoubleClick={handleCellDoubleClick}
            onBeeClick={(agentId) => setSelectedBeeId(agentId)}
            onCellHover={(fp) => {
              if (!fp) { setHoveredFileInfo(null); return; }
              const f = enrichedFiles.find(f => f.path === fp);
              if (f) setHoveredFileInfo(f);
              else setHoveredFileInfo(null);
            }}
          />
        </DockContainer>
      </div>

      {/* Command Palette */}
      <CommandPalette
        open={cmdPaletteOpen}
        onClose={() => setCmdPaletteOpen(false)}
        files={files}
        onOpenFile={openFile}
        onCommand={handleCommand}
      />

      {/* Hover info panel — unified window tokens, no brownish bleed */}
      {hoveredFileInfo && (
        <div className="fixed bottom-12 left-5 pointer-events-none" style={{ transition: 'opacity 0.15s ease', zIndex: 9999 }}>
          <div style={{
            width: 400,
            background: W.bg1,
            border: `1px solid ${W.border}`,
            borderRadius: W.radius3,
            boxShadow: W.shadow2,
            overflow: 'hidden',
          }}>
            <div style={{ padding: `${W.s4}px ${W.s5}px ${W.s4}px` }}>
              {/* Top accent line */}
              <div style={{ height: 2, background: `linear-gradient(90deg, ${W.accent}, ${W.accentSoft})`, marginBottom: W.s3, borderRadius: 1 }} />

              {/* Path breadcrumb */}
              <div style={{ display: 'flex', alignItems: 'center', gap: W.s2, fontSize: W.fontLg, marginBottom: W.s2 }}>
                {(hoveredFileInfo.group_path || '.').split('/').map((seg, i) => (
                  <span key={i} style={{ display: 'flex', alignItems: 'center', gap: W.s2 }}>
                    {i > 0 && <span style={{ color: W.accent, fontSize: W.fontSm }}>⬡</span>}
                    <span style={{ color: i === 0 ? W.textDim : W.textMuted, fontWeight: W.fontWeightSemi }}>{seg === '.' ? 'root' : seg}</span>
                  </span>
                ))}
              </div>

              {/* File name */}
              <div style={{ fontSize: 24, fontWeight: W.fontWeightBold, color: W.text, lineHeight: 1.15, marginBottom: 4 }}>
                {hoveredFileInfo.name.replace(/\.[^.]+$/, '')}
              </div>
              {hoveredFileInfo.extension && (
                <div style={{ fontSize: W.fontXl, color: W.textMuted, marginBottom: W.s3 }}>.{hoveredFileInfo.extension}</div>
              )}

              {/* Separator */}
              <div style={{ height: 1, background: W.border, marginBottom: W.s3 }} />

              {/* Details */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: W.s2, marginBottom: W.s3 }}>
                {hoveredFileInfo.is_landmark && (
                  <span style={{ padding: `${W.s1}px ${W.s3}px`, fontSize: W.fontMd, background: W.accentSoft, color: W.accent, borderRadius: W.radius1, fontWeight: W.fontWeightSemi }}>⬡ landmark</span>
                )}
                {hoveredFileInfo.gitStatus && hoveredFileInfo.gitStatus !== 'clean' && (
                  <span style={{
                    padding: `${W.s1}px ${W.s3}px`, fontSize: W.fontMd, borderRadius: W.radius1, fontWeight: W.fontWeightSemi,
                    background: hoveredFileInfo.gitStatus === 'modified' ? W.yellowBg : hoveredFileInfo.gitStatus === 'staged' ? W.greenBg : W.bg3,
                    color: hoveredFileInfo.gitStatus === 'modified' ? W.yellow : hoveredFileInfo.gitStatus === 'staged' ? W.green : W.textDim,
                  }}>{hoveredFileInfo.gitStatus}</span>
                )}
                {hoveredFileInfo.is_test && (
                  <span style={{ padding: `${W.s1}px ${W.s3}px`, fontSize: W.fontMd, background: W.purpleBg, color: W.purple, borderRadius: W.radius1, fontWeight: W.fontWeightSemi }}>test</span>
                )}
                {hoveredFileInfo.is_config && (
                  <span style={{ padding: `${W.s1}px ${W.s3}px`, fontSize: W.fontMd, background: W.blueBg, color: W.blue, borderRadius: W.radius1, fontWeight: W.fontWeightSemi }}>config</span>
                )}
              </div>

              {/* Full path */}
              <div style={{ fontSize: W.fontMd, fontFamily: W.fontMono, color: W.textMuted, wordBreak: 'break-all' }}>
                {hoveredFileInfo.path}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Bee info panel — shown when a bee is clicked */}
      <BeeInfoPanel
        agentId={selectedBeeId}
        activeTask={activeAgentTask}
        agents={activeAgents}
        onClose={() => setSelectedBeeId(null)}
      />

      {/* Status bar */}
      <div
        className="flex-shrink-0 h-8 flex items-center px-4 gap-4 text-[12px] z-40"
        style={{ background: W.bg1, borderTop: '1px solid rgba(139, 148, 158, 0.1)', color: W.textMuted }}
      >
        <span style={{ color: W.textDim }}>⬡ Hexis</span>

        {/* AI panel toggle */}
        <button
          className="flex items-center gap-1.5 px-2 py-0.5 rounded"
          style={{
            color: panels.ai?.visible ? W.accent : W.textDim,
            background: panels.ai?.visible ? W.accentSoft : 'transparent',
          }}
          onClick={() => togglePanel('ai')}
        >
          <span>🐝</span>
          <span style={{ fontWeight: 500 }}>AI</span>
          {activeAgentTask && !['done', 'error', 'cancelled'].includes(activeAgentTask.status) && (
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: W.accent, animation: 'pulse 1.5s infinite' }} />
          )}
        </button>

        {/* Git branch toggle */}
        <button
          className="flex items-center gap-1.5 px-2 py-0.5 rounded"
          style={{
            color: panels.git?.visible ? W.accent : W.textDim,
            background: panels.git?.visible ? W.accentSoft : 'transparent',
          }}
          onClick={() => togglePanel('git')}
        >
          <span>⎇</span>
          <span style={{ fontWeight: 500 }}>{currentBranch}</span>
          {changedCount > 0 && (
            <span className="px-1.5 rounded-full text-[10px] font-medium"
              style={{ background: W.accentHover, color: W.accent }}>
              {changedCount}
            </span>
          )}
        </button>

        {/* Timeline toggle */}
        <button
          className="flex items-center gap-1 px-2 py-0.5 rounded"
          style={{
            color: panels.timeline?.visible ? W.accent : W.textDim,
            background: panels.timeline?.visible ? W.accentSoft : 'transparent',
          }}
          onClick={() => togglePanel('timeline')}
        >
          <span style={{ fontSize: 10 }}>◷</span>
          <span style={{ fontWeight: 500 }}>History</span>
        </button>

        {/* Tasks toggle */}
        <button
          className="flex items-center gap-1 px-2 py-0.5 rounded"
          style={{
            color: panels.taskboard?.visible ? W.accent : W.textDim,
            background: panels.taskboard?.visible ? W.accentSoft : 'transparent',
          }}
          onClick={() => togglePanel('taskboard')}
        >
          <span style={{ fontSize: 10 }}>☰</span>
          <span style={{ fontWeight: 500 }}>Tasks</span>
        </button>

        {/* Terminal toggle */}
        <button
          className="flex items-center gap-1 px-2 py-0.5 rounded"
          style={{
            color: panels.terminal?.visible ? W.accent : W.textDim,
            background: panels.terminal?.visible ? W.accentSoft : 'transparent',
          }}
          onClick={() => togglePanel('terminal')}
        >
          <span style={{ fontSize: 11, fontFamily: '"JetBrains Mono", monospace' }}>&gt;_</span>
          <span style={{ fontWeight: 500 }}>Terminal</span>
        </button>

        {/* Test runner */}
        <button
          className="flex items-center gap-1.5 px-2 py-0.5 rounded"
          style={{
            color: testRunning
              ? W.accent
              : testResults?.failed > 0
                ? W.red
                : testResults?.total > 0
                  ? W.green
                  : W.textDim,
            background: testRunning
              ? W.accentSoft
              : testResults?.failed > 0
                ? 'rgba(239, 68, 68, 0.1)'
                : 'transparent',
          }}
          onClick={runTests}
          disabled={testRunning}
          title={testRunning ? 'Tests running...' : 'Click to run tests'}
        >
          {testRunning ? (
            <>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: W.accent, animation: 'pulse 1.5s infinite' }} />
              <span style={{ fontWeight: 500 }}>Running...</span>
            </>
          ) : testResults && testResults.total > 0 ? (
            <>
              <span style={{ fontWeight: 500 }}>
                {testResults.failed > 0
                  ? `✓ ${testResults.passed} / ✕ ${testResults.failed}`
                  : `Tests: ${testResults.passed} pass`
                }
              </span>
            </>
          ) : (
            <>
              <span style={{ fontSize: 10 }}>⬡</span>
              <span style={{ fontWeight: 500 }}>Tests</span>
            </>
          )}
        </button>

        {/* Workspace switcher (Tauri only — web is locked to one repo) */}
        {IS_TAURI && workspace && (
          <button
            className="flex items-center gap-1.5 px-2 py-0.5 rounded"
            style={{
              color: W.textDim,
              background: 'transparent',
              maxWidth: 220,
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 11,
            }}
            title={`Workspace: ${workspace}\nClick to switch`}
            onClick={async () => {
              const path = await useWorkspaceStore.getState().pickFolder();
              if (path) setWorkspace(path);
            }}
          >
            <span>⊞</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {workspace.split(/[\\/]/).filter(Boolean).pop() || workspace}
            </span>
          </button>
        )}

        <span>{files.length} files</span>
        {tabs.length > 0 && <span>{tabs.length} open</span>}

        {selectedCell && (
          <span className="ml-auto" style={{ color: W.accent, fontFamily: '"JetBrains Mono", monospace', fontSize: 11 }}>
            {selectedCell}
          </span>
        )}
      </div>

      {/* First-launch onboarding tutorial */}
      {!onboarded && <Onboarding />}
    </div>
  );
}

// ─── Bee Info Panel (click a bee to see its task) ─────────────────────────

function BeeInfoPanel({ agentId, activeTask, agents, onClose }) {
  if (!agentId) return null;
  const agent = agents?.find(a => a.id === agentId);
  if (!agent) return null;

  const role = AGENT_ROLES[agent.role] || AGENT_ROLES.coder;
  const statusColors = {
    running: W.accent,
    reading: W.blue,
    editing: W.teal,
    done: W.green,
    error: W.red,
  };
  const statusColor = statusColors[agent.status] || W.textDim;

  return (
    <div
      className="fixed top-16 right-5"
      style={{
        width: 380,
        background: W.bg1,
        border: `1px solid ${W.border}`,
        borderRadius: W.radius3,
        boxShadow: W.shadow2,
        animation: 'fadeIn 0.2s ease',
        zIndex: 9998,
      }}
    >
      {/* Header */}
      <div style={{
        padding: `${W.s3}px ${W.s4}px`,
        borderBottom: `1px solid ${W.border}`,
        background: W.bg2,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: W.s3 }}>
          <span style={{ fontSize: 22 }}>{role.icon}</span>
          <div>
            <div style={{ fontSize: W.fontXl, fontWeight: W.fontWeightBold, color: role.color, letterSpacing: '-0.01em' }}>
              {role.name}
            </div>
            <div style={{ fontSize: W.fontSm, color: W.textMuted, fontFamily: W.fontMono }}>
              {agent.id}
            </div>
          </div>
        </div>
        <button
          onClick={onClose}
          style={{
            background: 'transparent',
            border: 'none',
            color: W.textDim,
            fontSize: W.fontXl,
            cursor: 'pointer',
            padding: 4,
            lineHeight: 1,
          }}
        >✕</button>
      </div>

      {/* Content */}
      <div style={{ padding: `${W.s3}px ${W.s4}px` }}>
        {/* Status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: W.s2, marginBottom: W.s3 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: statusColor,
              boxShadow: `0 0 8px ${statusColor}`,
              animation: agent.status !== 'done' && agent.status !== 'error' ? 'pulse 1.5s infinite' : 'none',
            }}
          />
          <span style={{ fontSize: W.fontLg, fontWeight: W.fontWeightSemi, color: statusColor, textTransform: 'capitalize' }}>
            {agent.status}
          </span>
        </div>

        {/* Current file */}
        {agent.currentFile && (
          <div style={{ marginBottom: W.s3 }}>
            <div style={{ fontSize: W.fontXs, color: W.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
              Current file
            </div>
            <div style={{ fontSize: W.fontMd, fontFamily: W.fontMono, color: W.text, wordBreak: 'break-all' }}>
              {agent.currentFile}
            </div>
          </div>
        )}

        {/* Task context */}
        {activeTask?.prompt && (
          <div style={{ marginBottom: W.s3 }}>
            <div style={{ fontSize: W.fontXs, color: W.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
              Working on
            </div>
            <div style={{ fontSize: W.fontMd, color: W.textDim, lineHeight: '18px' }}>
              {activeTask.prompt.length > 200 ? activeTask.prompt.slice(0, 200) + '…' : activeTask.prompt}
            </div>
          </div>
        )}

        {/* Model + tokens */}
        <div style={{ display: 'flex', gap: W.s4, fontSize: W.fontSm, color: W.textMuted, paddingTop: W.s2, borderTop: `1px solid ${W.borderSubtle}` }}>
          {agent.model && (
            <div>
              <span style={{ textTransform: 'uppercase', letterSpacing: '0.05em', marginRight: 6 }}>Model</span>
              <span style={{ color: W.textDim, fontFamily: W.fontMono }}>{agent.model}</span>
            </div>
          )}
          {agent.tokensUsed > 0 && (
            <div>
              <span style={{ textTransform: 'uppercase', letterSpacing: '0.05em', marginRight: 6 }}>Tokens</span>
              <span style={{ color: W.textDim, fontFamily: W.fontMono }}>{agent.tokensUsed}</span>
            </div>
          )}
        </div>

        {/* Output summary */}
        {agent.output && (
          <div style={{ marginTop: W.s2, paddingTop: W.s2, borderTop: `1px solid ${W.borderSubtle}` }}>
            <div style={{ fontSize: W.fontXs, color: W.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
              Summary
            </div>
            <div style={{ fontSize: W.fontMd, color: W.textDim, lineHeight: '18px' }}>
              {agent.output}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
