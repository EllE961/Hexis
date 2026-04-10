import { useGraphStore } from '../../hooks/useGraph.js';
import { W } from '../../theme/window-tokens.js';
import { GitBranch, Eye, EyeOff, ListTodo } from 'lucide-react';
import { useTaskStore } from '../../stores/taskStore.js';
import { usePanelStore } from '../../stores/panelStore.js';

export default function StatusBar() {
  const nodeCount = useGraphStore(s => s.nodes.length);
  const currentBranch = useGraphStore(s => s.currentBranch);
  const connected = useGraphStore(s => s.connected);
  const loading = useGraphStore(s => s.loading);
  const gitStatus = useGraphStore(s => s.gitStatus);
  const gitPanelOpen = useGraphStore(s => s.gitPanelOpen);
  const showChanges = useGraphStore(s => s.showChanges);
  const toggleGitPanel = useGraphStore(s => s.toggleGitPanel);
  const toggleShowChanges = useGraphStore(s => s.toggleShowChanges);

  const healthyCount = useGraphStore(s => s.nodes.filter(n => n.hasValidFrontmatter).length);
  const warningCount = nodeCount - healthyCount;
  const changedCount = gitStatus ? (gitStatus.modified?.length || 0) + (gitStatus.not_added?.length || 0) + (gitStatus.staged?.length || 0) : 0;

  const taskTotal = useTaskStore(s => s.tasks.length);
  const tasksInProgress = useTaskStore(s =>
    s.tasks.filter(t => t.status === 'in_progress' || t.status === 'agent_working').length
  );
  const tasksNeedsReview = useTaskStore(s =>
    s.tasks.filter(t => t.status === 'needs_review').length
  );
  const showPanel = usePanelStore(s => s.showPanel);
  const focusPanel = usePanelStore(s => s.focusPanel);

  return (
    <div
      className="absolute bottom-0 left-0 right-0 h-8 z-50 flex items-center px-4 gap-4 text-[13px]"
      style={{ background: W.bg1, borderTop: `1px solid ${W.border}`, color: W.textMuted }}
    >
      {/* Connection */}
      <div className="flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: connected ? W.green : W.red }} />
        <span>{connected ? 'Connected' : loading ? 'Loading...' : 'Disconnected'}</span>
      </div>

      {/* Git panel toggle + branch */}
      <button
        className="flex items-center gap-1.5 px-2 py-0.5 rounded transition-fast"
        style={{
          color: gitPanelOpen ? W.accent : W.textDim,
          background: gitPanelOpen ? W.accentSoft : 'transparent',
        }}
        onClick={toggleGitPanel}
        onMouseEnter={e => { if (!gitPanelOpen) e.currentTarget.style.background = W.accentBg; }}
        onMouseLeave={e => { if (!gitPanelOpen) e.currentTarget.style.background = 'transparent'; }}
      >
        <GitBranch size={13} />
        <span style={{ fontWeight: 500 }}>{currentBranch}</span>
        {changedCount > 0 && (
          <span className="px-1.5 py-0 rounded-full text-[10px] font-medium" style={{ background: W.accentHover, color: W.accent }}>
            {changedCount}
          </span>
        )}
      </button>

      {/* Show changes toggle */}
      <button
        className="flex items-center gap-1 px-1.5 py-0.5 rounded transition-fast"
        style={{ color: showChanges ? W.accent : W.textMuted }}
        onClick={toggleShowChanges}
        title={showChanges ? 'Hide change indicators' : 'Show change indicators'}
      >
        {showChanges ? <Eye size={13} /> : <EyeOff size={13} />}
      </button>

      {/* File count */}
      <div>{nodeCount} files</div>

      {/* Task counter */}
      {taskTotal > 0 && (
        <button
          className="flex items-center gap-1.5 px-2 py-0.5 rounded transition-fast"
          style={{ color: W.textMuted, background: 'transparent' }}
          onClick={() => { showPanel('taskboard'); focusPanel('taskboard'); }}
          onMouseEnter={e => { e.currentTarget.style.background = W.accentBg; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
          title="Open Task Board"
        >
          <ListTodo size={13} />
          {tasksInProgress > 0 && (
            <span className="flex items-center gap-1">
              <span
                className="w-1.5 h-1.5 rounded-full animate-pulse"
                style={{ background: W.accent }}
              />
              <span style={{ fontWeight: 500 }}>{tasksInProgress}</span>
            </span>
          )}
          {tasksNeedsReview > 0 && (
            <span
              className="px-1.5 py-0 rounded-full text-[10px] font-medium"
              style={{ background: W.accentHover, color: W.accent }}
            >
              {tasksNeedsReview}
            </span>
          )}
        </button>
      )}

      {/* Health */}
      <div className="flex items-center gap-1.5 ml-auto">
        {healthyCount > 0 && (
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: W.green }} /> {healthyCount}
          </span>
        )}
        {warningCount > 0 && (
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: W.yellow }} /> {warningCount}
          </span>
        )}
      </div>

      <div style={{ color: W.textMuted, opacity: 0.5 }}>⬡ Hexis v0.1</div>
    </div>
  );
}
