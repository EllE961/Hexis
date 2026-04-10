/**
 * Cell drag-and-drop helpers.
 *
 * Pure functions — no React state, no refs. Consumed by HexCanvas's
 * onPointerDown/Move/Up handlers via a mutable ref shape.
 *
 * Drop validation rules (file source):
 *   - Target is an empty slot in the SAME group  → 'noop'
 *   - Target is an empty slot in a DIFFERENT group → 'valid' (move to that group)
 *   - Target is a file cell → 'invalid' (no swap in v1)
 *   - Target is outside any group → 'valid' (move to workspace root)
 *
 * Drop validation rules (group source):
 *   - Target is a descendant of source → 'invalid' (can't nest inside self)
 *   - Target is the current parent → 'noop'
 *   - Target is another group → 'valid' (nest source inside target)
 *   - Target is outside any group → 'valid' (move to root / top-level)
 */

import { pixelToHex } from '../../utils/hexMath.js';

const HEX_SIZE = 30;

/**
 * Initial mutable drag state used by HexCanvas's `cellDragRef`.
 * Start inactive; populated on pointer-down + threshold.
 */
export function makeCellDragState() {
  return {
    active: false,
    kind: null,       // 'file' | 'group'
    path: null,       // source path
    sourceGroupPath: null,
    startX: 0,        // pointer start (world coords)
    startY: 0,
    currentX: 0,      // pointer now (world coords)
    currentY: 0,
    dropTarget: null, // { kind, groupPath?, q, r, status: 'valid'|'noop'|'invalid' }
  };
}

/**
 * Compute the drop target under (worldX, worldY) given the current
 * layout + drag source. Returns a shape the render loop can use to
 * highlight the landing cell/group.
 */
export function computeDropTarget(layout, drag, worldX, worldY) {
  if (!layout) return { kind: 'none', status: 'invalid' };
  const hex = pixelToHex(worldX, worldY, HEX_SIZE);
  const key = `${hex.q},${hex.r}`;
  const owner = layout.cellOwner?.get(key);

  if (drag.kind === 'file') {
    if (owner?.kind === 'file') {
      // Dropping on another file — find the target's owning group via
      // the cell's owner metadata + the layout's file map. If the target
      // is in a DIFFERENT group, treat it as "move into target's group";
      // same-group is a no-op (auto-layout picks the slot anyway).
      const targetFileOwner = layout._fileMap?.get(owner.filePath);
      const targetGroup = targetFileOwner?.group_path || '.';
      if (owner.filePath === drag.path) {
        return { kind: 'file', q: hex.q, r: hex.r, status: 'noop' };
      }
      if (targetGroup === drag.sourceGroupPath) {
        // Same group — nothing to do
        return { kind: 'file', q: hex.q, r: hex.r, status: 'noop' };
      }
      // Cross-group file-on-file → treat as empty-slot in target's group
      return { kind: 'empty', q: hex.q, r: hex.r, groupPath: targetGroup, status: 'valid' };
    }
    if (owner?.kind === 'empty') {
      const targetGroup = owner.groupPath;
      if (targetGroup === drag.sourceGroupPath) {
        return { kind: 'empty', q: hex.q, r: hex.r, groupPath: targetGroup, status: 'noop' };
      }
      return { kind: 'empty', q: hex.q, r: hex.r, groupPath: targetGroup, status: 'valid' };
    }
    // Dropping on bare grid space — INVALID. Moving a file to the
    // workspace root is destructive and should be deliberate, not an
    // accident from an off-target drop. Use the context menu's
    // "Move Out To › Workspace root" instead.
    return { kind: 'root', q: hex.q, r: hex.r, status: 'invalid' };
  }

  if (drag.kind === 'group') {
    const targetGroup = owner?.groupPath || null;
    // Can't nest a group inside itself or its descendants
    if (targetGroup === drag.path || (targetGroup && targetGroup.startsWith(drag.path + '/'))) {
      return { kind: 'group', q: hex.q, r: hex.r, groupPath: targetGroup, status: 'invalid' };
    }
    if (!targetGroup) {
      // Bare grid drop for a group — INVALID. Moving a group to the
      // workspace root (un-nesting it) should be deliberate via the
      // context menu's "Move Group Out To › Workspace root" action,
      // not an accident from dropping slightly off-target.
      return { kind: 'root', q: hex.q, r: hex.r, status: 'invalid' };
    }
    // Dropping into an existing group — already in it?
    if (parentOf(drag.path) === targetGroup) {
      return { kind: 'group', q: hex.q, r: hex.r, groupPath: targetGroup, status: 'noop' };
    }
    return { kind: 'group', q: hex.q, r: hex.r, groupPath: targetGroup, status: 'valid' };
  }

  return { kind: 'none', status: 'invalid' };
}

/**
 * Given a drag source and a valid drop target, compute the NEW path
 * the source should end up at.
 */
export function computeDestinationPath(drag, dropTarget) {
  const leaf = drag.path.split('/').pop();
  if (drag.kind === 'file') {
    if (dropTarget.kind === 'root') return leaf;
    if (dropTarget.kind === 'empty' && dropTarget.groupPath) {
      return `${dropTarget.groupPath}/${leaf}`;
    }
  }
  if (drag.kind === 'group') {
    if (dropTarget.kind === 'root') return leaf;
    if (dropTarget.kind === 'group' && dropTarget.groupPath) {
      return `${dropTarget.groupPath}/${leaf}`;
    }
  }
  return null;
}

function parentOf(path) {
  if (!path || !path.includes('/')) return null;
  return path.slice(0, path.lastIndexOf('/'));
}
