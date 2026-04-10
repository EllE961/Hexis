/**
 * TaskBoard — premium kanban with drag-drop, inline edit, and live agent progress.
 *
 * Four columns: To Do, In Progress, Needs Review, Done.
 * Tasks can be:
 *   - Drag-dropped within a column (reorder)
 *   - Drag-dropped between columns (status change)
 *   - Edited inline (title, description, priority)
 *   - Sent to AI agents with one click
 *   - Show live progress (current bee + file being worked on)
 */

import { useState, useMemo, useCallback, useRef } from 'react';
import { useTaskStore } from '../../stores/taskStore.js';
import { useAgentStore, AGENT_ROLES } from '../../stores/agentStore.js';
import { useEditorStore } from '../../stores/editorStore.js';
import { usePanelStore } from '../../stores/panelStore.js';
import { Modal } from '../window/Window.jsx';
import { W } from '../../theme/window-tokens.js';

/* ─── Design Tokens — proxy onto the active W theme ─── */

const T = new Proxy({}, {
  get(_, key) {
    switch (key) {
      case 'bg':        return W.bg0;
      case 'card':      return W.bg1;
      case 'cardHover': return W.bg2;
      case 'border':    return W.border;
      case 'borderLt':  return W.borderSubtle;
      case 'borderHi':  return W.borderHi;
      case 'accent':    return W.accent;
      case 'accentDim': return W.accentSoft;
      case 'text':      return W.text;
      case 'dim':       return W.textDim;
      case 'muted':     return W.textGhost;
      case 'green':     return W.green;
      case 'red':       return W.red;
      case 'blue':      return W.blue;
      case 'purple':    return W.purple;
      default:          return W[key];
    }
  },
});

const PRIORITY = new Proxy({}, {
  get(_, key) {
    switch (key) {
      case 'critical': return { color: W.red,       label: 'Critical' };
      case 'high':     return { color: W.yellow,    label: 'High' };
      case 'medium':   return { color: W.accent,    label: 'Medium' };
      case 'low':      return { color: W.textGhost, label: 'Low' };
      default:         return { color: W.textGhost, label: 'Unknown' };
    }
  },
});

const COLUMNS = [
  { key: 'todo',         label: 'To Do',          statuses: ['todo', 'blocked', 'paused'],     accent: T.dim,    targetStatus: 'todo',         emptyMsg: 'No tasks queued — add one above' },
  { key: 'in_progress',  label: 'In Progress',    statuses: ['in_progress', 'agent_working'],  accent: T.accent, targetStatus: 'in_progress',  emptyMsg: 'Nothing in flight right now' },
  { key: 'needs_review', label: 'Needs Review',   statuses: ['needs_review'],                  accent: T.blue,   targetStatus: 'needs_review', emptyMsg: 'All clear — nothing to review' },
  { key: 'done',         label: 'Done',           statuses: ['done'],                          accent: T.green,  targetStatus: 'done',         emptyMsg: 'Completed tasks will appear here' },
];

/* ─── Main Component ─── */

