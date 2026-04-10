import { useEffect, useState, useRef, useCallback } from 'react';
import { useGraphStore } from '../../hooks/useGraph.js';
import { getNodeColor, getStatusColor, getSectionColor } from '../../utils/colors.js';
import { colors } from '../../theme/tokens.js';
import { EditorView, basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
// oneDark removed — using custom honey theme
import { EditorState } from '@codemirror/state';
import { Pencil, Eye, Save, GitBranch } from 'lucide-react';

export default function DetailPanel() {
  const selectedId = useGraphStore(s => s.selectedNode);
  const selectedGroup = useGraphStore(s => s.selectedGroup);
  const nodes = useGraphStore(s => s.nodes);
  const edges = useGraphStore(s => s.edges);
  const commits = useGraphStore(s => s.commits);
  const readmeMap = useGraphStore(s => s.readmeMap);
  const gitStatus = useGraphStore(s => s.gitStatus);
  const setSelectedNode = useGraphStore(s => s.setSelectedNode);
  const setSelectedGroup = useGraphStore(s => s.setSelectedGroup);
  const saveFile = useGraphStore(s => s.saveFile);

  const [fileContent, setFileContent] = useState('');
  const [activeTab, setActiveTab] = useState('code');
  const [editing, setEditing] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null); // null | 'saving' | 'saved' | 'unsaved'
  const editorRef = useRef(null);
  const editorViewRef = useRef(null);
  const saveTimerRef = useRef(null);
  const lastSavedRef = useRef('');

  const node = selectedId ? nodes.find(n => n.id === selectedId) : null;

  // Check if file has uncommitted changes
  const isModified = gitStatus && node && (
    gitStatus.modified?.includes(node.id) ||
    gitStatus.not_added?.includes(node.id) ||
    gitStatus.staged?.includes(node.id)
  );

  useEffect(() => {
    if (!node) { setFileContent(''); setEditing(false); return; }
    setActiveTab('code'); // Content tab is default
    setSaveStatus(null);
    fetch(`/api/file?path=${encodeURIComponent(node.id)}`)
      .then(r => r.json())
      .then(data => {
        const content = data.content || '';
        setFileContent(content);
        lastSavedRef.current = content;
      })
      .catch(() => setFileContent(''));
  }, [node?.id]);

  // Destroy editor on unmount or when switching nodes
  useEffect(() => {
    return () => {
      if (editorViewRef.current) {
        editorViewRef.current.destroy();
        editorViewRef.current = null;
      }
    };
  }, [node?.id]);

  // Create/destroy CodeMirror when toggling edit mode
  useEffect(() => {
    if (!editing || !editorRef.current || !node) return;

    // Destroy previous instance
    if (editorViewRef.current) {
      editorViewRef.current.destroy();
      editorViewRef.current = null;
    }

    const view = new EditorView({
      state: EditorState.create({
        doc: fileContent,
        extensions: [
          basicSetup,
          markdown(),
          // Honey-themed editor (no oneDark)
          EditorView.theme({
            '&': { height: '100%', fontSize: '14px', background: colors.bgDeep },
            '.cm-content': { fontFamily: '"JetBrains Mono", monospace', padding: '12px 0', color: colors.textPrimary, caretColor: colors.accent },
            '.cm-gutters': { background: colors.bgBase, border: 'none', color: colors.textTertiary },
            '.cm-activeLineGutter': { background: 'rgba(232,146,12,0.08)' },
            '.cm-activeLine': { background: 'rgba(232,146,12,0.04)' },
            '.cm-scroller': { overflow: 'auto' },
            '.cm-cursor': { borderLeftColor: colors.accent },
            '.cm-selectionBackground': { background: 'rgba(232,146,12,0.15) !important' },
            '&.cm-focused .cm-selectionBackground': { background: 'rgba(232,146,12,0.2) !important' },
            '.cm-matchingBracket': { background: 'rgba(232,146,12,0.2)', outline: 'none' },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const newContent = update.state.doc.toString();
              setFileContent(newContent);
              setSaveStatus('unsaved');

              // Auto-save after 2s
              clearTimeout(saveTimerRef.current);
              saveTimerRef.current = setTimeout(() => {
                doSave(node.id, newContent);
              }, 2000);
            }
          }),
          // Ctrl+S handler
          EditorView.domEventHandlers({
            keydown(event) {
              if ((event.metaKey || event.ctrlKey) && event.key === 's') {
                event.preventDefault();
                const content = editorViewRef.current?.state.doc.toString();
                if (content != null && node) doSave(node.id, content);
                return true;
              }
            },
          }),
        ],
      }),
      parent: editorRef.current,
    });

    editorViewRef.current = view;

    return () => {
      clearTimeout(saveTimerRef.current);
      view.destroy();
      editorViewRef.current = null;
    };
  }, [editing, node?.id]);

  const doSave = useCallback(async (path, content) => {
    if (content === lastSavedRef.current) {
      setSaveStatus('saved');
      return;
    }
    setSaveStatus('saving');
    const result = await saveFile(path, content);
    if (result.ok) {
      lastSavedRef.current = content;
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(null), 2000);
    } else {
      setSaveStatus('unsaved');
    }
  }, [saveFile]);

  // Group panel
  if (selectedGroup && !selectedId) {
    return <GroupPanelWrapper
      section={selectedGroup}
      readmeMap={readmeMap}
      nodes={nodes}
      onClose={() => setSelectedGroup(null)}
      onNodeClick={(id) => { setSelectedGroup(null); setSelectedNode(id); }}
    />;
  }

  if (!node) return null;

  const sectionColor = getNodeColor(node);
  const statusClr = getStatusColor(node.status);

  const connections = edges
    .filter(e => {
      const src = typeof e.source === 'object' ? e.source.id : e.source;
      const tgt = typeof e.target === 'object' ? e.target.id : e.target;
      return src === node.id || tgt === node.id;
    })
    .map(e => {
      const src = typeof e.source === 'object' ? e.source.id : e.source;
      const tgt = typeof e.target === 'object' ? e.target.id : e.target;
      const targetId = src === node.id ? tgt : src;
      const direction = src === node.id ? '→' : '←';
      const targetNode = nodes.find(n => n.id === targetId);
      return { id: targetId, direction, type: e.type, label: targetNode?.label || targetId, section: targetNode?.section };
    });

  const fileCommits = commits.slice(0, 8);

  return (
    <div
      className="absolute top-0 right-0 h-full z-40 flex flex-col"
      style={{
        width: 'min(55vw, 720px)',
        minWidth: '520px',
        background: colors.bgBase,
        borderLeft: `1px solid ${colors.border}`,
        boxShadow: '-12px 0 48px rgba(120,80,20,0.15)',
      }}
    >
      {/* Header */}
      <div className="flex-shrink-0 px-6 py-4" style={{ borderBottom: `1px solid ${colors.border}` }}>
        <div className="flex items-center justify-between mb-3">
          <button
            onClick={() => setSelectedNode(null)}
            className="text-[14px] transition-fast px-3 py-1.5 rounded-md"
            style={{ color: colors.textSecondary }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(180,140,60,0.05)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            ← Back
          </button>
          <div className="flex items-center gap-2">
            {isModified && (
              <span className="px-2 py-0.5 rounded text-[11px] font-medium" style={{ background: 'rgba(232,146,12,0.15)', color: '#F0A030' }}>
                Modified
              </span>
            )}
            <span className="text-[12px] font-mono px-2 py-1 rounded-md" style={{ color: colors.textTertiary, background: 'rgba(180,140,60,0.04)' }}>
              {node.id}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="w-1.5 self-stretch rounded-full" style={{ background: sectionColor }} />
          <div className="flex-1 min-w-0">
            <h2 className="text-[22px] font-semibold leading-tight truncate" style={{ color: colors.textPrimary }}>
              {node.title || node.label}
            </h2>
            <div className="flex items-center gap-2.5 mt-1.5 text-[13px]" style={{ color: colors.textSecondary }}>
              <span style={{ color: sectionColor }}>{node.type}</span>
              <span style={{ color: colors.textTertiary }}>·</span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full" style={{ background: statusClr }} />
                {node.status}
              </span>
              <span style={{ color: colors.textTertiary }}>·</span>
              <span>{node.section}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex-shrink-0 flex items-center px-6 gap-1" style={{ borderBottom: `1px solid ${colors.border}` }}>
        <div className="flex-1 flex gap-1">
          {[
            { id: 'code', label: 'Content' },
            { id: 'info', label: 'Overview' },
            { id: 'connections', label: `Links (${connections.length})` },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => { setActiveTab(tab.id); if (tab.id !== 'code') setEditing(false); }}
              className="px-4 py-3 text-[14px] font-medium transition-fast relative"
              style={{ color: activeTab === tab.id ? colors.textPrimary : colors.textTertiary }}
              onMouseEnter={e => { if (activeTab !== tab.id) e.currentTarget.style.color = colors.textSecondary; }}
              onMouseLeave={e => { if (activeTab !== tab.id) e.currentTarget.style.color = colors.textTertiary; }}
            >
              {tab.label}
              {activeTab === tab.id && (
                <div className="absolute bottom-0 left-2 right-2 h-[2px] rounded-full" style={{ background: colors.accent }} />
              )}
            </button>
          ))}
        </div>

        {/* Edit/Preview toggle + save status (only on Content tab) */}
        {activeTab === 'code' && (
          <div className="flex items-center gap-2">
            {saveStatus && (
              <span className="text-[11px]" style={{
                color: saveStatus === 'saved' ? '#22C55E' : saveStatus === 'saving' ? '#EAB308' : '#F0A030'
              }}>
                {saveStatus === 'saved' ? 'Saved' : saveStatus === 'saving' ? 'Saving...' : 'Unsaved'}
              </span>
            )}
            <button
              onClick={() => setEditing(!editing)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium transition-fast"
              style={{
                background: editing ? 'rgba(232,146,12,0.15)' : 'rgba(180,140,60,0.05)',
                color: editing ? colors.accent : colors.textSecondary,
                border: `1px solid ${editing ? 'rgba(232,146,12,0.3)' : 'transparent'}`,
              }}
            >
              {editing ? <><Eye size={13} /> Preview</> : <><Pencil size={13} /> Edit</>}
            </button>
          </div>
        )}
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'code' && (
          editing ? (
            <div ref={editorRef} className="h-full" style={{ background: colors.bgDeep }} />
          ) : (
            <ContentTab content={fileContent} />
          )
        )}
        {activeTab === 'info' && <InfoTab node={node} fileCommits={fileCommits} sectionColor={sectionColor} />}
        {activeTab === 'connections' && <ConnectionsTab connections={connections} setSelectedNode={setSelectedNode} />}
      </div>
    </div>
  );
}

