/**
 * BookmarksPanel — workspace bookmarks browser.
 *
 * Grouped by file. Click a bookmark to open the file and jump to the
 * line. Inline editable note per bookmark. Delete per-item or clear all.
 */

import { useMemo, useState } from 'react';
import { useBookmarksStore } from '../../stores/bookmarksStore.js';
import { useEditorStore } from '../../stores/editorStore.js';
import { useJumplistStore } from '../../stores/jumplistStore.js';
import { W } from '../../theme/window-tokens.js';
import { Bookmark, Trash2, Edit3 } from 'lucide-react';

export default function BookmarksPanel() {
  const bookmarks = useBookmarksStore(s => s.bookmarks);
  const remove = useBookmarksStore(s => s.remove);
  const clear = useBookmarksStore(s => s.clear);
  const setNote = useBookmarksStore(s => s.setNote);
  const openFile = useEditorStore(s => s.openFile);
  const jumpPush = useJumplistStore(s => s.push);
  const [editingId, setEditingId] = useState(null);
  const [editValue, setEditValue] = useState('');

  const grouped = useMemo(() => {
    const map = new Map();
    for (const bm of bookmarks) {
      if (!map.has(bm.path)) map.set(bm.path, []);
      map.get(bm.path).push(bm);
    }
    // Sort within each file by line
    for (const [, list] of map) list.sort((a, b) => a.line - b.line);
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [bookmarks]);

  const handleJump = (bm) => {
    jumpPush({ path: bm.path, line: bm.line, col: bm.col, label: bm.label });
    openFile(bm.path);
  };

  const startEdit = (bm) => {
    setEditingId(bm.id);
    setEditValue(bm.note || '');
  };

  const saveEdit = () => {
    if (editingId) setNote(editingId, editValue);
    setEditingId(null);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: W.bg1, color: W.text }}>
      {/* Header */}
      <div
        style={{
          flexShrink: 0,
          padding: `${W.s3}px ${W.s3}px`,
          borderBottom: `1px solid ${W.border}`,
          background: W.bg2,
          display: 'flex',
          alignItems: 'center',
          gap: W.s2,
        }}
      >
        <Bookmark size={14} color={W.accent} />
        <span style={{ flex: 1, fontSize: W.fontLg, fontWeight: W.fontWeightSemi }}>
          Bookmarks
        </span>
        <span style={{ fontSize: W.fontSm, color: W.textMuted }}>{bookmarks.length}</span>
        {bookmarks.length > 0 && (
          <button
            onClick={() => { if (confirm('Clear all bookmarks?')) clear(); }}
            title="Clear all"
            style={{ background: 'transparent', border: 'none', color: W.textDim, cursor: 'pointer', padding: 2, display: 'flex' }}
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {bookmarks.length === 0 && (
          <div style={{ padding: W.s4, textAlign: 'center', color: W.textDim, fontSize: W.fontSm }}>
            No bookmarks yet.
            <div style={{ marginTop: W.s2, color: W.textGhost, fontSize: 11 }}>Ctrl+F2 in the editor to add one.</div>
          </div>
        )}
        {grouped.map(([path, items]) => (
          <div key={path} style={{ borderBottom: `1px solid ${W.borderSubtle}` }}>
            <div
              style={{
                padding: `${W.s2}px ${W.s3}px`,
                fontSize: W.fontSm,
                color: W.textMuted,
                fontFamily: '"JetBrains Mono", monospace',
                background: W.bg0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={path}
            >
              {path}
            </div>
            {items.map((bm) => (
              <div
                key={bm.id}
                style={{
                  padding: `${W.s2}px ${W.s3}px`,
                  borderBottom: `1px solid ${W.borderSubtle}`,
                  display: 'flex',
                  gap: W.s2,
                  alignItems: 'flex-start',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = W.bg2; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <button
                  onClick={() => handleJump(bm)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: W.accent,
                    cursor: 'pointer',
                    fontFamily: '"JetBrains Mono", monospace',
                    fontSize: W.fontSm,
                    padding: 0,
                    width: 40,
                    textAlign: 'right',
                    flexShrink: 0,
                  }}
                >
                  {bm.line + 1}
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <button
                    onClick={() => handleJump(bm)}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: W.text,
                      textAlign: 'left',
                      padding: 0,
                      cursor: 'pointer',
                      fontFamily: '"JetBrains Mono", monospace',
                      fontSize: 11,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      display: 'block',
                      width: '100%',
                    }}
                  >
                    {bm.label || '(line)'}
                  </button>
                  {editingId === bm.id ? (
                    <input
                      autoFocus
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={saveEdit}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveEdit();
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      placeholder="Note…"
                      style={{
                        marginTop: 2,
                        width: '100%',
                        background: W.bg0,
                        border: `1px solid ${W.borderHi}`,
                        borderRadius: W.radius1,
                        color: W.text,
                        fontSize: W.fontSm,
                        padding: '2px 6px',
                        outline: 'none',
                      }}
                    />
                  ) : bm.note ? (
                    <div
                      onClick={() => startEdit(bm)}
                      style={{ marginTop: 2, fontSize: W.fontSm, color: W.textDim, cursor: 'pointer' }}
                    >
                      {bm.note}
                    </div>
                  ) : null}
                </div>
                <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                  <button
                    onClick={() => startEdit(bm)}
                    title="Edit note"
                    style={{ background: 'transparent', border: 'none', color: W.textDim, cursor: 'pointer', padding: 2, display: 'flex' }}
                  >
                    <Edit3 size={11} />
                  </button>
                  <button
                    onClick={() => remove(bm.id)}
                    title="Delete"
                    style={{ background: 'transparent', border: 'none', color: W.textDim, cursor: 'pointer', padding: 2, display: 'flex' }}
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
