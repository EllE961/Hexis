import { useState, useEffect, useCallback } from 'react';
import { useGraphStore } from '../../hooks/useGraph.js';
import { colors } from '../../theme/tokens.js';
import ConfirmModal from '../common/ConfirmModal.jsx';
import {
  GitBranch, GitCommit, GitMerge, Plus, Upload, Download,
  ChevronDown, ChevronRight, Check, X, RefreshCw,
  ArrowUpCircle, ArrowDownCircle, Circle, Minus,
} from 'lucide-react';

// ─── Helpers ───

function FileStatusBadge({ status }) {
  const config = {
    modified: { label: 'M', color: '#F0A030', bg: 'rgba(232,146,12,0.12)' },
    staged: { label: 'S', color: '#22C55E', bg: 'rgba(34,197,94,0.12)' },
    untracked: { label: 'U', color: '#3B82F6', bg: 'rgba(59,130,246,0.12)' },
    deleted: { label: 'D', color: '#EF4444', bg: 'rgba(239,68,68,0.12)' },
  };
  const c = config[status] || config.modified;
  return (
    <span
      className="inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold flex-shrink-0"
      style={{ background: c.bg, color: c.color }}
    >
      {c.label}
    </span>
  );
}

function SectionHeader({ icon, label, count, expanded, onToggle, action }) {
  return (
    <div className="flex items-center px-4 py-2" style={{ borderBottom: `1px solid rgba(180,140,60,0.03)` }}>
      <button
        className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest"
        style={{ color: colors.textTertiary }}
        onClick={onToggle}
      >
        {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        {icon}
        {label}
        {count > 0 && (
          <span className="ml-1 px-1.5 py-0 rounded-full text-[10px] font-medium"
            style={{ background: 'rgba(180,140,60,0.06)', color: colors.textTertiary }}>
            {count}
          </span>
        )}
      </button>
      {action && <div className="ml-auto">{action}</div>}
    </div>
  );
}

function ActionButton({ icon, label, onClick, primary, danger, disabled, small }) {
  const bg = danger ? 'rgba(239,68,68,0.12)' : primary ? colors.accent : 'rgba(180,140,60,0.05)';
  const fg = danger ? '#EF4444' : primary ? '#2C1810' : colors.textSecondary;
  const hoverBg = danger ? 'rgba(239,68,68,0.2)' : primary ? '#E09020' : 'rgba(180,140,60,0.08)';
  return (
    <button
      className={`flex items-center justify-center gap-1.5 rounded-lg font-medium transition-fast ${small ? 'px-2.5 py-1.5 text-[11px]' : 'px-3 py-2 text-[12px]'}`}
      style={{ background: bg, color: fg, opacity: disabled ? 0.4 : 1, cursor: disabled ? 'default' : 'pointer' }}
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = hoverBg; }}
      onMouseLeave={e => { if (!disabled) e.currentTarget.style.background = bg; }}
    >
      {icon}{label}
    </button>
  );
}

// ─── Main Component ───

