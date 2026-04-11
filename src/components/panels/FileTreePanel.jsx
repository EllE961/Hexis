/**
 * FileTreePanel — VS-Code-style file explorer, embedded inside EditorPanel.
 *
 * Features:
 *   • Recursive folder tree with caret expand/collapse
 *   • Click file → openFile; click folder → toggle
 *   • Double-click file/folder → zoom the hex grid camera to it
 *   • Keyboard nav (arrows / Enter / F2 / Delete / /)
 *   • Auto-reveal active editor tab (scrolls + expands ancestors)
 *   • Inline rename (F2 or context menu)
 *   • Header buttons: + file, + folder, refresh, collapse-all, search
 *   • HTML5 drag-and-drop dispatching to the same handleCellDrop as the hex
 *   • Search filter (case-insensitive, auto-expands ancestors of matches)
 *   • File icons by extension (letter + color)
 *   • Git status tint on file labels (modified = amber, staged = green,
 *     untracked = blue, conflict = red)
 *   • Right-click → context menu (delegates to `onContextMenu` prop)
 *   • Expansion state + autoreveal toggle persisted per workspace
 */

import { useMemo, useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import { Icon } from '../common/Icon.jsx';
import { useEditorStore } from '../../stores/editorStore.js';
import { useGitStore } from '../../stores/gitStore.js';
import { useWorkspaceStore } from '../../stores/workspaceStore.js';
import { W } from '../../theme/window-tokens.js';

const EXPAND_KEY_PREFIX = 'hexis-tree-expanded:';
const AUTOREVEAL_KEY = 'hexis-tree-autoreveal';

// ── Extension → file-icon color/letter map ───────────────────────────────────
const EXT_ICON = {
  js: { l: 'J', c: '#F7DF1E' },
  mjs: { l: 'J', c: '#F7DF1E' },
  jsx: { l: 'J', c: '#61DAFB' },
  ts: { l: 'T', c: '#3178C6' },
  tsx: { l: 'T', c: '#3178C6' },
  py: { l: 'P', c: '#3776AB' },
  rs: { l: 'R', c: '#DEA584' },
  go: { l: 'G', c: '#00ADD8' },
  java: { l: 'J', c: '#E76F00' },
  c: { l: 'C', c: '#5C6BC0' },
  cpp: { l: 'C', c: '#00599C' },
  h: { l: 'H', c: '#5C6BC0' },
  cs: { l: 'C', c: '#9B4993' },
  rb: { l: 'R', c: '#CC342D' },
  php: { l: 'P', c: '#777BB4' },
  swift: { l: 'S', c: '#FA7343' },
  kt: { l: 'K', c: '#7F52FF' },
  md: { l: 'M', c: '#A0A0A0' },
  json: { l: '{}', c: '#F0A030' },
  yaml: { l: 'Y', c: '#CB171E' },
  yml: { l: 'Y', c: '#CB171E' },
  toml: { l: 'T', c: '#9C4221' },
  xml: { l: 'X', c: '#FFA000' },
  html: { l: 'H', c: '#E34C26' },
  css: { l: 'C', c: '#1572B6' },
  scss: { l: 'S', c: '#CC6699' },
  sass: { l: 'S', c: '#CC6699' },
  less: { l: 'L', c: '#1D365D' },
  sh: { l: '$', c: '#89E051' },
  bash: { l: '$', c: '#89E051' },
  sql: { l: 'S', c: '#E48E00' },
  txt: { l: 'T', c: '#8B949E' },
  lock: { l: 'L', c: '#F7931A' },
  env: { l: 'E', c: '#ECD53F' },
};

function iconForFile(name) {
  const dot = name.lastIndexOf('.');
  if (dot === -1) return { l: name.charAt(0).toUpperCase() || '?', c: '#8B949E' };
  const ext = name.slice(dot + 1).toLowerCase();
  return EXT_ICON[ext] || { l: ext.charAt(0).toUpperCase() || '?', c: '#8B949E' };
}

// ── Persistence helpers ──────────────────────────────────────────────────────
function loadExpanded(workspace) {
  try {
    const raw = localStorage.getItem(EXPAND_KEY_PREFIX + (workspace || 'default'));
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}
function saveExpanded(workspace, set) {
  try {
    localStorage.setItem(EXPAND_KEY_PREFIX + (workspace || 'default'), JSON.stringify([...set]));
  } catch { /* ignore */ }
}

// ── Tree building ────────────────────────────────────────────────────────────
function buildTree(files, groups) {
  const byPath = new Map();
  const root = { kind: 'folder', name: '', path: '.', children: [] };
  byPath.set('.', root);
  for (const g of groups) {
    if (g.path === '.') continue;
    byPath.set(g.path, {
      kind: 'folder',
      name: g.name || g.path.split('/').pop() || g.path,
      path: g.path,
      children: [],
    });
  }
  for (const g of groups) {
    if (g.path === '.') continue;
    const node = byPath.get(g.path);
    const parent = byPath.get(g.parent_path || '.') || root;
    parent.children.push(node);
  }
  for (const f of files) {
    const parent = byPath.get(f.group_path || '.') || root;
    parent.children.push({
      kind: 'file',
      name: f.name || f.path.split('/').pop(),
      path: f.path,
      file: f,
    });
  }
  function sortRec(node) {
    if (!node.children) return;
    node.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const c of node.children) sortRec(c);
  }
  sortRec(root);
  return root;
}

/** Flatten the tree into a list of currently-visible rows for keyboard nav. */
function flattenVisible(root, expanded, filter, matchSet) {
  const out = [];
  function walk(node, depth) {
    if (node.path !== '.') {
      if (filter && !matchSet.has(node.path)) {
        // Non-matching, only recurse if ancestor of a match
        if (node.kind === 'folder') {
          // Check if any descendant matches
          let has = false;
          for (const p of matchSet) {
            if (p.startsWith(node.path + '/')) { has = true; break; }
          }
          if (!has) return;
        } else {
          return;
        }
      }
      out.push({ node, depth });
    }
    if (node.kind === 'folder' && (node.path === '.' || expanded.has(node.path) || filter)) {
      for (const c of node.children || []) walk(c, node.path === '.' ? 0 : depth + 1);
    }
  }
  walk(root, 0);
  return out;
}

/** Build the set of paths matching the filter (plus all their ancestors). */
function buildMatchSet(files, groups, filter) {
  if (!filter) return new Set();
  const needle = filter.toLowerCase();
  const set = new Set();
  const addAncestors = (p) => {
    let cur = p;
    while (cur && cur !== '.') {
      set.add(cur);
      const i = cur.lastIndexOf('/');
      cur = i === -1 ? null : cur.slice(0, i);
    }
  };
  for (const f of files) {
    if ((f.name || f.path).toLowerCase().includes(needle)) {
      set.add(f.path);
      addAncestors(f.path);
    }
  }
  for (const g of groups) {
    if (g.path === '.') continue;
    const name = g.name || g.path.split('/').pop();
    if (name.toLowerCase().includes(needle)) {
      set.add(g.path);
      addAncestors(g.path);
    }
  }
  return set;
}

// ── Tree row ─────────────────────────────────────────────────────────────────
function TreeRow({
  node,
  depth,
  expanded,
  selected,
  activeFile,
  renameTarget,
  renameValue,
  setRenameValue,
  commitRename,
  cancelRename,
  onToggle,
  onOpenFile,
  onSelect,
  onContextMenu,
  onDoubleClickNode,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  dropTargetPath,
  gitStatusFor,
  rowRef,
}) {
  const isFolder = node.kind === 'folder';
  const isOpen = expanded.has(node.path);
  const isSelected = selected === node.path;
  const isActive = !isFolder && node.path === activeFile;
  const isDropTarget = dropTargetPath === node.path;
  const isRenaming = renameTarget === node.path;

  const status = !isFolder ? gitStatusFor(node.path) : null;
  const statusColor =
    status === 'conflict' ? W.red :
    status === 'staged' ? W.green :
    status === 'modified' ? W.yellow :
    status === 'untracked' ? W.blue :
    null;

  const icon = isFolder ? null : iconForFile(node.name);

  return (
    <div
      ref={rowRef}
      data-path={node.path}
      draggable={!isRenaming}
      onDragStart={(e) => onDragStart(e, node)}
      onDragOver={(e) => onDragOver(e, node)}
      onDragLeave={(e) => onDragLeave(e, node)}
      onDrop={(e) => onDrop(e, node)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        paddingLeft: 6 + depth * 12,
        paddingRight: 6,
        paddingTop: 2,
        paddingBottom: 2,
        cursor: isRenaming ? 'text' : 'pointer',
        fontSize: W.fontSm,
        color: isActive ? W.accent : W.text,
        background: isDropTarget
          ? `${W.accent}33`
          : isSelected
            ? W.accentBg
            : 'transparent',
        outline: isDropTarget ? `1px solid ${W.accent}` : 'none',
        outlineOffset: -1,
        userSelect: 'none',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
      onClick={(e) => {
        if (isRenaming) return;
        onSelect(node.path);
        if (isFolder) onToggle(node.path);
        else onOpenFile(node.path);
      }}
      onDoubleClick={(e) => {
        if (isRenaming) return;
        e.stopPropagation();
        onDoubleClickNode(node);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onSelect(node.path);
        onContextMenu({
          x: e.clientX,
          y: e.clientY,
          target: isFolder
            ? { kind: 'group', groupPath: node.path }
            : {
                kind: 'file',
                filePath: node.path,
                groupPath: node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '.',
              },
        });
      }}
      onMouseEnter={(e) => {
        if (!isSelected && !isDropTarget) e.currentTarget.style.background = W.bg2;
      }}
      onMouseLeave={(e) => {
        if (!isSelected && !isDropTarget) e.currentTarget.style.background = 'transparent';
      }}
      title={node.path}
    >
      {/* Caret */}
      {isFolder ? (
        <Icon
          name={isOpen ? 'chevron-down' : 'chevron-right'}
          size={W.iconSm}
          color={W.textDim}
        />
      ) : (
        <span style={{ width: W.iconSm, flexShrink: 0 }} />
      )}
      {/* Icon */}
      {isFolder ? (
        <span
          style={{
            fontSize: 11,
            color: isOpen ? W.accent : W.textDim,
            width: 14,
            textAlign: 'center',
            flexShrink: 0,
          }}
        >
          {isOpen ? '▾' : '▸'}
        </span>
      ) : (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 16,
            height: 16,
            borderRadius: 3,
            background: icon.c + '22',
            border: statusColor ? `1.5px solid ${statusColor}` : `1px solid ${icon.c}55`,
            color: icon.c,
            fontSize: 9,
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          {icon.l}
        </span>
      )}
      {/* Label / Rename input */}
      {isRenaming ? (
        <input
          autoFocus
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
            else if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
            e.stopPropagation();
          }}
          onBlur={() => commitRename()}
          onClick={(e) => e.stopPropagation()}
          style={{
            flex: 1,
            background: W.bg0,
            border: `1px solid ${W.accent}`,
            borderRadius: 2,
            color: W.text,
            fontSize: W.fontSm,
            fontFamily: 'inherit',
            padding: '1px 4px',
            outline: 'none',
            minWidth: 60,
          }}
        />
      ) : (
        <span
          style={{
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            fontStyle: status === 'untracked' ? 'italic' : 'normal',
          }}
        >
          {node.name}
        </span>
      )}
    </div>
  );
}