export default function TaskBoard() {
  const tasks                = useTaskStore(s => s.tasks);
  const addTask              = useTaskStore(s => s.addTask);
  const deleteTask           = useTaskStore(s => s.deleteTask);
  const completeTask         = useTaskStore(s => s.completeTask);
  const moveToInProgress     = useTaskStore(s => s.moveToInProgress);
  const changeStatus         = useTaskStore(s => s.changeStatus);
  const reorderTask          = useTaskStore(s => s.reorderTask);
  const editTask             = useTaskStore(s => s.editTask);
  const setDependencies      = useTaskStore(s => s.setDependencies);
  const getSubtasks          = useTaskStore(s => s.getSubtasks);
  const submitTaskFromBoard  = useAgentStore(s => s.submitTaskFromBoard);
  const cancelAgentTask      = useAgentStore(s => s.cancelTask);
  const pauseAgentTask       = useAgentStore(s => s.pauseTask);
  const resumeAgentTask      = useAgentStore(s => s.resumeTask);
  const openFile             = useEditorStore(s => s.openFile);

  const [newTitle, setNewTitle]       = useState('');
  const [newPriority, setNewPriority] = useState('medium');
  const [expandedTasks, setExpandedTasks] = useState(new Set());
  const [editingTaskId, setEditingTaskId] = useState(null);
  const [depPickerTaskId, setDepPickerTaskId] = useState(null);
  const [resumingTaskId, setResumingTaskId] = useState(null);
  const [draggedTaskId, setDraggedTaskId] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);  // { taskId, position } | { columnKey }

  const topLevel = useMemo(() => tasks.filter(t => !t.parentId), [tasks]);

  const columnData = useMemo(() =>
    COLUMNS.map(col => ({
      ...col,
      tasks: topLevel.filter(t => col.statuses.includes(t.status)),
    })),
  [topLevel]);

  const handleAdd = useCallback(() => {
    const title = newTitle.trim();
    if (!title) return;
    addTask(title, '', [], newPriority);
    setNewTitle('');
    // Auto-pick: kick the queue worker so the new task starts running immediately
    setTimeout(() => useAgentStore.getState().pickNextQueuedTask(), 100);
  }, [newTitle, newPriority, addTask]);

  // ─── Run all — flip every paused autoRun flag and kick the queue ───
  const handleRunAll = useCallback(() => {
    const ts = useTaskStore.getState();
    // Re-enable autoRun on any task the user previously opted out of
    for (const t of ts.tasks) {
      if (!t.parentId && t.status === 'todo' && t.autoRun === false) {
        ts.updateTask(t.id, { autoRun: true });
      }
    }
    // Ensure AI panel is visible so progress is observable
    usePanelStore.getState().showPanel('ai');
    // Kick the scheduler — it will pick up to MAX_PARALLEL_RUNS tasks and
    // chain through the rest as they finish (pickNextQueuedTask is called
    // after every task completion in agentStore).
    useAgentStore.getState().pickNextQueuedTask();
  }, []);

  // Count queued tasks so we can disable the Run All button when there's nothing to run
  const queuedCount = useMemo(
    () => topLevel.filter(t => t.status === 'todo' && !t.blockReason).length,
    [topLevel]
  );

  const handleAssignToAgent = useCallback((task) => {
    submitTaskFromBoard(task);
    usePanelStore.getState().showPanel('ai');
  }, [submitTaskFromBoard]);

  const handleRetry = useCallback((task) => {
    const reviewContext = task.review?.issues?.map(i => `- ${i.description}`).join('\n') || 'None specified';
    const retryTask = {
      ...task,
      description: `${task.description || task.title}\n\nPrevious review issues:\n${reviewContext}`,
    };
    submitTaskFromBoard(retryTask);
    usePanelStore.getState().showPanel('ai');
  }, [submitTaskFromBoard]);

  const toggleExpand = useCallback((taskId) => {
    setExpandedTasks(prev => {
      const next = new Set(prev);
      next.has(taskId) ? next.delete(taskId) : next.add(taskId);
      return next;
    });
  }, []);

  // ─── Drag handlers ───

  const handleDragStart = useCallback((taskId, e) => {
    setDraggedTaskId(taskId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', taskId);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggedTaskId(null);
    setDropTarget(null);
  }, []);

  const handleCardDragOver = useCallback((targetTaskId, e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!draggedTaskId || draggedTaskId === targetTaskId) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const position = e.clientY < midY ? 'before' : 'after';
    setDropTarget({ taskId: targetTaskId, position });
    e.dataTransfer.dropEffect = 'move';
  }, [draggedTaskId]);

  const handleCardDrop = useCallback((targetTaskId, e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!draggedTaskId || draggedTaskId === targetTaskId) {
      setDropTarget(null);
      return;
    }
    // Check if cross-column drop (need to change status first)
    const dragged = tasks.find(t => t.id === draggedTaskId);
    const target  = tasks.find(t => t.id === targetTaskId);
    if (dragged && target && dragged.status !== target.status) {
      // Map target column statuses
      const targetCol = COLUMNS.find(c => c.statuses.includes(target.status));
      if (targetCol) changeStatus(draggedTaskId, targetCol.targetStatus);
    }
    const position = (dropTarget?.taskId === targetTaskId ? dropTarget.position : 'before');
    reorderTask(draggedTaskId, targetTaskId, position);
    setDraggedTaskId(null);
    setDropTarget(null);
  }, [draggedTaskId, dropTarget, tasks, reorderTask, changeStatus]);

  const handleColumnDragOver = useCallback((columnKey, e) => {
    e.preventDefault();
    if (!draggedTaskId) return;
    setDropTarget({ columnKey });
    e.dataTransfer.dropEffect = 'move';
  }, [draggedTaskId]);

  const handleColumnDrop = useCallback((columnKey, e) => {
    e.preventDefault();
    if (!draggedTaskId) return;
    const col = COLUMNS.find(c => c.key === columnKey);
    if (!col) return;
    const dragged = tasks.find(t => t.id === draggedTaskId);
    if (dragged && !col.statuses.includes(dragged.status)) {
      changeStatus(draggedTaskId, col.targetStatus);
    }
    setDraggedTaskId(null);
    setDropTarget(null);
  }, [draggedTaskId, tasks, changeStatus]);

  const handleOpenFile = useCallback((filePath) => {
    openFile(filePath);
    usePanelStore.getState().showPanel('editor');
  }, [openFile]);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      flex: 1, minWidth: 0, minHeight: 0,
      background: T.bg,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    }}>

      {/* ─── Add Task Bar ─── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '14px 20px',
        borderBottom: `1px solid ${T.border}`,
        background: T.card,
      }}>
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center',
          background: T.bg, borderRadius: 8,
          border: `1px solid ${T.border}`,
        }}>
          <input
            type="text"
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
            placeholder="What needs to be done?"
            style={{
              flex: 1,
              padding: '10px 14px',
              background: 'transparent',
              border: 'none', outline: 'none',
              color: T.text,
              fontSize: 14,
              caretColor: T.accent,
            }}
          />
        </div>

        <div style={{
          position: 'relative', display: 'flex', alignItems: 'center',
          background: T.bg, borderRadius: 8,
          border: `1px solid ${T.border}`,
          padding: '0 4px 0 10px',
          height: 40,
        }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: PRIORITY[newPriority].color,
            marginRight: 8, flexShrink: 0,
          }} />
          <select
            value={newPriority}
            onChange={e => setNewPriority(e.target.value)}
            style={{
              background: 'transparent',
              border: 'none', outline: 'none',
              color: T.dim,
              fontSize: 13,
              cursor: 'pointer',
              paddingRight: 8,
            }}
          >
            {Object.entries(PRIORITY).map(([val, { label }]) => (
              <option key={val} value={val} style={{ background: T.card, color: T.text }}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <button
          onClick={handleAdd}
          disabled={!newTitle.trim()}
          style={{
            padding: '10px 22px',
            borderRadius: 8,
            border: 'none',
            background: newTitle.trim()
              ? `linear-gradient(135deg, ${T.accent}, ${T.accent})`
              : W.accentSoft,
            color: newTitle.trim() ? W.bg0 : T.muted,
            fontSize: 13,
            fontWeight: 600,
            cursor: newTitle.trim() ? 'pointer' : 'default',
            transition: 'all 0.2s',
            letterSpacing: '0.3px',
          }}
        >
          Add Task
        </button>

        <button
          onClick={handleRunAll}
          disabled={queuedCount === 0}
          title={queuedCount === 0
            ? 'No queued tasks'
            : `Run all ${queuedCount} queued task${queuedCount !== 1 ? 's' : ''} now`}
          style={{
            padding: '10px 18px',
            borderRadius: 8,
            border: `1px solid ${queuedCount > 0 ? W.borderHi : W.border}`,
            background: queuedCount > 0 ? W.accentSoft : 'transparent',
            color: queuedCount > 0 ? W.accent : W.textGhost,
            fontSize: 13,
            fontWeight: 600,
            cursor: queuedCount > 0 ? 'pointer' : 'default',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            transition: 'all 0.2s',
            letterSpacing: '0.3px',
          }}
          onMouseEnter={e => {
            if (queuedCount > 0) e.currentTarget.style.background = W.accentHover;
          }}
          onMouseLeave={e => {
            if (queuedCount > 0) e.currentTarget.style.background = W.accentSoft;
          }}
        >
          <span style={{ fontSize: 14 }}>▶</span>
          Run All
          {queuedCount > 0 && (
            <span style={{
              fontSize: 11,
              padding: '2px 6px',
              borderRadius: 10,
              background: W.accent,
              color: W.bg0,
              fontWeight: 700,
            }}>{queuedCount}</span>
          )}
        </button>
      </div>

      {/* ─── Summary Bar ─── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 16,
        padding: '8px 20px',
        borderBottom: `1px solid ${T.borderLt}`,
        background: T.card,
      }}>
        <span style={{ fontSize: 12, color: T.muted, fontWeight: 500 }}>
          {topLevel.length} task{topLevel.length !== 1 ? 's' : ''}
        </span>
        {columnData.map(col => (
          col.tasks.length > 0 && (
            <span key={col.key} style={{
              fontSize: 11, color: T.muted,
              display: 'flex', alignItems: 'center', gap: 4,
            }}>
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                background: col.accent, opacity: 0.6,
              }} />
              {col.tasks.length} {col.label.toLowerCase()}
            </span>
          )
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: T.muted, fontStyle: 'italic' }}>
          Drag to reorder · Drop on column to change status
        </span>
      </div>

      {/* ─── Kanban Columns ─── */}
      <div style={{
        flex: 1, display: 'flex', gap: 12,
        padding: 16, overflow: 'hidden',
      }}>
        {columnData.map(col => (
          <Column
            key={col.key}
            col={col}
            getSubtasks={getSubtasks}
            expandedTasks={expandedTasks}
            toggleExpand={toggleExpand}
            moveToInProgress={moveToInProgress}
            completeTask={completeTask}
            deleteTask={deleteTask}
            handleAssignToAgent={handleAssignToAgent}
            cancelAgentTask={cancelAgentTask}
            pauseAgentTask={pauseAgentTask}
            setResumingTaskId={setResumingTaskId}
            setDepPickerTaskId={setDepPickerTaskId}
            handleRetry={handleRetry}
            editingTaskId={editingTaskId}
            setEditingTaskId={setEditingTaskId}
            editTask={editTask}
            draggedTaskId={draggedTaskId}
            dropTarget={dropTarget}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onCardDragOver={handleCardDragOver}
            onCardDrop={handleCardDrop}
            onColumnDragOver={handleColumnDragOver}
            onColumnDrop={handleColumnDrop}
            onOpenFile={handleOpenFile}
            allTopLevel={topLevel}
          />
        ))}
      </div>

      {/* Dependency picker modal */}
      {depPickerTaskId && (
        <DependencyPicker
          task={topLevel.find(t => t.id === depPickerTaskId)}
          allTasks={topLevel}
          onSave={(deps) => { setDependencies(depPickerTaskId, deps); setDepPickerTaskId(null); }}
          onClose={() => setDepPickerTaskId(null)}
        />
      )}

      {/* Resume dialog */}
      {resumingTaskId && (
        <ResumeDialog
          task={topLevel.find(t => t.id === resumingTaskId)}
          onResume={(notes) => {
            const t = topLevel.find(x => x.id === resumingTaskId);
            if (t?.agentTaskId) resumeAgentTask(t.agentTaskId, notes);
            setResumingTaskId(null);
          }}
          onClose={() => setResumingTaskId(null)}
        />
      )}

      <style>{`
        @keyframes beePulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.6; transform: scale(1.2); }
        }
        @keyframes subtaskProgress {
          from { width: 0; }
        }
        @keyframes cardEnter {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes shimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
      `}</style>
    </div>
  );
}

