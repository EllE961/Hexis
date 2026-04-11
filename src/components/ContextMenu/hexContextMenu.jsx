/**
 * Hex-grid context menu builders.
 *
 * Given the hit-test result from HexCanvas (a `target` describing what
 * was right-clicked: a file cell, an empty slot, a group header, or
 * nothing), produce the data tree consumed by <ContextMenu>.
 *
 * Action IDs follow the convention `hex:<verb>:<arg>` and are routed
 * by the `handleHexContextAction` dispatcher in App.jsx.
 *
 * Icons are Codicons (the same icon font VS Code uses) rendered via
 * the shared `<Icon>` wrapper. ContextMenu clones the icon element with
 * the right color for destructive / disabled / normal variants.
 */

import React from 'react';
import { Icon } from '../common/Icon.jsx';

// Pre-instantiated icon elements — cheaper than building a new JSX
// node per menu build since every row goes through React.cloneElement
// in ContextMenu anyway to set color/size.
const IconFile     = <Icon name="new-file" />;
const IconFolder   = <Icon name="new-folder" />;
const IconEdit     = <Icon name="edit" />;
const IconTrash    = <Icon name="trash" />;
const IconOpen     = <Icon name="go-to-file" />;
const IconOpenSide = <Icon name="split-horizontal" />;
const IconCut      = <Icon name="diff-removed" />;
const IconCopy     = <Icon name="copy" />;
const IconPaste    = <Icon name="clippy" />;
const IconLink     = <Icon name="link" />;
const IconRefresh  = <Icon name="refresh" />;
const IconReveal   = <Icon name="folder-opened" />;
const IconMoveOut  = <Icon name="export" />;

/**
 * @param target  { kind: 'file'|'empty'|'group'|'none', filePath?, groupPath?, q, r }
 * @param opts    { workspace, tabs, hasClipboard }
 * @returns items array for <ContextMenu>
 */
export function buildContextMenuItems(target, opts = {}) {
  const { workspace, hasClipboard } = opts;

  switch (target?.kind) {
    case 'file':
      return fileCellItems(target, { hasClipboard });
    case 'empty':
      return emptyCellItems(target, { hasClipboard });
    case 'group':
      return groupItems(target, { hasClipboard });
    default:
      return rootItems({ hasClipboard, workspace });
  }
}

// ─────────────────────────────────────────────────────────────────────

function fileCellItems(target, { hasClipboard }) {
  const { filePath, groupPath } = target;
  const ancestorChain = buildAncestorChain(groupPath);
  return [
    { id: `hex:open:${filePath}`, label: 'Open', icon: IconOpen },
    { id: `hex:openToSide:${filePath}`, label: 'Open to the Side', icon: IconOpenSide },
    { separator: true },
    { id: `hex:rename:${filePath}`, label: 'Rename…', shortcut: 'F2', icon: IconEdit },
    { id: `hex:delete:${filePath}`, label: 'Delete', icon: IconTrash, destructive: true },
    { separator: true },
    { id: `hex:cut:${filePath}`, label: 'Cut', shortcut: 'Ctrl+X', icon: IconCut },
    { id: `hex:copy:${filePath}`, label: 'Copy', shortcut: 'Ctrl+C', icon: IconCopy },
    { id: `hex:copyPath:${filePath}`, label: 'Copy Path', icon: IconLink },
    { id: `hex:copyRelativePath:${filePath}`, label: 'Copy Relative Path' },
    { separator: true },
    {
      label: 'Move Out To',
      icon: IconMoveOut,
      submenu: buildMoveOutSubmenu(filePath, ancestorChain, 'file'),
    },
    { id: `hex:revealInExplorer:${filePath}`, label: 'Reveal in File Explorer', icon: IconReveal },
  ];
}

