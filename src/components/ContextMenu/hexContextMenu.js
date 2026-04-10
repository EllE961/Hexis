/**
 * Hex-grid context menu builders.
 *
 * Given the hit-test result from HexCanvas (a `target` describing what
 * was right-clicked: a file cell, an empty slot, a group header, or
 * nothing), produce the data tree consumed by <ContextMenu>.
 *
 * Action IDs follow the convention `hex:<verb>:<arg>` and are routed
 * by the `handleHexContextAction` dispatcher in App.jsx.
 */

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
    { id: `hex:open:${filePath}`, label: 'Open', icon: '↗' },
    { id: `hex:openToSide:${filePath}`, label: 'Open to the Side' },
    { separator: true },
    { id: `hex:rename:${filePath}`, label: 'Rename…', shortcut: 'F2', icon: '✎' },
    { id: `hex:delete:${filePath}`, label: 'Delete', icon: '✕', destructive: true },
    { separator: true },
    { id: `hex:cut:${filePath}`, label: 'Cut', shortcut: 'Ctrl+X' },
    { id: `hex:copy:${filePath}`, label: 'Copy', shortcut: 'Ctrl+C' },
    { id: `hex:copyPath:${filePath}`, label: 'Copy Path' },
    { id: `hex:copyRelativePath:${filePath}`, label: 'Copy Relative Path' },
    { separator: true },
    {
      label: 'Move Out To',
      submenu: buildMoveOutSubmenu(filePath, ancestorChain, 'file'),
    },
    { id: `hex:revealInExplorer:${filePath}`, label: 'Reveal in File Explorer' },
  ];
}

function emptyCellItems(target, { hasClipboard }) {
  const { groupPath, q, r } = target;
  const name = groupPath.split('/').pop() || groupPath;
  return [
    { id: `hex:newFile:${groupPath}`, label: `New File in ${name}…`, icon: '+' },
    { id: `hex:newFolder:${groupPath}`, label: `New Folder in ${name}…`, icon: '▢' },
    { separator: true },
    {
      id: `hex:paste:${groupPath}`,
      label: 'Paste',
      shortcut: 'Ctrl+V',
      enabled: !!hasClipboard,
    },
  ];
}

function groupItems(target, { hasClipboard }) {
  const { groupPath } = target;
  const name = groupPath.split('/').pop() || groupPath;
  const ancestorChain = buildAncestorChain(groupPath);
  return [
    { id: `hex:newFile:${groupPath}`, label: `New File in ${name}…`, icon: '+' },
    { id: `hex:newFolder:${groupPath}`, label: `New Folder in ${name}…`, icon: '▢' },
    { separator: true },
    { id: `hex:renameGroup:${groupPath}`, label: 'Rename Group…', shortcut: 'F2', icon: '✎' },
    { id: `hex:deleteGroup:${groupPath}`, label: 'Delete Group', icon: '✕', destructive: true },
    { separator: true },
    {
      label: 'Move Out To',
      enabled: ancestorChain.length > 0,
      submenu: buildMoveOutSubmenu(groupPath, ancestorChain, 'group'),
    },
    { separator: true },
    { id: `hex:copyPath:${groupPath}`, label: 'Copy Path' },
    { id: `hex:revealInExplorer:${groupPath}`, label: 'Reveal in File Explorer' },
  ];
}

function rootItems({ hasClipboard, workspace }) {
  return [
    { id: 'hex:newFileRoot', label: 'New File…', icon: '+' },
    { id: 'hex:newFolderRoot', label: 'New Folder…', icon: '▢' },
    { separator: true },
    {
      id: 'hex:pasteRoot',
      label: 'Paste',
      shortcut: 'Ctrl+V',
      enabled: !!hasClipboard,
    },
    { separator: true },
    { id: 'hex:refresh', label: 'Refresh' },
    {
      id: 'hex:revealInExplorer:.',
      label: 'Reveal Workspace in File Explorer',
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
  // Drop the leaf; ancestors are all parents up to root
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
  // Immediate parent ↑, then each ancestor up to root
  for (let i = ancestorChain.length - 1; i >= 0; i--) {
    const ancestor = ancestorChain[i];
    const label = ancestor.split('/').pop() || ancestor;
    items.push({
      id: `hex:moveTo:${kind}:${path}:${ancestor}`,
      label: i === ancestorChain.length - 1 ? `↑ ${label} (parent)` : label,
    });
  }
  items.push({
    id: `hex:moveTo:${kind}:${path}:.`,
    label: 'Workspace root',
  });
  return items;
}