/* ─── Column ─── */

function Column({
  col, getSubtasks, expandedTasks, toggleExpand,
  moveToInProgress, completeTask, deleteTask,
  handleAssignToAgent, cancelAgentTask, handleRetry,
  pauseAgentTask, setResumingTaskId, setDepPickerTaskId,
  editingTaskId, setEditingTaskId, editTask,
  draggedTaskId, dropTarget,
  onDragStart, onDragEnd, onCardDragOver, onCardDrop,
  onColumnDragOver, onColumnDrop,
  onOpenFile, allTopLevel,
}) {
  const isDropTargetCol = dropTarget?.columnKey === col.key && draggedTaskId &&
    !col.tasks.find(t => t.id === draggedTaskId);

  return (
    <div
      onDragOver={(e) => onColumnDragOver(col.key, e)}
      onDrop={(e) => onColumnDrop(col.key, e)}
      style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        minWidth: 0, borderRadius: 10,
        background: isDropTargetCol ? `${col.accent}10` : 'rgba(139, 148, 158, 0.03)',
        border: isDropTargetCol
          ? `1px dashed ${col.accent}80`
          : `1px solid ${T.borderLt}`,
        transition: 'background 0.15s, border-color 0.15s',
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 14px 10px',
        borderBottom: `1px solid ${T.borderLt}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            width: 8, height: 8, borderRadius: 3,
            background: col.accent, opacity: 0.8,
          }} />
          <span style={{
            fontSize: 12, fontWeight: 600,
            color: T.dim,
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
          }}>
            {col.label}
          </span>
        </div>
        <span style={{
          fontSize: 11, fontWeight: 600,
          color: col.tasks.length > 0 ? T.text : T.muted,
          background: col.tasks.length > 0
            ? 'rgba(139, 148, 158, 0.12)'
            : 'rgba(139, 148, 158, 0.06)',
          padding: '2px 8px',
          borderRadius: 10,
          minWidth: 22, textAlign: 'center',
        }}>
          {col.tasks.length}
        </span>
      </div>

      <div style={{
        flex: 1, overflowY: 'auto',
        padding: 8, display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        {col.tasks.length === 0 ? (
          <EmptyColumn message={col.emptyMsg} highlight={isDropTargetCol} />
        ) : (
          col.tasks.map(task => (
            <TaskCard
              key={task.id}
              task={task}
              colKey={col.key}
              subtasks={getSubtasks(task.id)}
              expanded={expandedTasks.has(task.id)}
              onToggleExpand={() => toggleExpand(task.id)}
              onStart={() => moveToInProgress(task.id)}
              onComplete={() => completeTask(task.id)}
              onDelete={() => deleteTask(task.id)}
              onAssignAgent={() => handleAssignToAgent(task)}
              onCancelAgent={() => cancelAgentTask(task.agentTaskId)}
              onPause={() => pauseAgentTask(task.agentTaskId)}
              onResume={() => setResumingTaskId(task.id)}
              onSetDeps={() => setDepPickerTaskId(task.id)}
              onRetry={() => handleRetry(task)}
              isEditing={editingTaskId === task.id}
              onStartEdit={() => setEditingTaskId(task.id)}
              onSaveEdit={(patch) => { editTask(task.id, patch); setEditingTaskId(null); }}
              onCancelEdit={() => setEditingTaskId(null)}
              allTasks={allTopLevel}
              isDragging={draggedTaskId === task.id}
              isDropTarget={dropTarget?.taskId === task.id}
              dropPosition={dropTarget?.taskId === task.id ? dropTarget.position : null}
              onDragStart={(e) => onDragStart(task.id, e)}
              onDragEnd={onDragEnd}
              onDragOver={(e) => onCardDragOver(task.id, e)}
              onDrop={(e) => onCardDrop(task.id, e)}
              onOpenFile={onOpenFile}
            />
          ))
        )}
      </div>
    </div>
  );
}

/* ─── Empty Column State ─── */

function EmptyColumn({ message, highlight }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: '40px 16px',
      flex: 1,
    }}>
      <div style={{
        width: 36, height: 36, borderRadius: 10,
        background: highlight ? 'rgba(240, 160, 48, 0.1)' : 'rgba(139, 148, 158, 0.06)',
        border: `1px dashed ${highlight ? T.accent : 'rgba(139, 148, 158, 0.2)'}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginBottom: 10,
      }}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="3" y="3" width="10" height="10" rx="2" stroke={highlight ? T.accent : T.muted} strokeWidth="1.2" strokeDasharray="2 2" />
        </svg>
      </div>
      <span style={{
        fontSize: 12, color: highlight ? T.accent : T.muted,
        textAlign: 'center', lineHeight: 1.5,
      }}>
        {highlight ? 'Drop here to move' : message}
      </span>
    </div>
  );
}

