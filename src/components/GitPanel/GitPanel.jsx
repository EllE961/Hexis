/**
 * GitPanel — full git interface.
 * Branch, staging, commit, push/pull, stash, merge, Ship It.
 * Now a simple content component that fills its DockPanel parent.
 */

import { useState, useEffect } from 'react';
import { useGitStore } from '../../stores/gitStore.js';
import { Icon } from '../common/Icon.jsx';
import { W } from '../../theme/window-tokens.js';

export default function GitPanel() {
  const {
    currentBranch, branches, modified, staged, untracked, deleted, conflicted,
    ahead, behind, fetchStatus, fetchBranches,
    stageFiles, unstageFiles, commit, push, pull, shipIt, createBranch, checkoutBranch,
  } = useGitStore();

  // Use optional methods — they may not exist yet until the git agent adds them
  const stashList = useGitStore(s => s.stashList);
  const stashPush = useGitStore(s => s.stashPush);
  const stashPop = useGitStore(s => s.stashPop);
  const fetchRemote = useGitStore(s => s.fetchRemote);
  const mergeBranch = useGitStore(s => s.mergeBranch);
  const deleteBranch = useGitStore(s => s.deleteBranch);
  const amendCommit = useGitStore(s => s.amendCommit);
  const stashes = useGitStore(s => s.stashes) || [];

  const [commitMsg, setCommitMsg] = useState('');
  const [showBranches, setShowBranches] = useState(false);
  const [newBranch, setNewBranch] = useState('');
  const [showNewBranch, setShowNewBranch] = useState(false);
  const [activeSection, setActiveSection] = useState('changes'); // changes | stash | actions
  const [status, setStatus] = useState(null);
  const [mergeBranchName, setMergeBranchName] = useState('');
  const [isAmend, setIsAmend] = useState(false);

  useEffect(() => {
    fetchStatus();
    fetchBranches();
    stashList?.();
  }, []);

  const unstaged = [...new Set([...modified, ...untracked, ...deleted])].filter(f => !staged.includes(f));
  const hasChanges = unstaged.length > 0 || staged.length > 0;

  const doAction = async (action, msg) => {
    setStatus({ type: 'loading', msg: 'Working...' });
    try {
      const result = await action();
      if (result?.error) {
        setStatus({ type: 'error', msg: result.error });
      } else {
        setStatus({ type: 'success', msg });
        fetchStatus();
        fetchBranches();
      }
    } catch (err) {
      setStatus({ type: 'error', msg: err.message });
    }
    setTimeout(() => setStatus(null), 3000);
  };

  return (
    <div
      className="flex-1 flex flex-col min-w-0 min-h-0"
      style={{
        background: W.bg1,
      }}
    >
      {/* Branch */}
      <div className="px-4 py-3" style={{ borderBottom: '1px solid rgba(139, 148, 158, 0.08)' }}>
        <button
          className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-[13px] font-medium"
          style={{ background: W.accentBg, color: W.accent, border: `1px solid ${W.accentSoft}` }}
          onClick={() => setShowBranches(!showBranches)}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Icon name="git-branch" size={W.icon} color="inherit" />
            {currentBranch}
          </span>
          <div className="flex items-center gap-2 text-[10px]">
            {ahead > 0 && (
              <span style={{ color: W.green, display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                <Icon name="arrow-up" size={W.iconSm} color="inherit" />{ahead}
              </span>
            )}
            {behind > 0 && (
              <span style={{ color: W.blue, display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                <Icon name="arrow-down" size={W.iconSm} color="inherit" />{behind}
              </span>
            )}
            <Icon name={showBranches ? 'chevron-up' : 'chevron-down'} size={W.iconSm} color="inherit" />
          </div>
        </button>

        {showBranches && (
          <div className="mt-2 rounded-lg overflow-hidden max-h-48 overflow-y-auto" style={{ border: `1px solid ${W.border}` }}>
            {branches.map(b => (
              <div key={b.name} className="flex items-center justify-between px-3 py-1.5 text-[12px] group"
                style={{ color: b.current ? W.accent : W.textDim, background: b.current ? W.accentBg : 'transparent' }}>
                <button className="flex-1 text-left truncate" onClick={() => { checkoutBranch(b.name); setShowBranches(false); }}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {b.current && <Icon name="circle-filled" size={8} color={W.accent} />}
                  {b.name}
                </button>
                {!b.current && deleteBranch && (
                  <button
                    className="opacity-0 group-hover:opacity-100 px-1 rounded"
                    style={{ color: W.red, display: 'inline-flex', alignItems: 'center' }}
                    onClick={(e) => { e.stopPropagation(); doAction(() => deleteBranch(b.name), `Deleted ${b.name}`); }}
                  ><Icon name="trash" size={W.iconSm} color="inherit" /></button>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2 mt-2">
          <button className="flex-1 text-[11px] py-1.5 rounded-md font-medium"
            style={{ background: W.bg3, color: W.textDim }}
            onClick={() => setShowNewBranch(!showNewBranch)}>
            + Branch
          </button>
          {fetchRemote && (
            <button className="text-[11px] py-1.5 px-3 rounded-md font-medium"
              style={{ background: W.bg3, color: W.textDim }}
              onClick={() => doAction(fetchRemote, 'Fetched!')}>
              Fetch
            </button>
          )}
        </div>

        {showNewBranch && (
          <input
            type="text" value={newBranch} onChange={e => setNewBranch(e.target.value)}
            placeholder="new-branch-name" autoFocus
            className="w-full mt-2 px-3 py-1.5 rounded-md text-[12px] bg-transparent outline-none"
            style={{ border: `1px solid ${W.border}`, color: W.text, caretColor: W.accent }}
            onKeyDown={e => {
              if (e.key === 'Enter' && newBranch.trim()) {
                doAction(() => createBranch(newBranch.trim()), `Created ${newBranch.trim()}`);
                setNewBranch(''); setShowNewBranch(false);
              }
              if (e.key === 'Escape') setShowNewBranch(false);
            }}
          />
        )}
      </div>

      {/* Section tabs */}
      <div className="flex px-2 py-1.5" style={{ borderBottom: '1px solid rgba(139, 148, 158, 0.08)' }}>
        {[
          { id: 'changes', label: 'Changes', count: unstaged.length + staged.length },
          { id: 'stash', label: 'Stash', count: stashes.length },
          { id: 'actions', label: 'Actions' },
        ].map(tab => (
          <button
            key={tab.id}
            className="flex-1 py-1.5 text-[11px] font-medium rounded"
            style={{
              color: activeSection === tab.id ? W.accent : W.textMuted,
              background: activeSection === tab.id ? W.accentBg : 'transparent',
            }}
            onClick={() => setActiveSection(tab.id)}
          >
            {tab.label}{tab.count > 0 ? ` (${tab.count})` : ''}
          </button>
        ))}
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto">

        {/* --- Changes tab --- */}
        {activeSection === 'changes' && (
          <>
            {/* Conflicts */}
            {conflicted?.length > 0 && (
              <div>
                <div className="flex items-center justify-between px-4 py-2">
                  <span className="text-[11px] font-semibold uppercase" style={{ color: W.red }}>
                    Conflicts ({conflicted.length})
                  </span>
                </div>
                {conflicted.map(f => (
                  <FileRow key={f} path={f} status="!" color={W.red} />
                ))}
              </div>
            )}

            {/* Staged */}
            {staged.length > 0 && (
              <div>
                <div className="flex items-center justify-between px-4 py-2">
                  <span className="text-[11px] font-semibold uppercase" style={{ color: W.textGhost }}>Staged ({staged.length})</span>
                  <button className="text-[10px] px-2 py-0.5 rounded" style={{ color: W.accent }}
                    onClick={() => unstageFiles(staged)}>Unstage All</button>
                </div>
                {staged.map(f => (
                  <FileRow key={f} path={f} status="S" color={W.green} onAction={() => unstageFiles([f])} actionLabel="−" />
                ))}
              </div>
            )}

            {/* Unstaged */}
            <div>
              <div className="flex items-center justify-between px-4 py-2">
                <span className="text-[11px] font-semibold uppercase" style={{ color: W.textGhost }}>Changes ({unstaged.length})</span>
                {unstaged.length > 0 && (
                  <button className="text-[10px] px-2 py-0.5 rounded" style={{ color: W.accent }}
                    onClick={() => stageFiles(unstaged)}>Stage All</button>
                )}
              </div>
              {unstaged.length === 0 && staged.length === 0 ? (
                <div className="px-4 py-6 text-center text-[12px]" style={{ color: W.textGhost }}>Working tree clean</div>
              ) : (
                unstaged.map(f => {
                  const st = deleted.includes(f) ? 'D' : untracked.includes(f) ? 'U' : 'M';
                  const cl = deleted.includes(f) ? W.red : untracked.includes(f) ? W.blue : W.yellow;
                  return <FileRow key={f} path={f} status={st} color={cl} onAction={() => stageFiles([f])} actionLabel="+" />;
                })
              )}
            </div>

            {/* Commit */}
            {hasChanges && (
              <div className="px-4 py-3" style={{ borderTop: '1px solid rgba(139, 148, 158, 0.08)' }}>
                <textarea
                  value={commitMsg} onChange={e => setCommitMsg(e.target.value)}
                  placeholder="Commit message..."
                  rows={2}
                  className="w-full px-3 py-2 rounded-lg text-[13px] bg-transparent outline-none resize-none"
                  style={{ border: `1px solid rgba(139, 148, 158, ${commitMsg ? '0.3' : '0.1'})`, color: W.text, caretColor: W.accent }}
                />
                <div className="flex items-center gap-2 mt-2">
                  {amendCommit && (
                    <label className="flex items-center gap-1.5 text-[11px] cursor-pointer" style={{ color: W.textMuted }}>
                      <input type="checkbox" checked={isAmend} onChange={e => setIsAmend(e.target.checked)}
                        className="accent-amber-600" style={{ width: 12, height: 12 }} />
                      Amend
                    </label>
                  )}
                  <button
                    className="flex-1 py-2 rounded-lg text-[13px] font-semibold"
                    style={{
                      background: staged.length > 0 && commitMsg.trim() ? W.accent : W.accentHover,
                      color: staged.length > 0 && commitMsg.trim() ? W.bg0 : W.textMuted,
                    }}
                    disabled={!commitMsg.trim() || staged.length === 0}
                    onClick={() => {
                      const action = isAmend && amendCommit
                        ? () => amendCommit(commitMsg.trim())
                        : () => commit(commitMsg.trim());
                      doAction(action, isAmend ? 'Amended!' : 'Committed!');
                      setCommitMsg('');
                    }}
                  >
                    {isAmend ? 'Amend' : 'Commit'} ({staged.length})
                  </button>
                </div>
              </div>
            )}

            {/* Push / Pull */}
            <div className="px-4 py-3 flex gap-2" style={{ borderTop: '1px solid rgba(139, 148, 158, 0.08)' }}>
              <button className="flex-1 py-2 rounded-lg text-[12px] font-medium flex items-center justify-center gap-1"
                style={{ background: W.bg3, color: W.textDim }}
                onClick={() => doAction(push, 'Pushed!')}>
                <Icon name="arrow-up" size={W.iconSm} color="inherit" /> Push {ahead > 0 && `(${ahead})`}
              </button>
              <button className="flex-1 py-2 rounded-lg text-[12px] font-medium flex items-center justify-center gap-1"
                style={{ background: W.bg3, color: W.textDim }}
                onClick={() => doAction(pull, 'Pulled!')}>
                <Icon name="arrow-down" size={W.iconSm} color="inherit" /> Pull {behind > 0 && `(${behind})`}
              </button>
            </div>

            {/* Ship It */}
            <div className="px-4 py-3" style={{ borderTop: '1px solid rgba(139, 148, 158, 0.08)' }}>
              <button
                className="w-full py-3 rounded-lg text-[14px] font-bold"
                style={{
                  background: hasChanges ? `linear-gradient(135deg, ${W.accent}, ${W.accent})` : W.bg3,
                  color: hasChanges ? W.bg0 : W.textGhost,
                  boxShadow: hasChanges ? '0 2px 12px rgba(240, 160, 48, 0.3)' : 'none',
                }}
                disabled={!hasChanges}
                onClick={() => doAction(() => shipIt(commitMsg.trim() || undefined), 'Shipped!')}
              >
                ⬡ Ship It
              </button>
              <div className="text-[10px] text-center mt-1" style={{ color: W.textGhost }}>
                Stage all → commit → push
              </div>
            </div>
          </>
        )}

        {/* --- Stash tab --- */}
        {activeSection === 'stash' && (
          <div className="px-4 py-3">
            {/* Stash push */}
            <div className="flex gap-2 mb-3">
              <button
                className="flex-1 py-2 rounded-lg text-[12px] font-medium"
                style={{ background: W.borderSubtle, color: W.textDim }}
                disabled={!hasChanges}
                onClick={() => {
                  if (stashPush) doAction(() => stashPush(commitMsg || 'WIP'), 'Stashed!');
                }}
              >
                Stash Changes
              </button>
            </div>

            {/* Stash list */}
            {stashes.length === 0 ? (
              <div className="py-6 text-center text-[12px]" style={{ color: W.textGhost }}>No stashes</div>
            ) : (
              stashes.map((stash, i) => (
                <div key={i} className="flex items-center gap-2 py-2 text-[12px] group"
                  style={{ borderBottom: '1px solid rgba(139, 148, 158, 0.05)' }}>
                  <span className="w-5 text-center text-[10px] font-bold" style={{ color: W.purple }}>#{i}</span>
                  <span className="flex-1 truncate" style={{ color: W.textDim }}>
                    {stash.message || `stash@{${i}}`}
                  </span>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100">
                    <button className="px-1.5 py-0.5 rounded text-[10px] font-medium"
                      style={{ background: W.purpleBg, color: W.purple }}
                      onClick={() => { if (stashPop) doAction(() => stashPop(i), 'Popped!'); }}>
                      Pop
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* --- Actions tab --- */}
        {activeSection === 'actions' && (
          <div className="px-4 py-3 space-y-3">
            {/* Merge */}
            <div>
              <div className="text-[11px] font-semibold mb-1.5" style={{ color: W.textDim }}>Merge Branch</div>
              <div className="flex gap-2">
                <select
                  value={mergeBranchName}
                  onChange={e => setMergeBranchName(e.target.value)}
                  className="flex-1 px-2 py-1.5 rounded-md text-[12px] bg-transparent outline-none"
                  style={{ border: `1px solid ${W.border}`, color: W.text }}
                >
                  <option value="" style={{ background: W.bg1 }}>Select branch...</option>
                  {branches.filter(b => !b.current).map(b => (
                    <option key={b.name} value={b.name} style={{ background: W.bg1 }}>{b.name}</option>
                  ))}
                </select>
                <button
                  className="px-3 py-1.5 rounded-md text-[12px] font-medium"
                  style={{
                    background: mergeBranchName ? W.accent : W.accentHover,
                    color: mergeBranchName ? W.bg0 : W.textMuted,
                  }}
                  disabled={!mergeBranchName}
                  onClick={() => {
                    if (mergeBranch) doAction(() => mergeBranch(mergeBranchName), `Merged ${mergeBranchName}!`);
                    setMergeBranchName('');
                  }}
                >
                  Merge
                </button>
              </div>
            </div>

            {/* Quick actions */}
            <div>
              <div className="text-[11px] font-semibold mb-1.5" style={{ color: W.textDim }}>Quick Actions</div>
              <div className="space-y-1.5">
                <ActionButton
                  label="Fetch Remote"
                  description="Download latest without merging"
                  onClick={() => { if (fetchRemote) doAction(fetchRemote, 'Fetched!'); }}
                />
                <ActionButton
                  label="Pull & Rebase"
                  description="Pull with rebase instead of merge"
                  onClick={() => doAction(pull, 'Pulled!')}
                />
              </div>
            </div>

            {/* Danger zone */}
            <div>
              <div className="text-[11px] font-semibold mb-1.5" style={{ color: W.red }}>Danger Zone</div>
              <div className="space-y-1.5">
                <ActionButton
                  label="Discard All Changes"
                  description="Revert all uncommitted modifications"
                  danger
                  onClick={() => {
                    if (confirm('Discard ALL uncommitted changes? This cannot be undone.')) {
                      doAction(async () => {
                        const res = await fetch('/api/git/reset', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ files: [...modified, ...untracked] }),
                        });
                        return res.json();
                      }, 'Changes discarded');
                    }
                  }}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Status toast */}
      {status && (
        <div className="px-4 py-2 text-[12px] font-medium" style={{
          borderTop: '1px solid rgba(139, 148, 158, 0.08)',
          color: status.type === 'success' ? W.green : status.type === 'error' ? W.red : W.accent,
          background: status.type === 'error' ? 'rgba(178, 34, 34, 0.08)' : 'transparent',
        }}>
          {status.type === 'loading' && '◌ '}{status.msg}
        </div>
      )}
    </div>
  );
}

function FileRow({ path, status, color, onAction, actionLabel }) {
  const name = path.split('/').pop();
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

  return (
    <div className="flex items-center gap-2 px-4 py-1.5 text-[12px] group" style={{ color: W.textDim }}>
      <span className="w-4 text-center font-bold" style={{ color, fontSize: 10 }}>{status}</span>
      <div className="flex-1 min-w-0">
        <div className="truncate">{name}</div>
        {dir && <div className="truncate text-[10px]" style={{ color: W.textGhost }}>{dir}</div>}
      </div>
      {onAction && (
        <button
          className="opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded text-[13px] font-bold"
          style={{ color, background: `${color}15` }}
          onClick={onAction}
        >{actionLabel}</button>
      )}
    </div>
  );
}

function ActionButton({ label, description, danger, onClick }) {
  return (
    <button
      className="w-full text-left px-3 py-2 rounded-lg"
      style={{
        background: danger ? W.redBg : 'rgba(139, 148, 158, 0.04)',
        border: `1px solid ${danger ? W.redBg : W.borderSubtle}`,
      }}
      onClick={onClick}
    >
      <div className="text-[12px] font-medium" style={{ color: danger ? W.red : W.textDim }}>{label}</div>
      {description && <div className="text-[10px] mt-0.5" style={{ color: W.textGhost }}>{description}</div>}
    </button>
  );
}
