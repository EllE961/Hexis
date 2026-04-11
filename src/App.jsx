import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import HexCanvas from './components/HexGrid/HexCanvas.jsx';
import EditorPanel from './components/Editor/EditorPanel.jsx';
import SearchPanel from './components/search/SearchPanel.jsx';
import BookmarksPanel from './components/panels/BookmarksPanel.jsx';
import FileTreePanel from './components/panels/FileTreePanel.jsx';
import LocalHistoryPanel from './components/panels/LocalHistoryPanel.jsx';
import GitPanel from './components/GitPanel/GitPanel.jsx';
import AIPanel from './components/AIPanel/AIPanel.jsx';
import ChatPanel from './components/ChatPanel/ChatPanel.jsx';
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
import { useChatStore } from './stores/chatStore.js';
import { useTestStore } from './stores/testStore.js';
import { usePrefsStore } from './stores/prefsStore.js';
import { usePanelStore } from './stores/panelStore.js';
import TaskBoard from './components/TaskBoard/TaskBoard.jsx';
import Onboarding from './components/Onboarding/Onboarding.jsx';
import { MenuBar } from './components/MenuBar/MenuBar.jsx';
import { ContextMenu } from './components/ContextMenu/ContextMenu.jsx';
import { buildContextMenuItems } from './components/ContextMenu/hexContextMenu.jsx';
import NameInputModal from './components/modals/NameInputModal.jsx';
import ConfirmModal from './components/modals/ConfirmModal.jsx';
import { useClipboardStore } from './stores/clipboardStore.js';
import { useFileOpsHistoryStore, MAX_CONTENT_BYTES as HISTORY_MAX_CONTENT_BYTES } from './stores/fileOpsHistoryStore.js';
import { useBookmarksStore } from './stores/bookmarksStore.js';
import { useLocalHistoryStore } from './stores/localHistoryStore.js';
import { useTaskStore } from './stores/taskStore.js';
import { useSelectionStore } from './stores/selectionStore.js';
import { useLayoutStateStore } from './stores/layoutStateStore.js';
import { Icon } from './components/common/Icon.jsx';
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
  const selectedCellSet = useSelectionStore(s => s.selected);

  const lastClickRef = useRef({ time: 0, path: null });
  // Imperative handle on the hex canvas — used for post-drop glow triggers
  // and View → Re-optimize Hex Layout.
  const hexCanvasRef = useRef(null);

  // Hard refresh: clear saved layout state and force a ground-up recompute.
  // Bound to Ctrl+Shift+L and the View menu item.
  const hardRefreshLayout = useCallback(() => {
    useLayoutStateStore.getState().clear();
    hexCanvasRef.current?.hardRefresh();
  }, []);

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

  // ─── Live workspace refresh (debounced) ───────────────────────────
  // Declared EARLY (before any callback or effect that uses it) so
  // hoisted references in handleMenuAction, the fs_watcher effect,
  // handleCellDrop, etc. don't hit a temporal-dead-zone error.
  //
  // Called after any file-system change (ours or external) to re-fetch
  // files/groups and let the hex grid re-layout. Debounced 200ms so
  // bursts coalesce into a single re-scan.
  const refreshTimerRef = useRef(null);
  const refreshWorkspace = useCallback(() => {
    clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(async () => {
      try {
        if (IS_TAURI) {
          const { invoke } = await import('@tauri-apps/api/core');
          const wsPath = useWorkspaceStore.getState().current;
          if (wsPath) {
            await invoke('scan_project', { path: wsPath });
            setFiles(await invoke('get_files'));
            setGroups(await invoke('get_groups'));
          }
        } else {
          const res = await fetch('/api/graph');
          const data = await res.json();
          const mappedFiles = (data.nodes || []).map((n) => ({
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
          const mappedGroups = (data.clusters || []).map((c) => ({
            path: c.id,
            name: c.label || c.id.split('/').pop(),
            parent_path: c.id.includes('/') ? c.id.slice(0, c.id.lastIndexOf('/')) : null,
            depth: (c.id.match(/\//g) || []).length,
          }));
          setFiles(mappedFiles);
          setGroups(mappedGroups);
        }
        // Also refresh git status so new/deleted files get their
        // untracked/modified/staged borders + badges immediately
        // instead of waiting for the 10s periodic poll.
        try { useGitStore.getState().fetchStatus(); } catch {}
      } catch (err) {
        console.warn('[refreshWorkspace]', err);
      }
    }, 200);
  }, []);

  // ─── Optimistic local state patches ──────────────────────────────
  // These let create/delete/move ops update the hex grid instantly
  // without waiting for a full workspace re-scan. The backend call
  // runs in parallel; on failure we rollback via refreshWorkspace.
  const optimisticallyAddFile = useCallback((filePath, groupPath) => {
    const name = filePath.split('/').pop();
    const extension = name.includes('.') ? name.split('.').pop() : '';
    setFiles(prev => {
      if (prev.some(f => f.path === filePath)) return prev;
      return [...prev, {
        path: filePath,
        name,
        extension,
        group_path: groupPath || '.',
        size_bytes: 0,
        is_landmark: false,
        is_test: false,
        is_config: ['json', 'yaml', 'yml', 'toml', 'env'].includes(extension),
        gitStatus: 'untracked',
      }];
    });
    // Fetch git status so the new file picks up its proper state
    try { useGitStore.getState().fetchStatus(); } catch {}
  }, []);

  const optimisticallyAddFolder = useCallback((folderPath, parentPath) => {
    setGroups(prev => {
      if (prev.some(g => g.path === folderPath)) return prev;
      const depth = folderPath.split('/').length - 1;
      return [...prev, {
        path: folderPath,
        name: folderPath.split('/').pop(),
        parent_path: parentPath && parentPath !== '.' ? parentPath : null,
        depth,
      }];
    });
  }, []);

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
      case 'file:newFile': {
        // Default target: the group of the currently-selected file, else root
        const targetGroup = (() => {
          if (!selectedCell) return '.';
          const f = files.find(x => x.path === selectedCell);
          return f?.group_path || '.';
        })();
        setNameModal({
          title: targetGroup !== '.' ? `New file in ${targetGroup}` : 'New file at workspace root',
          initial: '',
          placeholder: 'filename.ext',
          onSubmit: async (name) => {
            const filePath = targetGroup !== '.' ? `${targetGroup}/${name}` : name;
            const result = await ed.createFile(filePath);
            if (result?.ok === false) return result.error || 'Create failed';
            optimisticallyAddFile(filePath, targetGroup);
            hexCanvasRef.current?.markRecentDrop(filePath, 'file');
            hexCanvasRef.current?.zoomToItem(filePath, 'file');
            setNameModal(null);
          },
        });
        break;
      }
      case 'file:newFolder': {
        const targetParent = (() => {
          if (!selectedCell) return '.';
          const f = files.find(x => x.path === selectedCell);
          return f?.group_path || '.';
        })();
        setNameModal({
          title: targetParent !== '.' ? `New folder in ${targetParent}` : 'New folder at workspace root',
          initial: '',
          placeholder: 'folder-name',
          onSubmit: async (name) => {
            const folderPath = targetParent !== '.' ? `${targetParent}/${name}` : name;
            const result = await ed.createFolder(folderPath);
            if (result?.ok === false) return result.error || 'Create folder failed';
            optimisticallyAddFolder(folderPath, targetParent);
            hexCanvasRef.current?.markRecentDrop(folderPath, 'group');
            hexCanvasRef.current?.zoomToItem(folderPath, 'group');
            setNameModal(null);
          },
        });
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
      case 'edit:undo': {
        // File-ops undo if editor not focused, CodeMirror text undo if it is
        const editorFocused = document.activeElement?.closest?.('.cm-editor');
        if (editorFocused) {
          document.execCommand('undo');
        } else {
          const ok = await useFileOpsHistoryStore.getState().undo(historyDeps);
          if (ok) refreshWorkspace();
        }
        break;
      }
      case 'edit:redo': {
        const editorFocused = document.activeElement?.closest?.('.cm-editor');
        if (editorFocused) {
          document.execCommand('redo');
        } else {
          const ok = await useFileOpsHistoryStore.getState().redo(historyDeps);
          if (ok) refreshWorkspace();
        }
        break;
      }
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
      case 'view:editor':           togglePanel('editor'); break;
      case 'view:outline':
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true, shiftKey: true }));
        break;
      case 'view:explorer':
        // Explorer now lives INSIDE the editor as a collapsible sidebar.
        // Make sure the editor panel is visible, then dispatch the toggle.
        usePanelStore.getState().showPanel('editor');
        window.dispatchEvent(new Event('hexis:toggle-explorer'));
        break;
      case 'view:search':          togglePanel('search'); break;
      case 'view:git':             togglePanel('git'); break;
      case 'view:ai':              togglePanel('ai'); break;
      case 'view:chat':            togglePanel('chat'); break;
      case 'view:bookmarks':       togglePanel('bookmarks'); break;
      case 'view:history':         togglePanel('history'); break;
      case 'view:terminal':        togglePanel('terminal'); break;
      case 'view:timeline':        togglePanel('timeline'); break;
      case 'view:tasks':           togglePanel('taskboard'); break;
      case 'view:reoptimizeLayout':
        hardRefreshLayout();
        break;
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
        { id: 'file:newFile', label: 'New File…', shortcut: 'Ctrl+N', mnemonic: 'N' },
        { id: 'file:newFolder', label: 'New Folder…', shortcut: 'Ctrl+Shift+N', mnemonic: 'F' },
        { separator: true },
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
        { id: 'view:editor', label: 'Editor', shortcut: 'Ctrl+E', mnemonic: 'd', checked: panels.editor?.visible },
        { id: 'view:explorer', label: 'Explorer', shortcut: 'Ctrl+Shift+E', mnemonic: 'E' },
        { id: 'view:outline', label: 'Outline', shortcut: 'Ctrl+Shift+O', mnemonic: 'O', checked: panels.editor?.visible },
        { id: 'view:search', label: 'Search', shortcut: 'Ctrl+Shift+F', mnemonic: 'S', checked: panels.search?.visible },
        { id: 'view:git', label: 'Source Control', shortcut: 'Ctrl+G', mnemonic: 'G', checked: panels.git?.visible },
        { id: 'view:chat', label: 'Chat', shortcut: 'Ctrl+Shift+C', mnemonic: 'C', checked: panels.chat?.visible },
        { id: 'view:ai', label: 'AI Agents', shortcut: 'Ctrl+I', mnemonic: 'A', checked: panels.ai?.visible },
        { id: 'view:bookmarks', label: 'Bookmarks', mnemonic: 'B', checked: panels.bookmarks?.visible },
        { id: 'view:history', label: 'Local History', mnemonic: 'H', checked: panels.history?.visible },
        { id: 'view:terminal', label: 'Terminal', shortcut: 'Ctrl+`', mnemonic: 'T', checked: panels.terminal?.visible },
        { id: 'view:timeline', label: 'Git Timeline', shortcut: 'Ctrl+T', mnemonic: 'i', checked: panels.timeline?.visible },
        { id: 'view:tasks', label: 'Tasks', shortcut: 'Ctrl+B', mnemonic: 'k', checked: panels.taskboard?.visible },
        { separator: true },
        { id: 'view:reoptimizeLayout', label: 'Re-optimize Hex Layout', shortcut: 'Ctrl+Shift+L', mnemonic: 'L' },
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

  // Sync the layout-state store with the active workspace so each
  // workspace gets its own persisted group positions + ring sizes.
  useEffect(() => {
    useLayoutStateStore.getState().setWorkspace(workspace || null);
  }, [workspace]);

  // Sync the file-ops history store with the active workspace so
  // undo/redo stacks are per-workspace and survive reloads.
  useEffect(() => {
    useFileOpsHistoryStore.getState().setWorkspace(workspace || null);
  }, [workspace]);

  // Sync the per-project stores so bookmarks / snapshots / tasks don't
  // leak across open-folder switches.
  useEffect(() => {
    useBookmarksStore.getState().setWorkspace(workspace || null);
    useLocalHistoryStore.getState().setWorkspace(workspace || null);
    useTaskStore.getState().setWorkspace(workspace || null);
  }, [workspace]);

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

  // Auto-show the editor panel whenever a tab opens, but DON'T
  // auto-hide it when tabs drop to zero — the user may have pinned
  // it open intentionally (e.g. to browse the embedded file tree,
  // or because they toggled it via Ctrl+E / the View menu). The
  // old "hide when empty" behavior was silently resetting the
  // saved `visible:true` state on every reload, so localStorage
  // could never persist an "editor is open" preference.
  useEffect(() => {
    if (tabs.length > 0) {
      usePanelStore.getState().showPanel('editor');
    }
  }, [tabs.length]);

  // Refresh git status periodically
  useEffect(() => {
    const interval = setInterval(fetchStatus, 10000);
    return () => clearInterval(interval);
  }, []);

  // Tauri fs_watcher — starts watching the current workspace; listens
  // for hexis://fs_change events and triggers the debounced refresh.
  useEffect(() => {
    if (!IS_TAURI || !workspace) return;
    let unlisten = null;
    let cancelled = false;
    (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const { listen } = await import('@tauri-apps/api/event');
        await invoke('start_fs_watcher', { path: workspace });
        if (cancelled) return;
        unlisten = await listen('hexis://fs_change', () => {
          refreshWorkspace();
        });
      } catch (err) {
        console.warn('[fs_watcher]', err);
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) { try { unlisten(); } catch {} }
      (async () => {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('stop_fs_watcher');
        } catch {}
      })();
    };
  }, [workspace, refreshWorkspace]);

  // SSE listener for agent events + live file-system changes.
  // When the server's chokidar watcher fires, we receive a batch and
  // debounce-refresh the workspace so the hex grid reflects external
  // edits, git operations, build artifacts, etc.
  useEffect(() => {
    if (IS_TAURI) return; // Tauri uses its own event system
    const es = new EventSource('/events');
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        // Server reports the real repo path on connect → scope any
        // per-project stores (chats, etc.) to it so switching
        // HEXIS_TARGET doesn't leak history between projects.
        if (data.type === 'connected' && data.repoPath) {
          useChatStore.getState().setRepoScope(data.repoPath);
        }
        // Route agent events to the agent store (also handles chat_* events
        // via the bee/run bridge so chat turns spawn bees on the hex grid).
        if (data.type?.startsWith('agent_') || data.type?.startsWith('plan_') ||
            data.type?.startsWith('task_') || data.type?.startsWith('subtask_') ||
            data.type?.startsWith('chat_') || data.type?.startsWith('research_') ||
            data.type === 'tokens_update') {
          onAgentEvent(data);
        }
        // Chat stream tokens + lifecycle → chat store (per-chat streamBuffer).
        if (data.chatId && (data.type === 'agent_stream' || data.type?.startsWith('chat_'))) {
          useChatStore.getState().onChatEvent(data);
        }
        // File-system changes → debounced workspace refresh
        if (data.type === 'fileChange' || data.type === 'fs_change' || data.type === 'batch') {
          refreshWorkspace();
        }
      } catch { /* ignore parse errors */ }
    };
    return () => es.close();
  }, [refreshWorkspace]);

  // Enrich files with git status. Critically, we use `files` as the
  // ONLY source of identity — when git status changes, we mutate the
  // existing array's elements in place rather than creating a new
  // array reference. This keeps `computeLayout()` from running on
  // every git fetch: HexCanvas's layout effect has `[files, groups]`
  // in its deps, so it only re-runs when the array IDENTITY changes.
  // Since we return the same array reference (just mutated per-item),
  // the layout stays stable while cells still pick up the new
  // gitStatus via the ref during the render pass.
  const enrichedFiles = useMemo(() => {
    for (const f of files) f.gitStatus = getFileStatus(f.path);
    return files;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, modified, staged, untracked]);

  // Single click = select + open file + auto-expand editor if collapsed.
  // Ctrl/Cmd+click toggles the file in the multi-selection set.
  // Shift+click is reserved for range-select (v2).
  const handleCellClick = useCallback((filePath, mods = {}) => {
    const sel = useSelectionStore.getState();
    if (mods.ctrlKey || mods.metaKey) {
      // Multi-select toggle — don't open file, don't change primary
      if (filePath) sel.toggle(filePath);
      return;
    }
    // Plain click replaces selection with just this file
    sel.replace(filePath);
    setSelectedCell(filePath || null);
    if (filePath) {
      openFile(filePath);
      const ps = usePanelStore.getState();
      if (ps.panels.editor?.edgeCollapsed) ps.toggleEdgeCollapse('editor');
      ps.showPanel('editor');
      ps.focusPanel('editor');
    }
  }, [openFile]);

  // Double click = zoom to cell. It also ensures the file is open in the
  // editor — usually the preceding single click has already opened it, but
  // some code paths (drag-detect, missed hit-test, native dblclick events
  // from automation tools) can skip the single-click branch. Treating
  // double-click as a superset of single-click makes the UX forgiving:
  // whatever the upstream path was, a double-click always ends with "file
  // selected AND editor visible AND file loaded".
  const handleCellDoubleClick = useCallback((filePath) => {
    if (!filePath) return;
    setSelectedCell(filePath);
    openFile(filePath);
    const ps = usePanelStore.getState();
    if (ps.panels.editor?.edgeCollapsed) ps.toggleEdgeCollapse('editor');
    ps.showPanel('editor');
    ps.focusPanel('editor');
  }, [openFile]);

  // ─── Hex grid context menu state ─────────────────────────────────
  // ctxMenu shape when open: { x, y, items }
  const [ctxMenu, setCtxMenu] = useState(null);
  // nameModal shape when open: { title, placeholder, initial, onSubmit }
  const [nameModal, setNameModal] = useState(null);
  // confirmModal shape when open: { title, message, details?, destructive?,
  //   confirmLabel?, onConfirm }
  const [confirmModal, setConfirmModal] = useState(null);

  const handleCellContextMenu = useCallback(({ x, y, target }) => {
    const items = buildContextMenuItems(target, {
      workspace,
      tabs: useEditorStore.getState().tabs,
      hasClipboard: useClipboardStore.getState().hasContent(),
    });
    setCtxMenu({ x, y, items });
  }, [workspace]);

  // Drag-and-drop: called when the hex grid releases a drag on a valid
  // drop target. We optimistically patch the local files/groups state
  // so the layout reflows instantly, then confirm with the backend.
  // On error we rollback by calling refreshWorkspace(). Every successful
  // move is pushed onto the undo stack.
  // The actual move executor. Called after the user confirms the drop.
  // Returns immediately if nothing actually needs to change.
  const executeCellDrop = useCallback(async ({ kind, from, to, dropTarget }) => {
    const ed = useEditorStore.getState();
    const history = useFileOpsHistoryStore.getState();

    if (kind === 'file') {
      // If there's a multi-selection and the dragged file is in it, move
      // the ENTIRE selection as a batch to the target group.
      const sel = useSelectionStore.getState();
      const selected = sel.toArray();
      const isMulti = selected.length > 1 && sel.has(from);

      if (isMulti) {
        const targetGroup = to.includes('/') ? to.slice(0, to.lastIndexOf('/')) : '.';
        // Optimistic patch for all selected files
        setFiles(prev => prev.map(f => {
          if (!sel.has(f.path)) return f;
          const leaf = f.path.split('/').pop();
          const newPath = targetGroup !== '.' ? `${targetGroup}/${leaf}` : leaf;
          return { ...f, path: newPath, group_path: targetGroup };
        }));
        // Parallel backend confirmations (bounded concurrency via Promise.all
        // on the full batch — the backend handles concurrent rename calls fine
        // since each move touches a different path).
        const moves = selected
          .map((srcPath) => {
            const leaf = srcPath.split('/').pop();
            const destPath = targetGroup !== '.' ? `${targetGroup}/${leaf}` : leaf;
            return { srcPath, destPath };
          })
          .filter(m => m.srcPath !== m.destPath);
        const results = await Promise.all(
          moves.map(({ srcPath, destPath }) =>
            ed.renameFile(srcPath, destPath).then(r => ({ srcPath, destPath, ok: r?.ok !== false }))
              .catch(() => ({ srcPath, destPath, ok: false }))
          ),
        );
        const batchOps = results
          .filter(r => r.ok)
          .map(r => ({ kind: 'move', fromPath: r.srcPath, toPath: r.destPath, entity: 'file' }));
        const failed = results.filter(r => !r.ok).length;
        if (failed > 0) {
          console.warn(`Batch drop: ${failed} moves failed, refreshing`);
          refreshWorkspace();
        } else if (batchOps.length > 0) {
          history.push({ kind: 'batch', ops: batchOps });
          // 5s landing glow on each successfully moved file + pan to
          // the last one so the user can see where the batch landed.
          for (const op of batchOps) {
            hexCanvasRef.current?.markRecentDrop(op.toPath, 'file');
          }
          const lastOp = batchOps[batchOps.length - 1];
          if (lastOp) hexCanvasRef.current?.ensureVisible(lastOp.toPath, 'file');
          try { useGitStore.getState().fetchStatus(); } catch {}
        }
        sel.clear();
        return;
      }

      // Single-cell move
      const newGroup = to.includes('/') ? to.slice(0, to.lastIndexOf('/')) : '.';
      setFiles(prev => prev.map(f =>
        f.path === from ? { ...f, path: to, group_path: newGroup } : f,
      ));
      const result = await ed.renameFile(from, to);
      if (result?.ok === false) {
        console.warn('Drop failed, refreshing:', result.error);
        refreshWorkspace();
      } else {
        history.push({ kind: 'move', fromPath: from, toPath: to, entity: 'file' });
        hexCanvasRef.current?.markRecentDrop(to, 'file');
        hexCanvasRef.current?.ensureVisible(to, 'file');
        // Don't re-scan — the optimistic patch is the truth.
        // Just poll git for fresh status since the move may have changed it.
        try { useGitStore.getState().fetchStatus(); } catch {}
      }
    } else if (kind === 'group') {
      // Same-path drops are no-ops — the layout engine auto-packs
      // (no manual positioning), so "drop group onto itself" does nothing.
      if (from === to) return;

      // Optimistic patch: update the group's own path + every file/child whose
      // path starts with the old group path.
      const fromPrefix = from.endsWith('/') ? from : from + '/';
      setGroups(prev => prev.map(g => {
        if (g.path === from) return { ...g, path: to, parent_path: to.includes('/') ? to.slice(0, to.lastIndexOf('/')) : null };
        if (g.path.startsWith(fromPrefix)) return { ...g, path: to + g.path.slice(from.length) };
        return g;
      }));
      setFiles(prev => prev.map(f => {
        if (f.path === from || f.path.startsWith(fromPrefix)) {
          const newPath = to + f.path.slice(from.length);
          const newGroup = newPath.includes('/') ? newPath.slice(0, newPath.lastIndexOf('/')) : '.';
          return { ...f, path: newPath, group_path: newGroup };
        }
        return f;
      }));

      const result = await ed.moveFolder(from, to);
      if (result?.ok === false) {
        console.warn('Group drop failed, refreshing:', result.error);
        refreshWorkspace();
      } else {
        history.push({ kind: 'move', fromPath: from, toPath: to, entity: 'folder' });
        hexCanvasRef.current?.markRecentDrop(to, 'group');
        hexCanvasRef.current?.ensureVisible(to, 'group');
        try { useGitStore.getState().fetchStatus(); } catch {}
      }
    }
  }, [refreshWorkspace]);

  // Public drop handler — shows a confirm modal before executing any
  // move that actually changes a file/folder path. Pure visual-only
  // repositions (group drag with from === to) skip the confirm since
  // they're reversible (just a local anchor update) and the workflow
  // relies on being able to drag groups around freely.
  const handleCellDrop = useCallback(({ kind, from, to, dropTarget }) => {
    const sel = useSelectionStore.getState();
    const selected = sel.toArray();
    const isMulti = kind === 'file' && selected.length > 1 && sel.has(from);

    // Skip confirm for visual-only group repositions (same path)
    if (kind === 'group' && from === to) {
      executeCellDrop({ kind, from, to, dropTarget });
      return;
    }

    // Build a friendly confirm message for each case
    let title, message, details, confirmLabel;

    if (isMulti) {
      const targetGroup = to.includes('/') ? to.slice(0, to.lastIndexOf('/')) : '(workspace root)';
      title = `Move ${selected.length} files?`;
      message = (
        <>Move {selected.length} selected files into <code style={{ color: '#F0A030' }}>{targetGroup === '.' ? '(workspace root)' : targetGroup}</code>?</>
      );
      details = selected.slice(0, 20).join('\n') + (selected.length > 20 ? `\n... +${selected.length - 20} more` : '');
      confirmLabel = `Move ${selected.length} files`;
    } else if (kind === 'file') {
      const fromGroup = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '(root)';
      const toGroup = to.includes('/') ? to.slice(0, to.lastIndexOf('/')) : '(root)';
      title = 'Move file?';
      message = (
        <>Move <code style={{ color: W.accent }}>{from.split('/').pop()}</code> from <code style={{ color: W.textDim }}>{fromGroup}</code> to <code style={{ color: W.blue }}>{toGroup}</code>?</>
      );
      details = `${from}\n     ↓\n${to}`;
      confirmLabel = 'Move file';
    } else if (kind === 'group') {
      const fromParent = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '(root)';
      const toParent = to.includes('/') ? to.slice(0, to.lastIndexOf('/')) : '(root)';
      title = 'Move folder?';
      message = (
        <>Move folder <code style={{ color: W.accent }}>{from.split('/').pop()}</code> and ALL its contents from <code style={{ color: W.textDim }}>{fromParent}</code> to <code style={{ color: W.blue }}>{toParent}</code>?</>
      );
      details = `${from}\n     ↓\n${to}\n\nWARNING: this moves every file inside the folder.`;
      confirmLabel = 'Move folder';
    }

    setConfirmModal({
      title,
      message,
      details,
      confirmLabel,
      destructive: false,
      onConfirm: () => {
        setConfirmModal(null);
        executeCellDrop({ kind, from, to, dropTarget });
      },
    });
  }, [executeCellDrop]);

  // OS drag-in: files dropped from File Explorer / Finder onto the hex
  // grid. Copies each source file into the target group using the Tauri
  // `copy_external_file` command (desktop) or FileReader + POST (web).
  const handleOSDrop = useCallback(async ({ kind, paths, files: droppedFiles, targetGroup }) => {
    const ed = useEditorStore.getState();
    const dest = targetGroup && targetGroup !== '.' ? targetGroup : '';
    const results = [];

    if (kind === 'tauri' && paths) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        for (const srcPath of paths) {
          const leaf = srcPath.replace(/\\/g, '/').split('/').pop();
          const destPath = dest ? `${dest}/${leaf}` : leaf;
          try {
            await invoke('copy_external_file', { from: srcPath, to: destPath });
            results.push({ ok: true, path: destPath });
          } catch (err) {
            results.push({ ok: false, path: destPath, error: String(err) });
          }
        }
      } catch (err) {
        console.error('[os-drop]', err);
      }
    } else if (kind === 'web' && droppedFiles) {
      for (const file of droppedFiles) {
        const leaf = file.name;
        const destPath = dest ? `${dest}/${leaf}` : leaf;
        try {
          const text = await file.text();
          const r = await ed.createFile(destPath); // creates empty
          // createFile is "create empty + open". Overwrite with actual content.
          const saveRes = await fetch('/api/file', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: destPath, content: text }),
          });
          if (!saveRes.ok) throw new Error(`HTTP ${saveRes.status}`);
          results.push({ ok: true, path: destPath });
        } catch (err) {
          results.push({ ok: false, path: destPath, error: String(err) });
        }
      }
    }

    const failed = results.filter(r => !r.ok);
    if (failed.length) {
      console.warn('OS drop failures:', failed);
      alert(`${failed.length} file(s) could not be imported. See console.`);
    }
    refreshWorkspace();
  }, [refreshWorkspace]);

  // Build the deps object for fileOpsHistoryStore.undo/redo. Extracted
  // so both keyboard and menu actions can use it.
  const historyDeps = useMemo(() => ({
    renameFile: (from, to) => useEditorStore.getState().renameFile(from, to),
    createFile: async (path, content) => {
      try {
        if (IS_TAURI) {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('create_file', { path, content });
        } else {
          const res = await fetch('/api/file/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path, content }),
          });
          if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
        }
        return { ok: true };
      } catch (err) { return { ok: false, error: err.message || String(err) }; }
    },
    deleteFile: (path) => useEditorStore.getState().deleteFile(path),
    createFolder: (path) => useEditorStore.getState().createFolder(path),
    moveFolder: (from, to) => useEditorStore.getState().moveFolder(from, to),
    deleteFolder: (path) => useEditorStore.getState().deleteFolder(path),
  }), []);

  // ─── Context menu action router ──────────────────────────────────
  const handleHexContextAction = useCallback(async (actionId) => {
    const ed = useEditorStore.getState();

    // Parse `hex:<verb>:<args>` — some verbs have multiple colon-separated args
    if (!actionId.startsWith('hex:')) return;
    const body = actionId.slice(4);
    const colonIdx = body.indexOf(':');
    const verb = colonIdx === -1 ? body : body.slice(0, colonIdx);
    const arg = colonIdx === -1 ? '' : body.slice(colonIdx + 1);

    switch (verb) {
      case 'open': {
        ed.openFile(arg);
        break;
      }
      case 'openToSide': {
        ed.openFile(arg);
        break;
      }
      case 'rename': {
        const filePath = arg;
        const oldName = filePath.split('/').pop();
        const parent = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
        setNameModal({
          title: `Rename ${oldName}`,
          initial: oldName,
          placeholder: 'new name',
          onSubmit: async (newName) => {
            const newPath = parent ? `${parent}/${newName}` : newName;
            const result = await ed.renameFile(filePath, newPath);
            if (result?.ok === false) return result.error || 'Rename failed';
            // Optimistic path update
            const newGroup = newPath.includes('/') ? newPath.slice(0, newPath.lastIndexOf('/')) : '.';
            setFiles(prev => prev.map(f =>
              f.path === filePath ? { ...f, path: newPath, name: newPath.split('/').pop(), group_path: newGroup } : f,
            ));
            try { useGitStore.getState().fetchStatus(); } catch {}
            setNameModal(null);
          },
        });
        break;
      }
      case 'delete': {
        const filePath = arg;
        const snapshot = files.find(f => f.path === filePath);
        setConfirmModal({
          title: 'Delete file?',
          message: (
            <>Delete <code style={{ color: W.red }}>{filePath.split('/').pop()}</code>? It will be moved to the system recycle bin — <b>Ctrl+Z</b> to undo.</>
          ),
          details: filePath,
          destructive: true,
          confirmLabel: 'Delete',
          onConfirm: async () => {
            setConfirmModal(null);
            // Capture content BEFORE deletion so we can restore it on undo.
            // Files > MAX_CONTENT_BYTES are marked unrestorable.
            let capturedContent = null;
            try {
              const raw = await ed.readFileContent(filePath);
              if (raw != null && raw.length <= HISTORY_MAX_CONTENT_BYTES) {
                capturedContent = raw;
              }
            } catch { /* unreadable — accept unrestorable */ }
            // Optimistic remove
            setFiles(prev => prev.filter(f => f.path !== filePath));
            try {
              await ed.deleteFile(filePath);
              // Push undo record (content = null → unrestorable)
              useFileOpsHistoryStore.getState().push({
                kind: 'delete',
                path: filePath,
                entity: 'file',
                content: capturedContent,
              });
              try { useGitStore.getState().fetchStatus(); } catch {}
            } catch (err) {
              if (snapshot) setFiles(prev => [...prev, snapshot]);
              alert(`Delete failed: ${err.message || err}`);
            }
          },
        });
        break;
      }
      case 'newFile': {
        const groupPath = arg; // may be '.'
        setNameModal({
          title: groupPath && groupPath !== '.' ? `New file in ${groupPath}` : 'New file at workspace root',
          initial: '',
          placeholder: 'filename.ext',
          onSubmit: async (name) => {
            const filePath = groupPath && groupPath !== '.' ? `${groupPath}/${name}` : name;
            const result = await ed.createFile(filePath);
            if (result?.ok === false) return result.error || 'Create failed';
            optimisticallyAddFile(filePath, groupPath);
            hexCanvasRef.current?.markRecentDrop(filePath, 'file');
            hexCanvasRef.current?.zoomToItem(filePath, 'file');
            setNameModal(null);
          },
        });
        break;
      }
      case 'newFolder': {
        const parentGroup = arg;
        setNameModal({
          title: parentGroup && parentGroup !== '.' ? `New folder in ${parentGroup}` : 'New folder at workspace root',
          initial: '',
          placeholder: 'folder-name',
          onSubmit: async (name) => {
            const folderPath = parentGroup && parentGroup !== '.' ? `${parentGroup}/${name}` : name;
            const result = await ed.createFolder(folderPath);
            if (result?.ok === false) return result.error || 'Create folder failed';
            optimisticallyAddFolder(folderPath, parentGroup);
            hexCanvasRef.current?.markRecentDrop(folderPath, 'group');
            hexCanvasRef.current?.zoomToItem(folderPath, 'group');
            setNameModal(null);
          },
        });
        break;
      }
      case 'newFileRoot': {
        setNameModal({
          title: 'New file at workspace root',
          initial: '',
          placeholder: 'filename.ext',
          onSubmit: async (name) => {
            const result = await ed.createFile(name);
            if (result?.ok === false) return result.error || 'Create failed';
            optimisticallyAddFile(name, '.');
            hexCanvasRef.current?.markRecentDrop(name, 'file');
            hexCanvasRef.current?.zoomToItem(name, 'file');
            setNameModal(null);
          },
        });
        break;
      }
      case 'newFolderRoot': {
        setNameModal({
          title: 'New folder at workspace root',
          initial: '',
          placeholder: 'folder-name',
          onSubmit: async (name) => {
            const result = await ed.createFolder(name);
            if (result?.ok === false) return result.error || 'Create failed';
            optimisticallyAddFolder(name, '.');
            hexCanvasRef.current?.markRecentDrop(name, 'group');
            hexCanvasRef.current?.zoomToItem(name, 'group');
            setNameModal(null);
          },
        });
        break;
      }
      case 'renameGroup': {
        const groupPath = arg;
        const oldName = groupPath.split('/').pop();
        const parent = groupPath.includes('/') ? groupPath.slice(0, groupPath.lastIndexOf('/')) : '';
        setNameModal({
          title: `Rename folder ${oldName}`,
          initial: oldName,
          placeholder: 'new name',
          onSubmit: async (newName) => {
            const newPath = parent ? `${parent}/${newName}` : newName;
            await ed.moveFolder(groupPath, newPath);
            setNameModal(null);
            refreshWorkspace();
          },
        });
        break;
      }
      case 'deleteGroup': {
        const groupPath = arg;
        const prefix = groupPath.endsWith('/') ? groupPath : groupPath + '/';
        const snapshotFiles = files.filter(f => f.path === groupPath || f.path.startsWith(prefix));
        const snapshotGroups = groups.filter(g => g.path === groupPath || g.path.startsWith(prefix));
        const fileCount = snapshotFiles.length;
        const subGroupCount = snapshotGroups.length - 1;
        setConfirmModal({
          title: 'Delete folder?',
          message: (
            <>Delete <code style={{ color: W.red }}>{groupPath}</code> and ALL its contents? {fileCount > 0 && <><strong>{fileCount} file{fileCount === 1 ? '' : 's'}</strong></>}{subGroupCount > 0 && <> and <strong>{subGroupCount} sub-folder{subGroupCount === 1 ? '' : 's'}</strong></>}{fileCount + subGroupCount === 0 && <>the empty folder</>} will be moved to the system recycle bin.</>
          ),
          details: snapshotFiles.slice(0, 15).map(f => f.path).join('\n') + (fileCount > 15 ? `\n... +${fileCount - 15} more files` : ''),
          destructive: true,
          confirmLabel: `Delete ${fileCount + subGroupCount + 1} item${fileCount + subGroupCount === 0 ? '' : 's'}`,
          onConfirm: async () => {
            setConfirmModal(null);
            // Capture each descendant file's content BEFORE deletion so
            // Ctrl+Z can restore the entire subtree in one operation.
            // Files > MAX_CONTENT_BYTES are recorded unrestorable.
            const captures = await Promise.all(
              snapshotFiles.map(async (f) => {
                try {
                  const raw = await ed.readFileContent(f.path);
                  return {
                    path: f.path,
                    content: raw != null && raw.length <= HISTORY_MAX_CONTENT_BYTES ? raw : null,
                  };
                } catch {
                  return { path: f.path, content: null };
                }
              }),
            );
            // Optimistic remove
            setFiles(prev => prev.filter(f => !(f.path === groupPath || f.path.startsWith(prefix))));
            setGroups(prev => prev.filter(g => !(g.path === groupPath || g.path.startsWith(prefix))));
            try {
              const r = await ed.deleteFolder(groupPath);
              if (r?.ok === false) throw new Error(r.error || 'Delete failed');
              // Push a batch op: one delete per captured file so Ctrl+Z
              // restores the tree. Dirs are implicit (create re-mkdirs).
              const batchOps = captures.map((c) => ({
                kind: 'delete',
                path: c.path,
                entity: 'file',
                content: c.content,
              }));
              if (batchOps.length > 0) {
                useFileOpsHistoryStore.getState().push({ kind: 'batch', ops: batchOps });
              }
              try { useGitStore.getState().fetchStatus(); } catch {}
            } catch (err) {
              // Rollback
              setFiles(prev => [...prev, ...snapshotFiles]);
              setGroups(prev => [...prev, ...snapshotGroups]);
              alert(`Delete failed: ${err.message || err}`);
            }
          },
        });
        break;
      }
      case 'moveTo': {
        // arg = `<kind>:<path>:<destParent>`
        const parts = arg.split(':');
        const kind = parts[0];
        const path = parts[1];
        const destParent = parts.slice(2).join(':');
        const leafName = path.split('/').pop();
        const newPath = destParent && destParent !== '.' ? `${destParent}/${leafName}` : leafName;
        const destLabel = destParent && destParent !== '.' ? destParent : '(workspace root)';
        setConfirmModal({
          title: kind === 'file' ? 'Move file?' : 'Move folder?',
          message: (
            <>Move <code style={{ color: W.accent }}>{leafName}</code> to <code style={{ color: W.blue }}>{destLabel}</code>?</>
          ),
          details: `${path}\n     ↓\n${newPath}`,
          destructive: false,
          confirmLabel: kind === 'file' ? 'Move file' : 'Move folder',
          onConfirm: async () => {
            setConfirmModal(null);
            const result = kind === 'file'
              ? await ed.renameFile(path, newPath)
              : await ed.moveFolder(path, newPath);
            if (result?.ok !== false) {
              useFileOpsHistoryStore.getState().push({
                kind: 'move',
                fromPath: path,
                toPath: newPath,
                entity: kind === 'file' ? 'file' : 'folder',
              });
              try { useGitStore.getState().fetchStatus(); } catch {}
            } else {
              refreshWorkspace();
            }
          },
        });
        break;
      }
      case 'copyPath': {
        const full = workspace ? `${workspace}/${arg}` : arg;
        try { await navigator.clipboard.writeText(full); } catch {}
        break;
      }
      case 'copyRelativePath': {
        try { await navigator.clipboard.writeText(arg); } catch {}
        break;
      }
      case 'cut': {
        useClipboardStore.getState().cut([{ kind: 'file', path: arg }]);
        break;
      }
      case 'copy': {
        useClipboardStore.getState().copy([{ kind: 'file', path: arg }]);
        break;
      }
      case 'paste': {
        const targetGroup = arg && arg !== '.' ? arg : '.';
        const results = await useClipboardStore.getState().paste(targetGroup, {
          getAllFiles: () => files,
          renameFile: (from, to) => ed.renameFile(from, to),
          createFile: async (path, content) => {
            try {
              if (IS_TAURI) {
                const { invoke } = await import('@tauri-apps/api/core');
                await invoke('create_file', { path, content });
              } else {
                const res = await fetch('/api/file/create', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ path, content }),
                });
                if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
              }
              return { ok: true };
            } catch (err) { return { ok: false, error: err.message || String(err) }; }
          },
          readFile: async (path) => {
            try {
              if (IS_TAURI) {
                const { invoke } = await import('@tauri-apps/api/core');
                return await invoke('read_file', { path });
              }
              const r = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
              const d = await r.json();
              return d.content;
            } catch { return null; }
          },
          moveFolder: (from, to) => ed.moveFolder(from, to),
          createFolder: (path) => ed.createFolder(path),
        });
        const fails = results.filter(r => !r.ok && !r.skipped);
        if (fails.length) {
          console.warn('Paste had errors:', fails);
          alert(`Paste: ${fails.length} operation(s) failed. See console.`);
        }
        refreshWorkspace();
        break;
      }
      case 'pasteRoot': {
        // Fire a fresh invocation routed to 'paste' at root
        setTimeout(() => handleHexContextAction('hex:paste:.'), 0);
        break;
      }
      case 'revealInExplorer': {
        const p = arg === '.' ? '' : arg;
        if (IS_TAURI) {
          try {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('reveal_in_explorer', { path: p });
          } catch (err) {
            console.error(err);
          }
        }
        break;
      }
      case 'refresh': {
        refreshWorkspace();
        break;
      }
      default:
        console.warn('[hex context] unknown verb', verb, arg);
    }
  }, [refreshWorkspace, workspace, files, selectedCell]);

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
      // Ctrl+J: toggle Chat panel ("Claude Code directly in Hexis")
      if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
        e.preventDefault();
        togglePanel('chat');
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
      // Ctrl+N: new file (don't intercept when editor has focus — CM6 uses Ctrl+N for something else)
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'n' || e.key === 'N')) {
        const editorFocused = document.activeElement?.closest?.('.cm-editor');
        if (!editorFocused) {
          e.preventDefault();
          handleMenuAction('file:newFile');
        }
      }
      // Ctrl+Z / Ctrl+Y: file-ops history (undo/redo) — ONLY when the
      // editor isn't focused (CodeMirror owns undo for text editing).
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
        const editorFocused = document.activeElement?.closest?.('.cm-editor');
        const inputFocused = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
        if (!editorFocused && !inputFocused) {
          e.preventDefault();
          useFileOpsHistoryStore.getState().undo(historyDeps).then((ok) => {
            if (ok) refreshWorkspace();
          });
        }
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'y' || e.key === 'Y')) {
        const editorFocused = document.activeElement?.closest?.('.cm-editor');
        const inputFocused = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
        if (!editorFocused && !inputFocused) {
          e.preventDefault();
          useFileOpsHistoryStore.getState().redo(historyDeps).then((ok) => {
            if (ok) refreshWorkspace();
          });
        }
      }
      // Ctrl+Shift+Z: redo (mac/linux standard)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
        const editorFocused = document.activeElement?.closest?.('.cm-editor');
        const inputFocused = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
        if (!editorFocused && !inputFocused) {
          e.preventDefault();
          useFileOpsHistoryStore.getState().redo(historyDeps).then((ok) => {
            if (ok) refreshWorkspace();
          });
        }
      }
      // Ctrl+X/C/V: workspace clipboard — ONLY when no text editor or text
      // input has focus. The active selected cell (from the grid) is the
      // target; if nothing is selected these are no-ops.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'x' || e.key === 'X')) {
        const editorFocused = document.activeElement?.closest?.('.cm-editor');
        const inputFocused = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
        if (!editorFocused && !inputFocused && selectedCell) {
          e.preventDefault();
          useClipboardStore.getState().cut([{ kind: 'file', path: selectedCell }]);
        }
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'c' || e.key === 'C')) {
        const editorFocused = document.activeElement?.closest?.('.cm-editor');
        const inputFocused = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
        if (!editorFocused && !inputFocused && selectedCell && window.getSelection?.().toString() === '') {
          e.preventDefault();
          useClipboardStore.getState().copy([{ kind: 'file', path: selectedCell }]);
        }
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'v' || e.key === 'V')) {
        const editorFocused = document.activeElement?.closest?.('.cm-editor');
        const inputFocused = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
        if (!editorFocused && !inputFocused && useClipboardStore.getState().hasContent()) {
          e.preventDefault();
          // Paste into the group of the selected cell, or root
          const targetGroup = (() => {
            if (!selectedCell) return '.';
            const f = files.find(x => x.path === selectedCell);
            return f?.group_path || '.';
          })();
          handleHexContextAction(`hex:paste:${targetGroup}`);
        }
      }
      // Ctrl+Shift+N: new folder
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'N' || e.key === 'n')) {
        e.preventDefault();
        handleMenuAction('file:newFolder');
      }
      // Ctrl+Shift+L: re-optimize hex layout (wipes saved state, repacks)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'L' || e.key === 'l')) {
        e.preventDefault();
        hardRefreshLayout();
      }
      // Ctrl+Shift+E: toggle embedded explorer sidebar
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'E' || e.key === 'e')) {
        e.preventDefault();
        usePanelStore.getState().showPanel('editor');
        window.dispatchEvent(new Event('hexis:toggle-explorer'));
      }
      // Ctrl+Shift+C: toggle Chat panel
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
        const editorFocused = document.activeElement?.closest?.('.cm-editor');
        const inputFocused = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
        if (!editorFocused && !inputFocused) {
          e.preventDefault();
          togglePanel('chat');
        }
      }
      // Ctrl+E: toggle Editor panel. Guarded so it doesn't swallow Ctrl+E
      // inside a CodeMirror instance or other focused input.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'e' || e.key === 'E')) {
        const editorFocused = document.activeElement?.closest?.('.cm-editor');
        const inputFocused = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
        if (!editorFocused && !inputFocused) {
          e.preventDefault();
          togglePanel('editor');
        }
      }
      // Ctrl+O: open folder (native picker) — only when the editor isn't focused
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'o' || e.key === 'O')) {
        const editorFocused = document.activeElement?.closest?.('.cm-editor');
        const inputFocused = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
        if (!editorFocused && !inputFocused) {
          e.preventDefault();
          handleMenuAction('file:openFolder');
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeTab, togglePanel, handleMenuAction, handleHexContextAction, selectedCell, files, historyDeps, refreshWorkspace, hardRefreshLayout]);

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
          <DockPanel key="chat" id="chat" title="Chat" icon={<Icon name="comment-discussion" />}><ChatPanel /></DockPanel>,
          <DockPanel key="ai" id="ai" title="AI Agents" icon={<Icon name="hubot" />}><AIPanel /></DockPanel>,
          <DockPanel key="git" id="git" title="Source Control" icon={<Icon name="git-branch" />}><GitPanel /></DockPanel>,
          <DockPanel key="search" id="search" title="Search" icon={<Icon name="search" />}><SearchPanel /></DockPanel>,
          <DockPanel key="bookmarks" id="bookmarks" title="Bookmarks" icon={<Icon name="bookmark" />}><BookmarksPanel /></DockPanel>,
          <DockPanel key="history" id="history" title="Local History" icon={<Icon name="history" />}><LocalHistoryPanel /></DockPanel>,
          <DockPanel key="editor" id="editor" title="Editor" icon={<Icon name="file-code" />}>
            <EditorPanel
              explorer={
                <FileTreePanel
                  files={enrichedFiles}
                  groups={groups}
                  onContextMenu={handleCellContextMenu}
                  hexCanvasRef={hexCanvasRef}
                  onCellDrop={handleCellDrop}
                  onHexAction={handleHexContextAction}
                />
              }
            />
          </DockPanel>,
          <DockPanel key="terminal" id="terminal" title="Terminal" icon={<Icon name="terminal" />}><TerminalPanel /></DockPanel>,
          <DockPanel key="timeline" id="timeline" title="Timeline" icon={<Icon name="git-commit" />}><HistoryTimeline onSelectCommit={(hash) => console.log('commit:', hash)} /></DockPanel>,
          <DockPanel key="taskboard" id="taskboard" title="Tasks" icon={<Icon name="checklist" />}><TaskBoard /></DockPanel>,
        ]}>
          <HexCanvas
            ref={hexCanvasRef}
            files={enrichedFiles}
            groups={groups}
            selectedCell={selectedCell}
            cellActivity={cellActivity}
            activeAgents={activeAgents}
            pendingPlan={pendingPlan}
            onCellClick={handleCellClick}
            onCellDoubleClick={handleCellDoubleClick}
            onCellContextMenu={handleCellContextMenu}
            onCellDrop={handleCellDrop}
            onOSDrop={handleOSDrop}
            selectedCells={selectedCellSet}
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

      {/* Hex grid right-click context menu */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxMenu.items}
          onAction={handleHexContextAction}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {/* Name input modal — used by New File / New Folder / Rename flows */}
      {nameModal && (
        <NameInputModal
          open
          title={nameModal.title}
          placeholder={nameModal.placeholder}
          initial={nameModal.initial}
          onSubmit={nameModal.onSubmit}
          onClose={() => setNameModal(null)}
        />
      )}

      {/* Confirmation modal — used for destructive ops (delete,
          cross-group moves, drag-drop folder moves) */}
      {confirmModal && (
        <ConfirmModal
          open
          title={confirmModal.title}
          message={confirmModal.message}
          details={confirmModal.details}
          destructive={confirmModal.destructive}
          confirmLabel={confirmModal.confirmLabel}
          onConfirm={confirmModal.onConfirm}
          onClose={() => setConfirmModal(null)}
        />
      )}

      {/* Status bar */}
      <div
        className="flex-shrink-0 h-8 flex items-center px-4 gap-4 text-[12px] z-40"
        style={{ background: W.bg1, borderTop: '1px solid rgba(139, 148, 158, 0.1)', color: W.textMuted }}
      >
        <span style={{ color: W.textDim }}>⬡ Hexis</span>

        {/* Chat panel toggle */}
        <button
          className="flex items-center gap-1.5 px-2 py-0.5 rounded"
          style={{
            color: panels.chat?.visible ? W.accent : W.textDim,
            background: panels.chat?.visible ? W.accentSoft : 'transparent',
          }}
          onClick={() => togglePanel('chat')}
          title="Toggle Chat (Ctrl+Shift+C)"
        >
          <Icon name="comment-discussion" size={W.iconSm} color="inherit" />
          <span style={{ fontWeight: 500 }}>Chat</span>
        </button>

        {/* AI panel toggle */}
        <button
          className="flex items-center gap-1.5 px-2 py-0.5 rounded"
          style={{
            color: panels.ai?.visible ? W.accent : W.textDim,
            background: panels.ai?.visible ? W.accentSoft : 'transparent',
          }}
          onClick={() => togglePanel('ai')}
          title="Toggle AI Agents (Ctrl+I)"
        >
          <Icon name="hubot" size={W.iconSm} color="inherit" />
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
          title="Toggle Source Control (Ctrl+G)"
        >
          <Icon name="git-branch" size={W.iconSm} color="inherit" />
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