/* ─── Task Card ─── */

function TaskCard({
  task, colKey, subtasks, expanded, onToggleExpand,
  onStart, onComplete, onDelete, onAssignAgent, onCancelAgent, onRetry,
  onPause, onResume, onSetDeps,
  isEditing, onStartEdit, onSaveEdit, onCancelEdit,
  isDragging, isDropTarget, dropPosition,
  onDragStart, onDragEnd, onDragOver, onDrop,
  onOpenFile, allTasks,
}) {
  const [hovered, setHovered] = useState(false);

  // Subscribe to the agents array (stable reference) and filter via useMemo.
  // Filtering inside the selector creates a new array every render → infinite loop.
  const agents = useAgentStore(s => s.agents);
  const liveAgents = useMemo(
    () => agents.filter(a => a.runId && task.agentTaskId === a.runId),
    [agents, task.agentTaskId]
  );

  // Pull the linked run for cost + cache display
  const runs = useAgentStore(s => s.runs);
  const linkedRun = useMemo(
    () => task.agentTaskId ? runs.get(task.agentTaskId) : null,
    [runs, task.agentTaskId]
  );

  const isAgentWorking = task.status === 'agent_working';
  const isNeedsReview  = task.status === 'needs_review';
  const isDone         = task.status === 'done';
  const hasSubtasks    = subtasks.length > 0;
  const doneSubtasks   = subtasks.filter(s => s.status === 'done').length;
  const subtaskPct     = hasSubtasks ? (doneSubtasks / subtasks.length) * 100 : 0;

  const cardBorder = isAgentWorking
    ? `1px solid rgba(240, 160, 48, 0.35)`
    : isNeedsReview
      ? `1px solid rgba(59, 130, 246, 0.25)`
      : `1px solid ${T.border}`;

  const cardBg = isAgentWorking
    ? 'rgba(240, 160, 48, 0.04)'
    : isNeedsReview
      ? 'rgba(59, 130, 246, 0.04)'
      : T.card;

  return (
    <div style={{
      animation: 'cardEnter 0.25s ease-out',
      position: 'relative',
    }}>
      {/* Drop indicator line */}
      {isDropTarget && dropPosition === 'before' && (
        <div style={{
          position: 'absolute', top: -4, left: 0, right: 0, height: 2,
          background: T.accent, borderRadius: 2,
          boxShadow: `0 0 8px ${T.accent}`,
          zIndex: 10,
        }} />
      )}

      <div
        draggable={!isEditing}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          background: hovered ? T.cardHover : cardBg,
          border: cardBorder,
          borderRadius: 10,
          padding: '12px 14px',
          transition: 'all 0.2s ease',
          transform: isDragging ? 'scale(0.97)' : (hovered ? 'translateY(-1px)' : 'none'),
          opacity: isDragging ? 0.5 : 1,
          boxShadow: hovered
            ? '0 4px 16px rgba(0, 0, 0, 0.3)'
            : '0 1px 3px rgba(0, 0, 0, 0.12)',
          cursor: isEditing ? 'default' : 'grab',
        }}
      >
        {isEditing ? (
          <EditTaskForm task={task} onSave={onSaveEdit} onCancel={onCancelEdit} />
        ) : (
          <>
            {/* Top row: priority/bee + title */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  {isAgentWorking ? (
                    <span style={{
                      fontSize: 14,
                      animation: 'beePulse 1.5s infinite',
                      flexShrink: 0, lineHeight: 1,
                    }}>🐝</span>
                  ) : (
                    <span style={{
                      width: 9, height: 9, borderRadius: '50%',
                      background: PRIORITY[task.priority]?.color || T.muted,
                      flexShrink: 0,
                      boxShadow: task.priority === 'critical' ? '0 0 6px rgba(239, 68, 68, 0.4)' : 'none',
                    }} />
                  )}
                  <span style={{
                    fontSize: 14, fontWeight: 600,
                    color: isDone ? T.muted : T.text,
                    textDecoration: isDone ? 'line-through' : 'none',
                    lineHeight: 1.3,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    flex: 1,
                  }}>
                    {task.title}
                  </span>
                </div>

                {/* Description preview */}
                {task.description && !isAgentWorking && !isNeedsReview && (
                  <div style={{
                    fontSize: 12, color: T.dim,
                    lineHeight: 1.4, marginBottom: 6,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}>
                    {task.description}
                  </div>
                )}

                {/* Live agent progress */}
                {isAgentWorking && task.agentProgress && (
                  <LiveAgentProgress
                    progress={task.agentProgress}
                    agents={liveAgents}
                    run={linkedRun}
                    onOpenFile={onOpenFile}
                  />
                )}

                {/* Status banners (blocked, paused, edited) */}
                {task.status === 'blocked' && task.blockReason && (
                  <div style={{
                    marginTop: 6, padding: '6px 10px', borderRadius: 6,
                    background: 'rgba(248, 81, 73, 0.08)',
                    border: '1px solid rgba(248, 81, 73, 0.2)',
                    fontSize: 11, color: T.red,
                  }}>
                    🚧 Blocked: {task.blockReason}
                  </div>
                )}
                {task.status === 'paused' && (
                  <div style={{
                    marginTop: 6, padding: '6px 10px', borderRadius: 6,
                    background: 'rgba(240, 160, 48, 0.08)',
                    border: '1px solid rgba(240, 160, 48, 0.2)',
                    fontSize: 11, color: T.accent,
                  }}>
                    ⏸ Paused — click Resume to continue
                  </div>
                )}
                {task.editedDuringRun && (
                  <div style={{
                    marginTop: 6, padding: '6px 10px', borderRadius: 6,
                    background: 'rgba(59, 130, 246, 0.08)',
                    border: '1px solid rgba(59, 130, 246, 0.2)',
                    fontSize: 11, color: T.blue,
                  }}>
                    ✎ Edited during run — click Retry to apply
                  </div>
                )}

                {/* Badges row */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  flexWrap: 'wrap', marginTop: 6,
                }}>
                  {task.source === 'agent_queued' && (
                    <Badge text="🐝 AI queued" bg={T.accentDim} color={T.accent} />
                  )}
                  {task.source === 'agent' && (
                    <Badge text="🐝 from agent" bg={T.accentDim} color={T.accent} />
                  )}
                  {task.dependsOn?.length > 0 && (
                    <Badge text={`⛓ ${task.dependsOn.length} dep${task.dependsOn.length !== 1 ? 's' : ''}`} bg="rgba(139, 148, 158, 0.1)" color={T.dim} />
                  )}

                  {/* Clickable file pills */}
                  {task.files?.length > 0 && task.files.slice(0, 3).map(f => (
                    <button
                      key={f}
                      onClick={(e) => { e.stopPropagation(); onOpenFile(f); }}
                      style={{
                        fontSize: 11,
                        padding: '2px 8px',
                        borderRadius: 6,
                        background: 'rgba(139, 148, 158, 0.08)',
                        color: T.dim,
                        border: 'none',
                        cursor: 'pointer',
                        fontFamily: '"JetBrains Mono", monospace',
                        whiteSpace: 'nowrap',
                        transition: 'all 0.15s',
                      }}
                      onMouseEnter={e => {
                        e.currentTarget.style.background = 'rgba(240, 160, 48, 0.15)';
                        e.currentTarget.style.color = T.accent;
                      }}
                      onMouseLeave={e => {
                        e.currentTarget.style.background = 'rgba(139, 148, 158, 0.08)';
                        e.currentTarget.style.color = T.dim;
                      }}
                      title={f}
                    >
                      {f.split('/').pop()}
                    </button>
                  ))}
                  {task.files?.length > 3 && (
                    <Badge text={`+${task.files.length - 3}`} bg="rgba(139, 148, 158, 0.08)" color={T.muted} />
                  )}
                </div>

                {/* Subtask progress bar */}
                {hasSubtasks && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
                    <div style={{
                      flex: 1, height: 4, borderRadius: 4,
                      background: 'rgba(139, 148, 158, 0.1)',
                      overflow: 'hidden',
                    }}>
                      <div style={{
                        height: '100%', borderRadius: 4,
                        width: `${subtaskPct}%`,
                        background: subtaskPct === 100
                          ? T.green
                          : `linear-gradient(90deg, ${T.accent}, ${T.accent})`,
                        transition: 'width 0.4s ease',
                      }} />
                    </div>
                    <span style={{
                      fontSize: 11, color: T.dim, fontWeight: 500,
                      flexShrink: 0, whiteSpace: 'nowrap',
                    }}>
                      {doneSubtasks}/{subtasks.length}
                    </span>
                  </div>
                )}

                {/* Review summary */}
                {isNeedsReview && task.review && (
                  <ReviewSummary review={task.review} />
                )}
              </div>

              {/* Action buttons */}
              <div style={{
                display: 'flex', flexDirection: 'column', gap: 4,
                flexShrink: 0,
              }}>
                {/* Status: blocked — show only Delete + dep info */}
                {task.status === 'blocked' && (
                  <>
                    {hovered && <ActionButton label="Delete" color={T.red} onClick={onDelete} />}
                  </>
                )}
                {/* Status: paused — show Resume + Stop */}
                {task.status === 'paused' && (
                  <>
                    <ActionButton label="▶ Resume" color={T.accent} onClick={onResume} primary />
                    <ActionButton label="Stop" color={T.red} onClick={onCancelAgent} />
                  </>
                )}
                {/* Status: todo (and not blocked/paused) — show Run + Edit + Deps + Delete */}
                {colKey === 'todo' && task.status === 'todo' && (
                  <>
                    <ActionButton label="🐝 Run" color={T.accent} onClick={onAssignAgent} primary />
                    {hovered && (
                      <>
                        <ActionButton label="Edit" color={T.dim} onClick={onStartEdit} />
                        <ActionButton label="Deps" color={T.dim} onClick={onSetDeps} />
                        <ActionButton label="Delete" color={T.red} onClick={onDelete} />
                      </>
                    )}
                  </>
                )}
                {colKey === 'in_progress' && !isAgentWorking && (
                  <>
                    <ActionButton label="🐝 Run" color={T.accent} onClick={onAssignAgent} primary />
                    <ActionButton label="Done" color={T.green} onClick={onComplete} />
                    {hovered && <ActionButton label="Edit" color={T.dim} onClick={onStartEdit} />}
                  </>
                )}
                {colKey === 'in_progress' && isAgentWorking && (
                  <>
                    <ActionButton label="⏸ Pause" color={T.dim} onClick={onPause} />
                    <ActionButton label="Stop" color={T.red} onClick={onCancelAgent} />
                  </>
                )}
                {colKey === 'needs_review' && (
                  <>
                    <ActionButton label="Approve" color={T.green} onClick={onComplete} primary />
                    <ActionButton label="Retry" color={T.accent} onClick={onRetry} />
                    {hovered && <ActionButton label="Delete" color={T.red} onClick={onDelete} />}
                  </>
                )}
                {colKey === 'done' && hovered && (
                  <ActionButton label="Delete" color={T.red} onClick={onDelete} />
                )}
              </div>
            </div>

            {/* Subtask expand toggle */}
            {hasSubtasks && (
              <button
                onClick={onToggleExpand}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  marginTop: 8, padding: '3px 0',
                  background: 'none', border: 'none',
                  color: T.muted, fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                <span style={{
                  display: 'inline-block',
                  transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
                  transition: 'transform 0.2s ease',
                  fontSize: 10,
                }}>▶</span>
                {subtasks.length} subtask{subtasks.length !== 1 ? 's' : ''}
              </button>
            )}
          </>
        )}
      </div>

      {/* Drop indicator after */}
      {isDropTarget && dropPosition === 'after' && (
        <div style={{
          position: 'absolute', bottom: -4, left: 0, right: 0, height: 2,
          background: T.accent, borderRadius: 2,
          boxShadow: `0 0 8px ${T.accent}`,
          zIndex: 10,
        }} />
      )}

      {/* Expanded subtask list */}
      {hasSubtasks && expanded && (
        <div style={{
          marginLeft: 14, marginTop: 4,
          borderLeft: `2px solid rgba(139, 148, 158, 0.1)`,
          paddingLeft: 10,
          display: 'flex', flexDirection: 'column', gap: 4,
        }}>
          {subtasks.map(sub => (
            <div key={sub.id} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 10px',
              borderRadius: 6,
              background: 'rgba(139, 148, 158, 0.03)',
              border: '1px solid rgba(139, 148, 158, 0.06)',
            }}>
              <span style={{
                fontSize: 12,
                color: sub.status === 'done' ? T.green
                  : sub.status === 'agent_working' ? T.accent
                  : T.muted,
              }}>
                {sub.status === 'done' ? '✓' : sub.status === 'agent_working' ? '◌' : '○'}
              </span>
              <span style={{
                fontSize: 13, lineHeight: 1.3,
                color: sub.status === 'done' ? T.muted : T.dim,
                textDecoration: sub.status === 'done' ? 'line-through' : 'none',
                flex: 1, overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {sub.title}
              </span>
              {sub.files?.length > 0 && (
                <span style={{ fontSize: 11, color: T.muted }}>
                  {sub.files.length}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Live Agent Progress ─── */

function LiveAgentProgress({ progress, agents, run, onOpenFile }) {
  if (!progress) return null;
  const role = AGENT_ROLES[progress.agentRole] || AGENT_ROLES.coder;
  const action = progress.phase === 'editing' ? 'Editing' : 'Reading';

  // Cache hit ratio
  const cacheRead = run?.cacheHits?.read || 0;
  const tokensPaid = run?.tokensUsed || 0;
  const cacheRatio = cacheRead > 0 ? Math.round((cacheRead / (cacheRead + tokensPaid)) * 100) : 0;
  const cost = run?.cost || 0;

  return (
    <div style={{
      marginTop: 8, marginBottom: 6,
      padding: '8px 10px',
      borderRadius: 6,
      background: `${role.color}10`,
      border: `1px solid ${role.color}30`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span style={{ fontSize: 13 }}>{role.icon}</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: role.color }}>
          {role.name}
        </span>
        <span style={{ fontSize: 10, color: T.dim, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {action}
        </span>
        {cost > 0 && (
          <span style={{ marginLeft: 'auto', fontSize: 10, color: T.dim, fontFamily: '"JetBrains Mono", monospace' }}>
            ${cost.toFixed(3)}
            {cacheRatio > 0 && <span style={{ color: T.green, marginLeft: 4 }}>· {cacheRatio}% cached</span>}
          </span>
        )}
      </div>
      {progress.currentFile && (
        <button
          onClick={(e) => { e.stopPropagation(); onOpenFile(progress.currentFile); }}
          style={{
            background: 'transparent',
            border: 'none',
            padding: 0,
            color: T.text,
            fontSize: 11,
            fontFamily: '"JetBrains Mono", monospace',
            cursor: 'pointer',
            textAlign: 'left',
            wordBreak: 'break-all',
            textDecoration: 'underline',
            textDecorationColor: 'transparent',
            transition: 'text-decoration-color 0.15s',
          }}
          onMouseEnter={e => e.currentTarget.style.textDecorationColor = T.accent}
          onMouseLeave={e => e.currentTarget.style.textDecorationColor = 'transparent'}
        >
          {progress.currentFile}
        </button>
      )}
    </div>
  );
}

/* ─── Edit Task Form ─── */

function EditTaskForm({ task, onSave, onCancel }) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description || '');
  const [priority, setPriority] = useState(task.priority);
  const titleRef = useRef(null);

  const handleSave = useCallback(() => {
    if (!title.trim()) return;
    onSave({ title: title.trim(), description: description.trim(), priority });
  }, [title, description, priority, onSave]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <input
        ref={titleRef}
        type="text"
        value={title}
        autoFocus
        onChange={e => setTitle(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSave(); }
          if (e.key === 'Escape') onCancel();
        }}
        style={{
          padding: '8px 10px',
          background: T.bg,
          border: `1px solid ${T.borderHi}`,
          borderRadius: 6,
          color: T.text,
          fontSize: 14,
          fontWeight: 600,
          outline: 'none',
        }}
      />
      <textarea
        value={description}
        onChange={e => setDescription(e.target.value)}
        placeholder="Description (optional)"
        rows={3}
        style={{
          padding: '8px 10px',
          background: T.bg,
          border: `1px solid ${T.border}`,
          borderRadius: 6,
          color: T.text,
          fontSize: 12,
          fontFamily: 'inherit',
          outline: 'none',
          resize: 'vertical',
          minHeight: 50,
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <select
          value={priority}
          onChange={e => setPriority(e.target.value)}
          style={{
            padding: '6px 10px',
            background: T.bg,
            border: `1px solid ${T.border}`,
            borderRadius: 6,
            color: T.text,
            fontSize: 12,
            outline: 'none',
            cursor: 'pointer',
          }}
        >
          {Object.entries(PRIORITY).map(([val, { label }]) => (
            <option key={val} value={val} style={{ background: T.card }}>{label}</option>
          ))}
        </select>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={onCancel} style={{
            padding: '6px 12px', borderRadius: 6, border: `1px solid ${T.border}`,
            background: 'transparent', color: T.dim, fontSize: 12, cursor: 'pointer',
          }}>Cancel</button>
          <button onClick={handleSave} style={{
            padding: '6px 14px', borderRadius: 6, border: 'none',
            background: T.accent, color: W.bg0, fontSize: 12, fontWeight: 600, cursor: 'pointer',
          }}>Save</button>
        </div>
      </div>
    </div>
  );
}

/* ─── Review Summary ─── */

function ReviewSummary({ review }) {
  return (
    <div style={{
      marginTop: 10, padding: '8px 10px',
      background: 'rgba(59, 130, 246, 0.06)',
      borderRadius: 6,
      border: '1px solid rgba(59, 130, 246, 0.1)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: T.blue }}>
          {review.confidence != null ? `${Math.round(review.confidence * 100)}% confidence` : 'Review'}
        </span>
      </div>
      {review.summary && (
        <div style={{ fontSize: 12, color: T.dim, lineHeight: 1.4, marginBottom: review.issues?.length > 0 ? 6 : 0 }}>
          {review.summary}
        </div>
      )}
      {review.issues?.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {review.issues.slice(0, 3).map((issue, i) => (
            <div key={i} style={{ fontSize: 11, display: 'flex', alignItems: 'flex-start', gap: 5 }}>
              <span style={{
                color: issue.severity === 'critical' ? T.red
                  : issue.severity === 'major' ? W.yellow
                  : T.muted,
              }}>
                {issue.severity === 'critical' ? '●' : issue.severity === 'major' ? '◐' : '○'}
              </span>
              <span style={{ color: T.dim, lineHeight: 1.4 }}>{issue.description}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Small UI Primitives ─── */

function Badge({ text, bg, color }) {
  return (
    <span style={{
      fontSize: 11, fontWeight: 500,
      padding: '2px 7px',
      borderRadius: 6,
      background: bg,
      color,
      whiteSpace: 'nowrap',
      lineHeight: 1.5,
    }}>
      {text}
    </span>
  );
}

/* ─── Dependency Picker Modal ─── */

function DependencyPicker({ task, allTasks, onSave, onClose }) {
  const [selected, setSelected] = useState(new Set(task?.dependsOn || []));

  if (!task) return null;
  const candidates = allTasks.filter(t => t.id !== task.id);

  const toggle = (id) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  const footer = (
    <>
      <ModalButton variant="ghost" onClick={onClose}>Cancel</ModalButton>
      <ModalButton variant="primary" onClick={() => onSave([...selected])}>
        Save ({selected.size})
      </ModalButton>
    </>
  );

  return (
    <Modal
      open={true}
      onClose={onClose}
      title="Set dependencies"
      icon="⛓"
      subtitle={`"${task.title}" waits for these`}
      width={520}
      footer={footer}
    >
      {candidates.length === 0 ? (
        <div style={{ padding: 20, textAlign: 'center', color: W.textMuted, fontSize: W.fontMd }}>
          No other tasks to depend on
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: W.s1 }}>
          {candidates.map(t => (
            <button
              key={t.id}
              onClick={() => toggle(t.id)}
              style={{
                width: '100%',
                display: 'flex', alignItems: 'center', gap: W.s3,
                padding: `${W.s2}px ${W.s3}px`,
                borderRadius: W.radius2,
                border: `1px solid ${selected.has(t.id) ? W.borderHi : W.border}`,
                background: selected.has(t.id) ? W.accentSoft : 'transparent',
                color: W.text,
                cursor: 'pointer',
                textAlign: 'left',
                transition: `all ${W.animFast}`,
              }}
              onMouseEnter={e => { if (!selected.has(t.id)) e.currentTarget.style.background = W.bg3; }}
              onMouseLeave={e => { if (!selected.has(t.id)) e.currentTarget.style.background = 'transparent'; }}
            >
              <span style={{
                width: 16, height: 16, borderRadius: W.radius1,
                border: `1.5px solid ${selected.has(t.id) ? W.accent : W.textMuted}`,
                background: selected.has(t.id) ? W.accent : 'transparent',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}>
                {selected.has(t.id) && <span style={{ color: W.bg0, fontSize: 11, fontWeight: W.fontWeightBold }}>✓</span>}
              </span>
              <span style={{
                width: 8, height: 8, borderRadius: '50%',
                background: PRIORITY[t.priority]?.color || W.textMuted,
                flexShrink: 0,
              }} />
              <span style={{ flex: 1, fontSize: W.fontMd, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t.title}
              </span>
              <span style={{ fontSize: W.fontXs, color: W.textMuted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                {t.status}
              </span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

/* ─── Resume Dialog ─── */

function ResumeDialog({ task, onResume, onClose }) {
  const [notes, setNotes] = useState('');

  if (!task) return null;

  const footer = (
    <>
      <ModalButton variant="ghost" onClick={onClose}>Cancel</ModalButton>
      <ModalButton variant="primary" onClick={() => onResume(notes)}>▶ Resume</ModalButton>
    </>
  );

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={`Resume "${task.title}"`}
      icon="▶"
      width={520}
      footer={footer}
    >
      <div style={{ fontSize: W.fontMd, color: W.textDim, marginBottom: W.s3, lineHeight: 1.5 }}>
        The agent will continue from where it left off using the cached session.
        You can add additional instructions below.
      </div>
      <textarea
        value={notes}
        onChange={e => setNotes(e.target.value)}
        placeholder="Optional: additional instructions or corrections…"
        rows={5}
        autoFocus
        style={{
          width: '100%',
          padding: `${W.s2}px ${W.s3}px`,
          background: W.bg0,
          border: `1px solid ${W.border}`,
          borderRadius: W.radius2,
          color: W.text,
          fontSize: W.fontMd,
          outline: 'none',
          fontFamily: 'inherit',
          resize: 'vertical',
        }}
        onFocus={e => e.currentTarget.style.borderColor = W.borderHi}
        onBlur={e => e.currentTarget.style.borderColor = W.border}
      />
    </Modal>
  );
}

/* ─── Shared modal button ─── */

function ModalButton({ variant = 'ghost', onClick, children }) {
  const isPrimary = variant === 'primary';
  return (
    <button
      onClick={onClick}
      style={{
        padding: `${W.s2}px ${W.s4}px`,
        height: W.buttonHeight,
        borderRadius: W.radius2,
        border: isPrimary ? 'none' : `1px solid ${W.border}`,
        background: isPrimary ? W.accent : 'transparent',
        color: isPrimary ? W.bg0 : W.textDim,
        fontSize: W.fontMd,
        fontWeight: W.fontWeightSemi,
        cursor: 'pointer',
        transition: `all ${W.animFast}`,
      }}
      onMouseEnter={e => {
        if (isPrimary) {
          e.currentTarget.style.boxShadow = '0 0 0 2px rgba(240, 160, 48, 0.25)';
        } else {
          e.currentTarget.style.background = W.bg3;
          e.currentTarget.style.color = W.text;
        }
      }}
      onMouseLeave={e => {
        e.currentTarget.style.boxShadow = 'none';
        if (!isPrimary) {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = W.textDim;
        }
      }}
    >{children}</button>
  );
}

function ActionButton({ label, color, onClick, primary }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: '5px 12px',
        borderRadius: 6,
        border: 'none',
        fontSize: 11,
        fontWeight: 700,
        cursor: 'pointer',
        color: primary || hovered ? W.bg0 : color,
        background: primary || hovered ? color : `${color}20`,
        transition: 'all 0.15s ease',
        whiteSpace: 'nowrap',
        lineHeight: 1.4,
      }}
    >
      {label}
    </button>
  );
}