function emptyCellItems(target, { hasClipboard }) {
  // Right-click on an empty cell inside a group → show the full group
  // menu (new file/folder, rename, delete, move out) plus paste. The
  // user shouldn't have to hunt for the group's label tile to access
  // folder operations.
  const { groupPath } = target;
  if (!groupPath || groupPath === '.') {
    return rootItems({ hasClipboard });
  }
  const name = groupPath.split('/').pop() || groupPath;
  const ancestorChain = buildAncestorChain(groupPath);
  return [
    { id: `hex:newFile:${groupPath}`, label: `New File in ${name}…`, icon: IconFile },
    { id: `hex:newFolder:${groupPath}`, label: `New Folder in ${name}…`, icon: IconFolder },
    { separator: true },
    {
      id: `hex:paste:${groupPath}`,
      label: 'Paste',
      shortcut: 'Ctrl+V',
      icon: IconPaste,
      enabled: !!hasClipboard,
    },
    { separator: true },
    { id: `hex:renameGroup:${groupPath}`, label: 'Rename Group…', shortcut: 'F2', icon: IconEdit },
    { id: `hex:deleteGroup:${groupPath}`, label: 'Delete Group', icon: IconTrash, destructive: true },
    { separator: true },
    {
      label: 'Move Out To',
      icon: IconMoveOut,
      enabled: ancestorChain.length > 0,
      submenu: buildMoveOutSubmenu(groupPath, ancestorChain, 'group'),
    },
    { separator: true },
    { id: `hex:copyPath:${groupPath}`, label: 'Copy Path', icon: IconLink },
    { id: `hex:revealInExplorer:${groupPath}`, label: 'Reveal in File Explorer', icon: IconReveal },
  ];
}

function groupItems(target, { hasClipboard }) {
  const { groupPath } = target;
  const name = groupPath.split('/').pop() || groupPath;
  const ancestorChain = buildAncestorChain(groupPath);
  return [
    { id: `hex:newFile:${groupPath}`, label: `New File in ${name}…`, icon: IconFile },
    { id: `hex:newFolder:${groupPath}`, label: `New Folder in ${name}…`, icon: IconFolder },
    { separator: true },
    { id: `hex:renameGroup:${groupPath}`, label: 'Rename Group…', shortcut: 'F2', icon: IconEdit },
    { id: `hex:deleteGroup:${groupPath}`, label: 'Delete Group', icon: IconTrash, destructive: true },
    { separator: true },
    {
      label: 'Move Out To',
      icon: IconMoveOut,
      enabled: ancestorChain.length > 0,
      submenu: buildMoveOutSubmenu(groupPath, ancestorChain, 'group'),
    },
    { separator: true },
    { id: `hex:copyPath:${groupPath}`, label: 'Copy Path', icon: IconLink },
    { id: `hex:revealInExplorer:${groupPath}`, label: 'Reveal in File Explorer', icon: IconReveal },
  ];
}

function rootItems({ hasClipboard, workspace }) {
  return [
    { id: 'hex:newFileRoot', label: 'New File…', icon: IconFile },
    { id: 'hex:newFolderRoot', label: 'New Folder…', icon: IconFolder },
    { separator: true },
    {
      id: 'hex:pasteRoot',
      label: 'Paste',
      shortcut: 'Ctrl+V',
      icon: IconPaste,
      enabled: !!hasClipboard,
    },
    { separator: true },
    { id: 'hex:refresh', label: 'Refresh', icon: IconRefresh },
    {
      id: 'hex:revealInExplorer:.',
      label: 'Reveal Workspace in File Explorer',
      icon: IconReveal,
      enabled: !!workspace,
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/** Build the chain of ancestor group paths for a given file or group path. */
function buildAncestorChain(path) {
  if (!path || path === '.') return [];
  const parts = path.split('/');
  parts.pop();
  const chain = [];
  let acc = '';
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    chain.push(acc);
  }
  return chain;
}

/** Submenu: "Move to ancestor group" entries + "Workspace root". */
function buildMoveOutSubmenu(path, ancestorChain, kind) {
  const items = [];
  for (let i = ancestorChain.length - 1; i >= 0; i--) {
    const ancestor = ancestorChain[i];
    const label = ancestor.split('/').pop() || ancestor;
    items.push({
      id: `hex:moveTo:${kind}:${path}:${ancestor}`,
      label: i === ancestorChain.length - 1 ? `${label} (parent)` : label,
    });
  }
  items.push({
    id: `hex:moveTo:${kind}:${path}:.`,
    label: 'Workspace root',
  });
  return items;
}
