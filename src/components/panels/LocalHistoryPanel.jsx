/**
 * LocalHistoryPanel — JetBrains-style per-save timeline for the active file.
 *
 * Lists every saved version of the currently active tab with relative
 * timestamps. Clicking a snapshot opens a two-pane diff-like preview:
 * on the left the snapshot content, on the right the current content.
 * The "Restore" button dispatches the snapshot's content into the
 * editor as a dirty edit (user can still undo).
 */

import { useMemo, useState, useEffect } from 'react';
import { useLocalHistoryStore } from '../../stores/localHistoryStore.js';
import { useEditorStore } from '../../stores/editorStore.js';
import { W } from '../../theme/window-tokens.js';
import { Clock, RotateCcw, Trash2 } from 'lucide-react';

function relativeTime(ts) {
  const d = Date.now() - ts;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  if (d < 604_800_000) return `${Math.floor(d / 86_400_000)}d ago`;
  const date = new Date(ts);
  return date.toLocaleDateString();
}

export default function LocalHistoryPanel() {
  const activeTab = useEditorStore(s => s.activeTab);
  const tabs = useEditorStore(s => s.tabs);
  const updateContent = useEditorStore(s => s.updateContent);
  const forFile = useLocalHistoryStore(s => s.forFile);
  const clearFile = useLocalHistoryStore(s => s.clearFile);
  const entries = useLocalHistoryStore(s => s.entries); // for reactivity

  const snapshots = useMemo(() => {
    if (!activeTab) return [];
    return forFile(activeTab);
  }, [activeTab, entries, forFile]);

  const [selected, setSelected] = useState(null);

  useEffect(() => {
    // Clear selection when tab changes
    setSelected(null);
  }, [activeTab]);

  const activeFile = tabs.find(t => t.path === activeTab);

  const handleRestore = (snapshot) => {
    if (!activeTab) return;
    if (!confirm(`Restore ${activeTab} to version from ${relativeTime(snapshot.t)}? This will create an unsaved edit.`)) return;
    updateContent(activeTab, snapshot.content);
    // Find the editor view and replace its doc — we need to dispatch a
    // transaction, not just update the store. The editor's updateListener
    // will see the outside-driven content change on next render.
    // Simpler path: force a re-open via store which rebuilds the editor.
    const existing = useEditorStore.getState().tabs.find(t => t.path === activeTab);
    if (existing) {
      // Temporarily close + reopen to trigger editor remount with new content
      useEditorStore.setState({
        tabs: useEditorStore.getState().tabs.map((t) =>
          t.path === activeTab ? { ...t, content: snapshot.content, dirty: true } : t
        ),
      });
    }
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
        <Clock size={14} color={W.accent} />
        <span style={{ flex: 1, fontSize: W.fontLg, fontWeight: W.fontWeightSemi }}>
          Local History
        </span>
        <span style={{ fontSize: W.fontSm, color: W.textMuted }}>{snapshots.length}</span>
        {snapshots.length > 0 && (
          <button
            onClick={() => { if (confirm('Clear history for this file?')) clearFile(activeTab); }}
            title="Clear file history"
            style={{ background: 'transparent', border: 'none', color: W.textDim, cursor: 'pointer', padding: 2, display: 'flex' }}
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>

      {/* Active file */}
      {activeFile && (
        <div
          style={{
            flexShrink: 0,
            padding: `${W.s2}px ${W.s3}px`,
            fontSize: W.fontSm,
            color: W.textMuted,
            fontFamily: '"JetBrains Mono", monospace',
            background: W.bg0,
            borderBottom: `1px solid ${W.borderSubtle}`,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={activeFile.path}
        >
          {activeFile.path}
        </div>
      )}

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {!activeTab && (
          <div style={{ padding: W.s4, textAlign: 'center', color: W.textDim, fontSize: W.fontSm }}>
            No file open.
          </div>
        )}
        {activeTab && snapshots.length === 0 && (
          <div style={{ padding: W.s4, textAlign: 'center', color: W.textDim, fontSize: W.fontSm }}>
            No history yet.
            <div style={{ marginTop: W.s2, color: W.textGhost, fontSize: 11 }}>
              Snapshots are created on save.
            </div>
          </div>
        )}
        {snapshots.map((snap, i) => {
          const isSelected = selected === i;
          const lines = snap.content.split('\n').length;
          const chars = snap.content.length;
          return (
            <div
              key={snap.t}
              onClick={() => setSelected(isSelected ? null : i)}
              style={{
                padding: `${W.s2}px ${W.s3}px`,
                borderBottom: `1px solid ${W.borderSubtle}`,
                cursor: 'pointer',
                background: isSelected ? 'rgba(240, 160, 48, 0.08)' : 'transparent',
                borderLeft: isSelected ? `2px solid ${W.accent}` : '2px solid transparent',
              }}
              onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = W.bg2; }}
              onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: W.s2 }}>
                <Clock size={10} color={W.textDim} />
                <span style={{ color: W.text, fontSize: W.fontSm }}>
                  {relativeTime(snap.t)}
                </span>
                <span style={{ color: W.textGhost, fontSize: 10, marginLeft: 'auto' }}>
                  {lines}L · {chars}ch
                </span>
              </div>
              {isSelected && (
                <div style={{ marginTop: W.s2 }}>
                  <pre
                    style={{
                      maxHeight: 200,
                      overflow: 'auto',
                      background: W.bg0,
                      border: `1px solid ${W.border}`,
                      borderRadius: W.radius1,
                      padding: W.s2,
                      fontSize: 10,
                      fontFamily: '"JetBrains Mono", monospace',
                      color: W.textDim,
                      margin: 0,
                      whiteSpace: 'pre',
                    }}
                  >
                    {snap.content.split('\n').slice(0, 40).join('\n')}
                    {snap.content.split('\n').length > 40 && '\n…'}
                  </pre>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleRestore(snap); }}
                    style={{
                      marginTop: W.s2,
                      padding: `4px ${W.s3}px`,
                      background: W.accent,
                      border: 'none',
                      borderRadius: W.radius1,
                      color: W.bg0,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      fontSize: W.fontSm,
                      fontWeight: W.fontWeightSemi,
                    }}
                  >
                    <RotateCcw size={11} /> Restore this version
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