// ─── Info Tab ──────────────────────────────────────────────

function InfoTab({ node, fileCommits, sectionColor }) {
  return (
    <div className="px-6 py-5 space-y-6">
      <div className="space-y-3">
        {node.tags.length > 0 && (
          <MetaRow label="Tags" value={
            <div className="flex flex-wrap gap-2">
              {node.tags.map(t => (
                <span key={t} className="px-2.5 py-1 rounded-md text-[13px]" style={{ background: 'rgba(180,140,60,0.06)', color: colors.textSecondary }}>
                  {t}
                </span>
              ))}
            </div>
          } />
        )}
        {node.contributors?.length > 0 && <MetaRow label="Contributors" value={node.contributors.join(', ')} />}
        {node.changeCount > 0 && <MetaRow label="Changes" value={`${node.changeCount} commits`} />}
        {node.lastModified && <MetaRow label="Modified" value={new Date(node.lastModified).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} />}
      </div>

      {fileCommits.length > 0 && (
        <Section title="Recent Commits">
          <div className="space-y-0.5">
            {fileCommits.map((commit, i) => (
              <div key={i} className="flex items-start gap-3 px-4 py-2.5 rounded-lg transition-fast"
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(180,140,60,0.03)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                <span className="mt-2 w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: colors.accent }} />
                <div className="min-w-0 flex-1">
                  <div className="text-[14px]" style={{ color: colors.textSecondary }}>{commit.message}</div>
                  <div className="text-[13px] mt-1" style={{ color: colors.textTertiary }}>
                    {commit.author} · {new Date(commit.date).toLocaleDateString()}
                  </div>
                </div>
                <span className="text-[12px] font-mono flex-shrink-0 mt-0.5 px-2 py-0.5 rounded" style={{ color: colors.textTertiary, background: 'rgba(180,140,60,0.03)' }}>
                  {commit.shortHash}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

// ─── Content Tab ──────────────────────────────────────────

function ContentTab({ content }) {
  if (!content) {
    return <div className="text-center py-16 text-[15px]" style={{ color: colors.textTertiary }}>Loading...</div>;
  }
  const blocks = parseMarkdown(content);
  return (
    <div className="px-6 py-5">
      <div className="space-y-1">
        {blocks.map((block, i) => renderBlock(block, i))}
      </div>
    </div>
  );
}

function parseMarkdown(content) {
  const lines = content.split('\n');
  const blocks = [];
  let i = 0, inCode = false, codeLines = [], codeLang = '';

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      if (inCode) {
        blocks.push({ type: 'code', lang: codeLang, content: codeLines.join('\n') });
        codeLines = []; codeLang = ''; inCode = false;
      } else { inCode = true; codeLang = line.slice(3).trim(); }
      i++; continue;
    }
    if (inCode) { codeLines.push(line); i++; continue; }
    if (i === 0 && line === '---') {
      const fmLines = [];
      i++;
      while (i < lines.length && lines[i] !== '---') { fmLines.push(lines[i]); i++; }
      blocks.push({ type: 'frontmatter', content: fmLines.join('\n') });
      i++; continue;
    }
    const hm = line.match(/^(#{1,6})\s+(.+)/);
    if (hm) { blocks.push({ type: 'heading', level: hm[1].length, content: hm[2] }); i++; continue; }
    if (line.startsWith('> ')) { blocks.push({ type: 'blockquote', content: line.slice(2) }); i++; continue; }
    if (line.startsWith('|')) {
      const tl = [];
      while (i < lines.length && lines[i].startsWith('|')) { tl.push(lines[i]); i++; }
      blocks.push({ type: 'table', content: tl }); continue;
    }
    if (line.match(/^[-*]\s/) || line.match(/^\d+\.\s/)) {
      blocks.push({ type: 'list-item', content: line.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, ''), ordered: !!line.match(/^\d/) });
      i++; continue;
    }
    if (line.match(/^---+$/) || line.match(/^\*\*\*+$/)) { blocks.push({ type: 'hr' }); i++; continue; }
    if (line.trim() === '') { blocks.push({ type: 'empty' }); i++; continue; }
    blocks.push({ type: 'paragraph', content: line }); i++;
  }
  return blocks;
}

function renderBlock(block, key) {
  switch (block.type) {
    case 'frontmatter':
      return (
        <div key={key} className="rounded-lg px-4 py-3 mb-4 text-[13px] font-mono leading-relaxed"
          style={{ background: 'rgba(232,146,12,0.06)', border: '1px solid rgba(232,146,12,0.12)', color: colors.textTertiary }}>
          {block.content.split('\n').map((l, i) => {
            const [k, ...v] = l.split(':');
            return <div key={i}><span style={{ color: '#E09020' }}>{k}</span>{v.length > 0 && <span style={{ color: colors.textSecondary }}>: {v.join(':').trim()}</span>}</div>;
          })}
        </div>
      );
    case 'heading': {
      const sizes = { 1: 'text-[22px]', 2: 'text-[19px]', 3: 'text-[16px]', 4: 'text-[15px]', 5: 'text-[14px]', 6: 'text-[14px]' };
      const mt = block.level <= 2 ? 'mt-6 mb-2' : 'mt-4 mb-1';
      return (
        <div key={key} className={`${sizes[block.level]} font-semibold ${mt}`}
          style={{ color: block.level <= 2 ? '#636E7B' : '#636E7B' }}>
          {renderInline(block.content)}
          {block.level <= 2 && <div className="mt-2 h-px" style={{ background: 'rgba(180,140,60,0.06)' }} />}
        </div>
      );
    }
    case 'blockquote':
      return <div key={key} className="pl-4 py-1 my-2 text-[14px] italic" style={{ borderLeft: '3px solid #636E7B', color: '#3FB950' }}>{renderInline(block.content)}</div>;
    case 'code':
      return (
        <pre key={key} className="rounded-lg px-4 py-3 my-3 text-[13px] leading-[1.7] overflow-x-auto"
          style={{ fontFamily: '"JetBrains Mono", monospace', background: colors.bgDeep, border: `1px solid ${colors.border}`, color: '#6B4423' }}>
          {block.lang && <div className="text-[11px] mb-2 -mt-0.5" style={{ color: colors.textTertiary }}>{block.lang}</div>}
          {block.content}
        </pre>
      );
    case 'table': {
      const rows = block.content.map(r => r.split('|').filter(c => c.trim()).map(c => c.trim()));
      const header = rows[0];
      const isSep = (r) => r.every(c => c.match(/^[-:]+$/));
      const dataRows = rows.filter(r => !isSep(r)).slice(1);
      return (
        <div key={key} className="my-3 overflow-x-auto rounded-lg" style={{ border: `1px solid ${colors.border}` }}>
          <table className="w-full text-[13px]">
            <thead><tr style={{ background: 'rgba(180,140,60,0.03)' }}>
              {header?.map((h, i) => <th key={i} className="px-3 py-2 text-left font-medium" style={{ color: colors.textSecondary, borderBottom: `1px solid ${colors.border}` }}>{h}</th>)}
            </tr></thead>
            <tbody>{dataRows.map((row, ri) => (
              <tr key={ri} style={{ borderBottom: ri < dataRows.length - 1 ? '1px solid rgba(180,140,60,0.03)' : 'none' }}>
                {row.map((cell, ci) => <td key={ci} className="px-3 py-2" style={{ color: colors.textTertiary }}>{renderInline(cell)}</td>)}
              </tr>
            ))}</tbody>
          </table>
        </div>
      );
    }
    case 'list-item':
      return <div key={key} className="flex gap-2.5 text-[14px] py-0.5 pl-2" style={{ color: colors.textSecondary }}><span className="mt-2 w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: colors.textTertiary }} /><span>{renderInline(block.content)}</span></div>;
    case 'hr': return <div key={key} className="my-4 h-px" style={{ background: 'rgba(180,140,60,0.06)' }} />;
    case 'empty': return <div key={key} className="h-2" />;
    case 'paragraph':
      return <div key={key} className="text-[14px] leading-[1.75] py-0.5" style={{ color: colors.textSecondary }}>{renderInline(block.content)}</div>;
    default: return null;
  }
}

function renderInline(text) {
  if (!text) return text;
  let result = text;
  const elements = [];
  let key = 0;
  result = result.replace(/\*\*(.+?)\*\*/g, (_, m) => `%%B${elements.push(<strong key={key++} style={{ color: colors.textPrimary, fontWeight: 600 }}>{m}</strong>) - 1}%%`);
  result = result.replace(/`([^`]+)`/g, (_, m) => `%%C${elements.push(<code key={key++} className="px-1.5 py-0.5 rounded text-[12px]" style={{ background: 'rgba(245,158,11,0.1)', color: '#E09020', fontFamily: '"JetBrains Mono", monospace' }}>{m}</code>) - 1}%%`);
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t) => `%%L${elements.push(<span key={key++} style={{ color: '#E09020' }}>{t}</span>) - 1}%%`);
  const parts = result.split(/%%(B|C|L)(\d+)%%/);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === 'B' || p === 'C' || p === 'L') { out.push(elements[parseInt(parts[i + 1])]); i++; }
    else if (p && !p.match(/^\d+$/)) out.push(p);
  }
  return out.length > 0 ? out : text;
}

// ─── Connections Tab ──────────────────────────────────────

function ConnectionsTab({ connections, setSelectedNode }) {
  if (!connections.length) return <div className="text-center py-16 text-[15px]" style={{ color: colors.textTertiary }}>No connections</div>;
  return (
    <div className="px-6 py-5 space-y-1">
      {connections.map((conn, i) => (
        <button key={i} className="w-full text-left px-4 py-3 rounded-lg transition-fast flex items-center gap-3"
          style={{ color: colors.textSecondary }}
          onMouseEnter={e => e.currentTarget.style.background = 'rgba(180,140,60,0.04)'}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          onClick={() => setSelectedNode(conn.id)}>
          <span className="text-[13px] font-mono w-6 text-center" style={{ color: colors.textTertiary }}>{conn.direction}</span>
          <div className="flex-1 min-w-0">
            <div className="text-[15px] truncate">{conn.label}</div>
            <div className="text-[12px] mt-0.5" style={{ color: colors.textTertiary }}>{conn.type.replace(/-/g, ' ')}{conn.section ? ` · ${conn.section}` : ''}</div>
          </div>
        </button>
      ))}
    </div>
  );
}

// ─── Shared ────────────────────────────────────────────────

function Section({ title, children }) {
  return <div><h3 className="text-[13px] font-medium uppercase tracking-wider mb-3" style={{ color: colors.textTertiary }}>{title}</h3>{children}</div>;
}

function MetaRow({ label, value }) {
  return <div className="flex items-start gap-4 text-[15px]"><span className="w-28 flex-shrink-0 text-[14px]" style={{ color: colors.textTertiary }}>{label}</span><span style={{ color: colors.textSecondary }}>{value}</span></div>;
}

// ─── Group Panel ──────────────────────────────────────────

function GroupPanelWrapper({ section, readmeMap, nodes, onClose, onNodeClick }) {
  const [readmeContent, setReadmeContent] = useState('');
  const readme = readmeMap[section];
  const groupNodes = nodes.filter(n => n.section === section);
  const color = getSectionColor(section);

  useEffect(() => {
    if (readme?.id) {
      fetch(`/api/file?path=${encodeURIComponent(readme.id)}`)
        .then(r => r.json())
        .then(data => setReadmeContent(data.content || ''))
        .catch(() => setReadmeContent(''));
    }
  }, [readme?.id]);

  const blocks = readmeContent ? parseMarkdown(readmeContent) : [];

  return (
    <div className="absolute top-0 right-0 h-full z-40 flex flex-col"
      style={{ width: 'min(55vw, 720px)', minWidth: '520px', background: colors.bgBase, borderLeft: `1px solid ${colors.border}`, boxShadow: '-12px 0 48px rgba(120,80,20,0.15)' }}>
      <div className="flex-shrink-0 px-6 py-5" style={{ borderBottom: `1px solid ${colors.border}` }}>
        <div className="flex items-center justify-between mb-4">
          <button onClick={onClose} className="text-[14px] px-3 py-1.5 rounded-md" style={{ color: colors.textSecondary }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(180,140,60,0.05)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>← Back</button>
        </div>
        <div className="flex items-center gap-4">
          <div className="w-3 self-stretch rounded-full" style={{ background: color }} />
          <div>
            <h2 className="text-[26px] font-bold" style={{ color }}>{section.charAt(0).toUpperCase() + section.slice(1)}</h2>
            <div className="text-[14px] mt-1" style={{ color: colors.textSecondary }}>{groupNodes.length} files · {readme?.title || 'No description'}</div>
          </div>
        </div>
      </div>
      <div className="flex-shrink-0 px-6 py-4" style={{ borderBottom: `1px solid ${colors.border}` }}>
        <h3 className="text-[12px] font-medium uppercase tracking-wider mb-3" style={{ color: colors.textTertiary }}>Files</h3>
        <div className="flex flex-wrap gap-2">
          {groupNodes.map(n => (
            <button key={n.id} onClick={() => onNodeClick(n.id)}
              className="px-3 py-1.5 rounded-lg text-[13px] transition-fast"
              style={{ background: 'rgba(180,140,60,0.04)', color: colors.textSecondary, border: '1px solid rgba(180,140,60,0.06)' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(180,140,60,0.08)'; e.currentTarget.style.borderColor = color; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(180,140,60,0.04)'; e.currentTarget.style.borderColor = 'rgba(180,140,60,0.06)'; }}>
              {n.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {blocks.length > 0 ? (
          <div className="space-y-1">{blocks.map((b, i) => renderBlock(b, i))}</div>
        ) : (
          <div className="text-center py-12 text-[14px]" style={{ color: colors.textTertiary }}>{readme ? 'Loading README...' : 'No README for this section'}</div>
        )}
      </div>
    </div>
  );
}