// ── Main panel ───────────────────────────────────────────────────────────────
export default function FileTreePanel({
  files,
  groups,
  onContextMenu,
  hexCanvasRef,
  onCellDrop,
  onHexAction,
}) {
  const workspace = useWorkspaceStore(s => s.current);
  const activeFile = useEditorStore(s => s.activeTab);
  const openFile = useEditorStore(s => s.openFile);
  const renameFile = useEditorStore(s => s.renameFile);
  const moveFolder = useEditorStore(s => s.moveFolder);

  // Subscribe to git maps so row colours update
  const gitModified = useGitStore(s => s.modified);
  const gitStaged = useGitStore(s => s.staged);
  const gitUntracked = useGitStore(s => s.untracked);
  const gitConflict = useGitStore(s => s.conflict);
  const gitStatusFor = useCallback((path) => {
    if (gitConflict?.has?.(path)) return 'conflict';
    if (gitStaged?.has?.(path)) return 'staged';
    if (gitModified?.has?.(path)) return 'modified';
    if (gitUntracked?.has?.(path)) return 'untracked';
    return null;
  }, [gitModified, gitStaged, gitUntracked, gitConflict]);

  const [expanded, setExpanded] = useState(() => loadExpanded(workspace));
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [autoReveal, setAutoReveal] = useState(() => {
    try { return localStorage.getItem(AUTOREVEAL_KEY) !== '0'; } catch { return true; }
  });
  const [renameTarget, setRenameTarget] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [dropTargetPath, setDropTargetPath] = useState(null);

  const scrollerRef = useRef(null);
  const rowRefs = useRef(new Map());
  const searchInputRef = useRef(null);
  const dragSrcRef = useRef(null);

  useEffect(() => { setExpanded(loadExpanded(workspace)); }, [workspace]);
  useEffect(() => {
    try { localStorage.setItem(AUTOREVEAL_KEY, autoReveal ? '1' : '0'); } catch {}
  }, [autoReveal]);

  const tree = useMemo(() => buildTree(files, groups), [files, groups]);
  const matchSet = useMemo(() => buildMatchSet(files, groups, filter), [files, groups, filter]);
  const visibleRows = useMemo(
    () => flattenVisible(tree, expanded, filter, matchSet),
    [tree, expanded, filter, matchSet],
  );

  // Auto-reveal the active editor tab
  useLayoutEffect(() => {
    if (!autoReveal || !activeFile) return;
    // Expand all ancestors
    const parts = activeFile.split('/');
    if (parts.length > 1) {
      setExpanded((prev) => {
        const next = new Set(prev);
        let acc = '';
        for (let i = 0; i < parts.length - 1; i++) {
          acc = acc ? `${acc}/${parts[i]}` : parts[i];
          next.add(acc);
        }
        saveExpanded(workspace, next);
        return next;
      });
    }
    setSelected(activeFile);
    // Scroll row into view on next frame
    requestAnimationFrame(() => {
      const row = rowRefs.current.get(activeFile);
      if (row) row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }, [activeFile, autoReveal, workspace]);

  const toggle = useCallback((path) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      saveExpanded(workspace, next);
      return next;
    });
  }, [workspace]);

  const collapseAll = useCallback(() => {
    setExpanded(new Set());
    saveExpanded(workspace, new Set());
  }, [workspace]);

  // Double-click: zoom hex grid + open (file) / toggle (folder)
  const onDoubleClickNode = useCallback((node) => {
    if (node.kind === 'file') {
      hexCanvasRef?.current?.zoomToItem(node.path, 'file');
      openFile(node.path);
    } else {
      hexCanvasRef?.current?.zoomToItem(node.path, 'group');
      toggle(node.path);
    }
  }, [hexCanvasRef, openFile, toggle]);

  // Inline rename
  const startRename = useCallback((path) => {
    const leaf = path.split('/').pop() || path;
    setRenameTarget(path);
    setRenameValue(leaf);
  }, []);
  const cancelRename = useCallback(() => {
    setRenameTarget(null);
    setRenameValue('');
  }, []);
  const commitRename = useCallback(async () => {
    if (!renameTarget || !renameValue.trim()) { cancelRename(); return; }
    const oldPath = renameTarget;
    const newLeaf = renameValue.trim();
    if (oldPath.split('/').pop() === newLeaf) { cancelRename(); return; }
    const parent = oldPath.includes('/') ? oldPath.slice(0, oldPath.lastIndexOf('/')) : '';
    const newPath = parent ? `${parent}/${newLeaf}` : newLeaf;
    // Decide file vs folder: if any file or group has this exact path as a file
    const isFile = files.some(f => f.path === oldPath);
    if (isFile) await renameFile(oldPath, newPath);
    else await moveFolder(oldPath, newPath);
    // Close rename — parent will receive new files/groups via optimistic patch
    setRenameTarget(null);
    setRenameValue('');
    setSelected(newPath);
  }, [renameTarget, renameValue, files, renameFile, moveFolder, cancelRename]);

  // Drag and drop — dispatches to handleCellDrop in App.jsx
  const onRowDragStart = useCallback((e, node) => {
    dragSrcRef.current = node;
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', node.path); } catch {}
  }, []);
  const onRowDragOver = useCallback((e, node) => {
    const src = dragSrcRef.current;
    if (!src || src.path === node.path) return;
    // Only folders accept drops
    const targetFolder = node.kind === 'folder' ? node.path
      : (node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '.');
    // Prevent dropping a folder into itself or its descendants
    if (src.kind === 'folder' && (targetFolder === src.path || targetFolder.startsWith(src.path + '/'))) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTargetPath(node.kind === 'folder' ? node.path : null);
  }, []);
  const onRowDragLeave = useCallback((e, node) => {
    setDropTargetPath((p) => (p === node.path ? null : p));
  }, []);
  const onRowDrop = useCallback((e, node) => {
    e.preventDefault();
    const src = dragSrcRef.current;
    setDropTargetPath(null);
    dragSrcRef.current = null;
    if (!src || !onCellDrop) return;
    const targetFolder = node.kind === 'folder' ? node.path
      : (node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '.');
    if (src.kind === 'folder' && (targetFolder === src.path || targetFolder.startsWith(src.path + '/'))) return;
    // Compute destination path
    const leaf = src.path.split('/').pop();
    const toPath = targetFolder === '.' ? leaf : `${targetFolder}/${leaf}`;
    if (toPath === src.path) return;
    onCellDrop({
      kind: src.kind === 'folder' ? 'group' : 'file',
      from: src.path,
      to: toPath,
      dropTarget: { kind: 'empty', groupPath: targetFolder, q: 0, r: 0, status: 'valid' },
    });
  }, [onCellDrop]);

  // Keyboard navigation
  const onKeyDown = useCallback((e) => {
    // If the search input has focus, let it handle its own keys
    if (document.activeElement === searchInputRef.current && e.key !== 'Escape') return;
    if (renameTarget) return;

    if (e.key === '/') {
      e.preventDefault();
      setSearchOpen(true);
      setTimeout(() => searchInputRef.current?.focus(), 0);
      return;
    }
    if (!selected && visibleRows.length > 0) {
      setSelected(visibleRows[0].node.path);
      return;
    }
    const idx = visibleRows.findIndex(r => r.node.path === selected);
    if (idx === -1) return;
    const { node } = visibleRows[idx];

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = visibleRows[Math.min(visibleRows.length - 1, idx + 1)];
      if (next) {
        setSelected(next.node.path);
        rowRefs.current.get(next.node.path)?.scrollIntoView({ block: 'nearest' });
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = visibleRows[Math.max(0, idx - 1)];
      if (next) {
        setSelected(next.node.path);
        rowRefs.current.get(next.node.path)?.scrollIntoView({ block: 'nearest' });
      }
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (node.kind === 'folder' && !expanded.has(node.path)) {
        toggle(node.path);
      } else if (node.kind === 'folder' && expanded.has(node.path) && node.children?.length) {
        setSelected(node.children[0].path);
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (node.kind === 'folder' && expanded.has(node.path)) {
        toggle(node.path);
      } else if (node.path.includes('/')) {
        const parent = node.path.slice(0, node.path.lastIndexOf('/'));
        if (parent) setSelected(parent);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (node.kind === 'folder') toggle(node.path);
      else openFile(node.path);
    } else if (e.key === 'F2') {
      e.preventDefault();
      startRename(node.path);
    } else if (e.key === 'Delete') {
      e.preventDefault();
      // Delegate to the same context-menu action used by right-click
      if (node.kind === 'folder') {
        onHexAction?.(`hex:deleteGroup:${node.path}`);
      } else {
        onHexAction?.(`hex:delete:${node.path}`);
      }
    } else if (e.key === 'Escape') {
      if (searchOpen) {
        setFilter('');
        setSearchOpen(false);
      }
    }
  }, [selected, visibleRows, expanded, renameTarget, toggle, openFile, startRename, searchOpen, onHexAction]);

  // Header button targets the currently-selected folder (or parent of selected file, or root)
  const targetGroupForCreate = useMemo(() => {
    if (!selected) return '.';
    const asFile = files.find(f => f.path === selected);
    if (asFile) return asFile.group_path || '.';
    return selected; // it's a folder path
  }, [selected, files]);

  const handleNewFile = useCallback(() => {
    onHexAction?.(`hex:newFile:${targetGroupForCreate}`);
  }, [onHexAction, targetGroupForCreate]);
  const handleNewFolder = useCallback(() => {
    onHexAction?.(`hex:newFolder:${targetGroupForCreate}`);
  }, [onHexAction, targetGroupForCreate]);
  const handleRefresh = useCallback(() => {
    onHexAction?.('hex:refresh');
  }, [onHexAction]);

  return (
    <div
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: W.bg1,
        color: W.text,
        outline: 'none',
      }}
    >
      {/* Header */}
      <div
        style={{
          flexShrink: 0,
          padding: `${W.s2}px ${W.s3}px`,
          borderBottom: `1px solid ${W.border}`,
          background: W.bg2,
          display: 'flex',
          alignItems: 'center',
          gap: 2,
        }}
      >
        <span style={{
          flex: 1,
          fontSize: W.fontSm,
          fontWeight: W.fontWeightSemi,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          color: W.textDim,
        }}>
          Explorer
        </span>
        <IconBtn title="New File" onClick={handleNewFile}><Icon name="new-file" size={W.iconSm} /></IconBtn>
        <IconBtn title="New Folder" onClick={handleNewFolder}><Icon name="new-folder" size={W.iconSm} /></IconBtn>
        <IconBtn title="Refresh" onClick={handleRefresh}><Icon name="refresh" size={W.iconSm} /></IconBtn>
        <IconBtn title="Collapse All" onClick={collapseAll}><Icon name="collapse-all" size={W.iconSm} /></IconBtn>
        <IconBtn
          title={autoReveal ? 'Auto-reveal: on' : 'Auto-reveal: off'}
          onClick={() => setAutoReveal(v => !v)}
          active={autoReveal}
        >
          <Icon name={autoReveal ? 'pin' : 'pinned'} size={W.iconSm} />
        </IconBtn>
        <IconBtn
          title="Search (/)"
          onClick={() => {
            setSearchOpen(v => !v);
            setTimeout(() => searchInputRef.current?.focus(), 0);
          }}
          active={searchOpen}
        >
          <Icon name="search" size={W.iconSm} />
        </IconBtn>
      </div>

      {/* Search input */}
      {searchOpen && (
        <div
          style={{
            flexShrink: 0,
            padding: `${W.s2}px ${W.s3}px`,
            borderBottom: `1px solid ${W.borderSubtle}`,
            background: W.bg0,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <Icon name="search" size={W.iconSm} color={W.textDim} />
          <input
            ref={searchInputRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setFilter('');
                setSearchOpen(false);
              }
            }}
            placeholder="Search files…"
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              color: W.text,
              fontSize: W.fontSm,
              fontFamily: 'inherit',
              padding: '2px 4px',
              outline: 'none',
            }}
          />
          {filter && (
            <button
              onClick={() => { setFilter(''); searchInputRef.current?.focus(); }}
              style={{ background: 'transparent', border: 'none', color: W.textDim, cursor: 'pointer', display: 'flex', padding: 0 }}
              title="Clear"
            >
              <Icon name="close" size={W.iconSm} />
            </button>
          )}
        </div>
      )}

      {/* Tree */}
      <div
        ref={scrollerRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          paddingTop: 4,
          paddingBottom: 4,
        }}
      >
        {(!files || files.length === 0) ? (
          <div style={{ padding: W.s4, color: W.textDim, fontSize: W.fontSm, textAlign: 'center' }}>
            No files yet.
          </div>
        ) : visibleRows.length === 0 ? (
          <div style={{ padding: W.s4, color: W.textDim, fontSize: W.fontSm, textAlign: 'center' }}>
            No matches for "{filter}"
          </div>
        ) : (
          visibleRows.map(({ node, depth }) => (
            <TreeRow
              key={node.path}
              node={node}
              depth={depth}
              expanded={expanded}
              selected={selected}
              activeFile={activeFile}
              renameTarget={renameTarget}
              renameValue={renameValue}
              setRenameValue={setRenameValue}
              commitRename={commitRename}
              cancelRename={cancelRename}
              onToggle={toggle}
              onOpenFile={openFile}
              onSelect={setSelected}
              onContextMenu={onContextMenu}
              onDoubleClickNode={onDoubleClickNode}
              onDragStart={onRowDragStart}
              onDragOver={onRowDragOver}
              onDragLeave={onRowDragLeave}
              onDrop={onRowDrop}
              dropTargetPath={dropTargetPath}
              gitStatusFor={gitStatusFor}
              rowRef={(el) => {
                if (el) rowRefs.current.set(node.path, el);
                else rowRefs.current.delete(node.path);
              }}
            />
          ))
        )}
      </div>
    </div>
  );
}

function IconBtn({ title, onClick, children, active }) {
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
        borderRadius: 3,
        display: 'flex',
        alignItems: 'center',
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.color = W.text; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.color = W.textDim; }}
    >
      {children}
    </button>
  );
}