export default function GitPanel() {
  const gitPanelOpen = useGraphStore(s => s.gitPanelOpen);
  const gitStatus = useGraphStore(s => s.gitStatus);
  const branches = useGraphStore(s => s.branches);
  const currentBranch = useGraphStore(s => s.currentBranch);
  const commits = useGraphStore(s => s.commits);
  const fetchGitStatus = useGraphStore(s => s.fetchGitStatus);
  const gitAction = useGraphStore(s => s.gitAction);
  const toggleGitPanel = useGraphStore(s => s.toggleGitPanel);
  const setSelectedNode = useGraphStore(s => s.setSelectedNode);

  const [commitMsg, setCommitMsg] = useState('');
  const [newBranchName, setNewBranchName] = useState('');
  const [showBranches, setShowBranches] = useState(false);
  const [showNewBranch, setShowNewBranch] = useState(false);
  const [showMerge, setShowMerge] = useState(false);
  const [actionStatus, setActionStatus] = useState(null);
  const [expandStaged, setExpandStaged] = useState(true);
  const [expandChanged, setExpandChanged] = useState(true);
  const [expandHistory, setExpandHistory] = useState(false);
  const [confirm, setConfirm] = useState(null);

  useEffect(() => {
    if (gitPanelOpen) fetchGitStatus();
  }, [gitPanelOpen, fetchGitStatus]);

  const doAction = useCallback(async (action, body, successMsg) => {
    setActionStatus({ type: 'loading', message: 'Working...' });
    const result = await gitAction(action, body);
    if (result.ok || !result.error) {
      setActionStatus({ type: 'success', message: successMsg });
      setTimeout(() => setActionStatus(null), 2500);
    } else {
      setActionStatus({ type: 'error', message: result.error });
      setTimeout(() => setActionStatus(null), 5000);
    }
    return result;
  }, [gitAction]);

  const askConfirm = useCallback((title, message, confirmLabel, danger, action) => {
    setConfirm({ title, message, confirmLabel, danger, action });
  }, []);

  if (!gitPanelOpen) return null;

  const modified = gitStatus?.modified || [];
  const staged = gitStatus?.staged || [];
  const untracked = gitStatus?.not_added || [];
  const deleted = gitStatus?.deleted || [];
  const unstaged = [...new Set([...modified, ...untracked, ...deleted])].filter(f => !staged.includes(f));
  const ahead = gitStatus?.ahead || 0;
  const behind = gitStatus?.behind || 0;

  return (
    <div
      className="absolute top-0 left-0 h-full z-40 flex flex-col"
      style={{
        width: 320,
        background: colors.bgBase,
        borderRight: `1px solid ${colors.border}`,
        boxShadow: '8px 0 40px rgba(0,0,0,0.35)',
      }}
    >
      {/* ═══ Header ═══ */}
      <div className="flex items-center justify-between px-4 py-3 flex-shrink-0" style={{ borderBottom: `1px solid ${colors.border}` }}>
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 rounded-md" style={{ background: 'rgba(232,146,12,0.12)' }}>
            <GitBranch size={15} style={{ color: colors.accent }} />
          </div>
          <span className="text-[14px] font-semibold" style={{ color: colors.textPrimary }}>Source Control</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={fetchGitStatus} className="p-1.5 rounded-md transition-fast" style={{ color: colors.textTertiary }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(180,140,60,0.05)'; e.currentTarget.style.color = colors.textSecondary; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = colors.textTertiary; }}
            title="Refresh">
            <RefreshCw size={14} />
          </button>
          <button onClick={toggleGitPanel} className="p-1.5 rounded-md transition-fast" style={{ color: colors.textTertiary }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(180,140,60,0.05)'; e.currentTarget.style.color = colors.textSecondary; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = colors.textTertiary; }}
            title="Close">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* ═══ Branch ═══ */}
      <div className="px-4 py-3 flex-shrink-0" style={{ borderBottom: `1px solid ${colors.border}` }}>
        <button
          className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-[13px] font-medium transition-fast"
          style={{ background: 'rgba(232,146,12,0.08)', color: colors.accent, border: `1px solid rgba(232,146,12,0.15)` }}
          onClick={() => setShowBranches(!showBranches)}
          onMouseEnter={e => e.currentTarget.style.background = 'rgba(232,146,12,0.12)'}
          onMouseLeave={e => e.currentTarget.style.background = 'rgba(232,146,12,0.08)'}
        >
          <span className="flex items-center gap-2">
            <GitBranch size={14} />
            {currentBranch}
            {(ahead > 0 || behind > 0) && (
              <span className="flex items-center gap-1 text-[10px]" style={{ color: colors.textTertiary }}>
                {ahead > 0 && <span className="flex items-center gap-0.5"><ArrowUpCircle size={10} />{ahead}</span>}
                {behind > 0 && <span className="flex items-center gap-0.5"><ArrowDownCircle size={10} />{behind}</span>}
              </span>
            )}
          </span>
          <ChevronDown size={14} style={{ transform: showBranches ? 'rotate(180deg)' : 'none', transition: '150ms ease' }} />
        </button>

        {/* Branch list */}
        {showBranches && (
          <div className="mt-2 rounded-lg overflow-hidden" style={{ border: `1px solid ${colors.border}`, background: colors.bgSurface }}>
            {branches.map(b => (
              <button
                key={b.name}
                className="w-full text-left px-3 py-2.5 text-[13px] flex items-center justify-between transition-fast"
                style={{ background: b.current ? 'rgba(232,146,12,0.06)' : 'transparent', color: b.current ? colors.accent : colors.textSecondary }}
                onMouseEnter={e => { if (!b.current) e.currentTarget.style.background = 'rgba(180,140,60,0.04)'; }}
                onMouseLeave={e => { if (!b.current) e.currentTarget.style.background = b.current ? 'rgba(232,146,12,0.06)' : 'transparent'; }}
                onClick={() => {
                  if (!b.current) askConfirm('Switch Branch', `Switch from "${currentBranch}" to "${b.name}"? Uncommitted changes may be lost.`, 'Switch', false,
                    async () => { await doAction('checkout', { branch: b.name }, `Switched to ${b.name}`); setShowBranches(false); });
                }}
              >
                <span className="flex items-center gap-2">
                  {b.current ? <Circle size={8} fill={colors.accent} style={{ color: colors.accent }} /> : <Circle size={8} style={{ color: colors.textTertiary, opacity: 0.3 }} />}
                  {b.name}
                </span>
                {b.current && <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(232,146,12,0.15)', color: colors.accent }}>current</span>}
              </button>
            ))}
          </div>
        )}

        {/* Quick actions */}
        <div className="flex gap-2 mt-2.5">
          <ActionButton icon={<Plus size={12} />} label="New Branch" small onClick={() => setShowNewBranch(!showNewBranch)} />
          <ActionButton icon={<GitMerge size={12} />} label="Merge" small onClick={() => setShowMerge(!showMerge)} />
        </div>

        {/* New branch input */}
        {showNewBranch && (
          <div className="mt-2.5 flex gap-2">
            <input
              type="text" value={newBranchName} onChange={e => setNewBranchName(e.target.value)}
              placeholder="feature/my-branch"
              autoFocus
              className="flex-1 px-3 py-2 rounded-lg text-[13px] bg-transparent outline-none"
              style={{ border: `1px solid ${colors.border}`, color: colors.textPrimary, caretColor: colors.accent }}
              onKeyDown={async e => {
                if (e.key === 'Enter' && newBranchName.trim()) {
                  await doAction('branch', { name: newBranchName.trim() }, `Created & switched to ${newBranchName}`);
                  setNewBranchName(''); setShowNewBranch(false);
                }
                if (e.key === 'Escape') setShowNewBranch(false);
              }}
            />
            <ActionButton icon={<Check size={12} />} label="Create" primary small onClick={async () => {
              if (newBranchName.trim()) { await doAction('branch', { name: newBranchName.trim() }, `Created ${newBranchName}`); setNewBranchName(''); setShowNewBranch(false); }
            }} />
          </div>
        )}

        {/* Merge picker */}
        {showMerge && (
          <div className="mt-2.5 rounded-lg overflow-hidden" style={{ border: `1px solid ${colors.border}`, background: colors.bgSurface }}>
            <div className="px-3 py-2 text-[11px] font-medium" style={{ color: colors.textTertiary, borderBottom: `1px solid ${colors.border}` }}>
              Merge into <span style={{ color: colors.accent }}>{currentBranch}</span>
            </div>
            {branches.filter(b => !b.current).length === 0 ? (
              <div className="px-3 py-3 text-[12px]" style={{ color: colors.textTertiary }}>No other branches</div>
            ) : branches.filter(b => !b.current).map(b => (
              <button
                key={b.name}
                className="w-full text-left px-3 py-2.5 text-[13px] flex items-center gap-2 transition-fast"
                style={{ color: colors.textSecondary }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(180,140,60,0.04)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                onClick={() => askConfirm('Merge Branch', `Merge "${b.name}" into "${currentBranch}"? This cannot be easily undone.`, 'Merge', true,
                  async () => { await doAction('merge', { branch: b.name }, `Merged ${b.name}`); setShowMerge(false); })}
              >
                <GitMerge size={13} style={{ color: colors.textTertiary }} />
                {b.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ═══ Scrollable content ═══ */}
      <div className="flex-1 overflow-y-auto">

        {/* ── Staged files ── */}
        {staged.length > 0 && (
          <>
            <SectionHeader
              icon={<Check size={11} style={{ color: '#22C55E' }} />}
              label="Staged"
              count={staged.length}
              expanded={expandStaged}
              onToggle={() => setExpandStaged(!expandStaged)}
              action={
                <button
                  className="text-[10px] px-2 py-0.5 rounded transition-fast"
                  style={{ color: '#F0A030', background: 'rgba(232,146,12,0.08)' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(232,146,12,0.15)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'rgba(232,146,12,0.08)'}
                  onClick={() => doAction('reset', { files: staged }, 'All unstaged')}
                >
                  Unstage All
                </button>
              }
            />
            {expandStaged && (
              <div className="px-2 pb-2">
                {staged.map(file => (
                  <FileRow key={file} file={file} status="staged" onView={setSelectedNode}
                    actionIcon={<Minus size={13} />} actionColor="#F0A030" actionTitle="Unstage"
                    onAction={() => doAction('reset', { files: [file] }, `Unstaged ${file.split('/').pop()}`)} />
                ))}
              </div>
            )}
          </>
        )}

        {/* ── Unstaged changes ── */}
        <SectionHeader
          icon={<Circle size={11} style={{ color: '#F0A030' }} />}
          label="Changes"
          count={unstaged.length}
          expanded={expandChanged}
          onToggle={() => setExpandChanged(!expandChanged)}
          action={unstaged.length > 0 && (
            <button
              className="text-[10px] px-2 py-0.5 rounded transition-fast"
              style={{ color: colors.accent, background: 'rgba(232,146,12,0.08)' }}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(232,146,12,0.15)'}
              onMouseLeave={e => e.currentTarget.style.background = 'rgba(232,146,12,0.08)'}
              onClick={() => doAction('add', { files: unstaged }, 'All staged')}
            >
              Stage All
            </button>
          )}
        />
        {expandChanged && (
          <div className="px-2 pb-2">
            {unstaged.length === 0 ? (
              <div className="px-3 py-5 text-center text-[12px]" style={{ color: colors.textTertiary }}>
                Working tree clean
              </div>
            ) : unstaged.map(file => {
              const status = deleted.includes(file) ? 'deleted' : untracked.includes(file) ? 'untracked' : 'modified';
              return (
                <FileRow key={file} file={file} status={status} onView={setSelectedNode}
                  actionIcon={<Plus size={13} />} actionColor="#22C55E" actionTitle="Stage"
                  onAction={() => doAction('add', { files: [file] }, `Staged ${file.split('/').pop()}`)} />
              );
            })}
          </div>
        )}

        {/* ── Commit ── */}
        <div className="px-4 py-3" style={{ borderTop: `1px solid ${colors.border}` }}>
          <textarea
            value={commitMsg}
            onChange={e => setCommitMsg(e.target.value)}
            placeholder="Commit message..."
            rows={2}
            className="w-full px-3 py-2.5 rounded-lg text-[13px] bg-transparent outline-none resize-none leading-relaxed"
            style={{ border: `1px solid ${commitMsg ? 'rgba(232,146,12,0.3)' : colors.border}`, color: colors.textPrimary, caretColor: colors.accent }}
          />
          <div className="flex gap-2 mt-2.5">
            <ActionButton
              icon={<GitCommit size={13} />}
              label={`Commit${staged.length > 0 ? ` (${staged.length})` : ''}`}
              primary
              disabled={!commitMsg.trim() || staged.length === 0}
              onClick={() => askConfirm('Commit Changes', `Commit ${staged.length} staged file(s)?\n\n"${commitMsg.trim()}"`, 'Commit', false,
                async () => { await doAction('commit', { message: commitMsg.trim() }, 'Committed!'); setCommitMsg(''); })}
            />
            <ActionButton
              icon={<GitCommit size={13} />}
              label="All"
              disabled={!commitMsg.trim() || (unstaged.length === 0 && staged.length === 0)}
              onClick={() => askConfirm('Commit All', `Stage ALL files and commit?\n\n"${commitMsg.trim()}"`, 'Commit All', false,
                async () => { await doAction('add', { files: ['.'] }, ''); await doAction('commit', { message: commitMsg.trim() }, 'All committed!'); setCommitMsg(''); })}
            />
          </div>
        </div>

        {/* ── Sync ── */}
        <div className="px-4 py-3 flex gap-2" style={{ borderTop: `1px solid ${colors.border}` }}>
          <ActionButton
            icon={<Upload size={13} />}
            label={`Push${ahead > 0 ? ` (${ahead})` : ''}`}
            onClick={() => askConfirm('Push to Remote', `Push "${currentBranch}" to origin?${ahead > 0 ? ` ${ahead} commit(s) ahead.` : ''}`, 'Push', false,
              async () => { await doAction('push', {}, 'Pushed!'); })}
          />
          <ActionButton
            icon={<Download size={13} />}
            label={`Pull${behind > 0 ? ` (${behind})` : ''}`}
            onClick={() => askConfirm('Pull from Remote', `Pull latest from origin into "${currentBranch}"?${behind > 0 ? ` ${behind} commit(s) behind.` : ''}`, 'Pull', false,
              async () => { await doAction('pull', {}, 'Pulled!'); })}
          />
        </div>

        {/* ── History ── */}
        <SectionHeader
          icon={<GitCommit size={11} />}
          label="History"
          count={commits.length}
          expanded={expandHistory}
          onToggle={() => setExpandHistory(!expandHistory)}
        />
        {expandHistory && (
          <div className="px-2 pb-3">
            {commits.slice(0, 25).map((c, i) => (
              <div key={i} className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg transition-fast"
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(180,140,60,0.03)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                <div className="mt-1 flex-shrink-0">
                  <div className="w-2 h-2 rounded-full" style={{ background: i === 0 ? colors.accent : colors.textTertiary, opacity: i === 0 ? 1 : 0.4 }} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] leading-snug" style={{ color: i === 0 ? colors.textPrimary : colors.textSecondary }}>{c.message}</div>
                  <div className="text-[11px] mt-1 flex items-center gap-2" style={{ color: colors.textTertiary }}>
                    <span className="font-mono">{c.shortHash}</span>
                    <span>{c.author}</span>
                    <span>{new Date(c.date).toLocaleDateString()}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ═══ Status toast ═══ */}
      {actionStatus && (
        <div
          className="flex-shrink-0 px-4 py-2.5 text-[12px] font-medium flex items-center gap-2"
          style={{
            borderTop: `1px solid ${colors.border}`,
            color: actionStatus.type === 'success' ? '#22C55E' : actionStatus.type === 'error' ? '#EF4444' : colors.accent,
            background: actionStatus.type === 'error' ? 'rgba(239,68,68,0.04)' : actionStatus.type === 'success' ? 'rgba(34,197,94,0.04)' : 'transparent',
          }}
        >
          {actionStatus.type === 'success' && <Check size={13} />}
          {actionStatus.type === 'loading' && <RefreshCw size={13} className="animate-spin" />}
          {actionStatus.message}
        </div>
      )}

      {/* ═══ Confirm modal ═══ */}
      {confirm && (
        <ConfirmModal
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          danger={confirm.danger}
          onConfirm={async () => { setConfirm(null); await confirm.action(); }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

// ─── File Row Component ───

function FileRow({ file, status, onView, actionIcon, actionColor, actionTitle, onAction }) {
  const fileName = file.split('/').pop();
  const dirPath = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';

  return (
    <div
      className="flex items-center gap-2 px-3 py-2 rounded-lg transition-fast group"
      style={{ color: colors.textSecondary }}
      onMouseEnter={e => e.currentTarget.style.background = 'rgba(180,140,60,0.03)'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
    >
      <FileStatusBadge status={status} />
      <button className="flex-1 min-w-0 text-left" onClick={() => onView(file)}>
        <div className="text-[13px] truncate" style={{ color: colors.textSecondary }}>{fileName}</div>
        {dirPath && <div className="text-[10px] truncate" style={{ color: colors.textTertiary }}>{dirPath}</div>}
      </button>
      <button
        className="opacity-0 group-hover:opacity-100 p-1 rounded-md transition-fast flex-shrink-0"
        style={{ color: actionColor, background: `${actionColor}10` }}
        title={actionTitle}
        onClick={onAction}
        onMouseEnter={e => e.currentTarget.style.background = `${actionColor}20`}
        onMouseLeave={e => e.currentTarget.style.background = `${actionColor}10`}
      >
        {actionIcon}
      </button>
    </div>
  );
}
