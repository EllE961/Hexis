/**
 * @module taskStore
 * @description
 * Zustand store for development tasks and todos. Tasks can be created
 * manually by the user or spawned by AI agents from the agent-orchestrator.
 * The list is persisted to localStorage under the key `hexis-tasks`.
 *
 * Each task optionally links to one or more file paths shown on the hex grid,
 * supports a subtask hierarchy via `parentId`, and carries agent integration
 * fields that bridge this store with `agentStore`.
 *
 * **Status state machine**
 * ```
 * Manual:  todo → in_progress → done
 * Agent:   todo → agent_working → needs_review → done
 * Error:   (any agent status) → todo          (via onAgentError)
 * ```
 *
 * **Agent pipeline flow**
 * ```
 * 1. Auto-pickup  agentStore.pickNextQueuedTask() scans for tasks where
 *                 status === 'todo' && source === 'agent_queued', respects
 *                 MAX_PARALLEL_RUNS = 3, and detects file-claim conflicts.
 * 2. Planner      SSE 'plan_ready' → agentStore calls
 *                 taskStore.updateTask(linkedTaskId, { agentPlan })
 *                 taskStore.createSubtasksFromPlan(parentId, subtasks, runId)
 *                 Children are inserted with parentId set and status 'agent_working'.
 * 3. Coder        SSE 'subtask_complete' → agentStore calls
 *                 taskStore.completeTask(childId)  (child → 'done')
 * 4. Reviewer     SSE 'task_review'    → agentStore calls
 *                 taskStore.updateTask(id, { review })
 *                 SSE 'task_complete'  → agentStore calls
 *                 taskStore.onAgentComplete(id, review)
 *                 → 'done' if review.approved !== false, else 'needs_review'
 * 5. Error/cancel agent_error OR cancelTask() → agentStore calls
 *                 taskStore.onAgentError(id) → resets to 'todo', clears agentTaskId
 * ```
 *
 * @typedef {Object} Task
 * @property {string}      id              - Unique ID (`task-<timestamp>-<rand>`)
 * @property {string}      title           - Short display title
 * @property {string}      description     - Optional longer description
 * @property {'todo'|'in_progress'|'agent_working'|'needs_review'|'done'} status
 * @property {'low'|'medium'|'high'|'critical'} priority
 * @property {string[]}    files           - File paths linked to this task
 * @property {number}      createdAt       - Unix ms timestamp
 * @property {number|null} completedAt     - Unix ms timestamp, or null
 * @property {string|null} parentId        - Parent task ID for subtask hierarchy
 * @property {string|null} agentTaskId     - Links to `agentStore` activeTask.id
 * @property {string|null} agentSubtaskId  - Links to planner subtask ID
 * @property {'manual'|'agent'} source     - How the task was created
 * @property {Object|null} review          - Agent review: { approved, confidence, summary, issues }
 * @property {Object|null} agentPlan       - Plan summary injected by the planner agent
 *
 * @typedef {Object} TaskState
 * @property {Task[]}  tasks      - All tasks (top-level + subtasks)
 * @property {string}  filter     - Active filter: all | todo | in_progress | agent_working | needs_review | done
 * @property {boolean} panelOpen  - Whether the TaskBoard panel is visible
 */

import { create } from 'zustand';

// ─── Persistence helpers ───
// Per-workspace storage: `hexis-tasks:<workspace>` so tasks from one
// project don't leak into another when the user switches workspaces.

const STORAGE_PREFIX = 'hexis-tasks:';
const LEGACY_KEY = 'hexis-tasks'; // pre-namespace — migrated once

// Module-level so the closures inside store methods don't need to
// thread the workspace path through every call.
let currentWorkspace = null;

function storageKey(workspace) {
  return STORAGE_PREFIX + (workspace || 'default');
}

function loadTasks(workspace) {
  try {
    const raw = localStorage.getItem(storageKey(workspace));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Sanitize on load: orphaned `agent_working` tasks (the server lost its
    // run) → reset to `todo` so the queue worker can re-attempt them.
    return parsed.map(t => {
      if (!t || typeof t !== 'object') return null;
      if (t.status === 'agent_working') {
        return { ...t, status: 'todo', agentTaskId: null };
      }
      return t;
    }).filter(Boolean);
  } catch (err) {
    console.warn('[taskStore] Failed to load tasks from localStorage:', err);
    return [];
  }
}

function saveTasks(tasks) {
  try {
    localStorage.setItem(storageKey(currentWorkspace), JSON.stringify(tasks));
  } catch (err) {
    console.warn('[taskStore] Failed to save tasks to localStorage:', err);
  }
}

// One-shot migration: move pre-namespace data into the 'default' bucket.
function migrateLegacy() {
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy && !localStorage.getItem(storageKey('default'))) {
      localStorage.setItem(storageKey('default'), legacy);
    }
    if (legacy) localStorage.removeItem(LEGACY_KEY);
  } catch { /* ignore */ }
}
migrateLegacy();

// ─── Store ───

export const useTaskStore = create((set, get) => ({
  tasks: [],
  filter: 'all',      // all | todo | in_progress | agent_working | needs_review | done
  panelOpen: false,

  /** Switch to the task list for a different workspace. Call on open-folder. */
  setWorkspace: (workspace) => {
    if (currentWorkspace === workspace) return;
    currentWorkspace = workspace;
    set({ tasks: loadTasks(workspace) });
  },

  togglePanel: () => set(s => ({ panelOpen: !s.panelOpen })),

  // ─── Create ───

  addTask: (title, description = '', files = [], priority = 'medium', extra = {}) => {
    const task = {
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title,
      description,
      status: 'todo',
      priority,             // low | medium | high | critical
      files,
      createdAt: Date.now(),
      completedAt: null,
      // Agent integration fields
      parentId: extra.parentId || null,           // subtask hierarchy
      agentTaskId: extra.agentTaskId || null,     // links to agentStore activeTask.id
      agentSubtaskId: extra.agentSubtaskId || null, // links to planner subtask ID
      source: extra.source || 'manual',           // 'manual' | 'agent'
      review: null,                               // { approved, confidence, summary, issues }
      agentPlan: null,                            // plan summary from planner
      // Dependencies
      dependsOn: extra.dependsOn || [],           // task IDs this task waits for
      blockReason: null,                          // why this task is currently blocked
      // Edit tracking
      editedDuringRun: false,                     // user edited while agent was running
      pausedAt: null,                             // timestamp when paused
      // Auto-run: if false, task stays in todo until user clicks Run.
      // Default is true so tasks added by either UI auto-pick.
      autoRun: extra.autoRun !== false,
    };
    set(s => {
      const tasks = [task, ...s.tasks];
      saveTasks(tasks);
      return { tasks };
    });
    return task;
  },

  // ─── Update ───

  updateTask: (id, updates) => set(s => {
    const tasks = s.tasks.map(t => t.id === id ? { ...t, ...updates } : t);
    saveTasks(tasks);
    return { tasks };
  }),

  deleteTask: (id) => set(s => {
    // Also delete children
    const tasks = s.tasks.filter(t => t.id !== id && t.parentId !== id);
    saveTasks(tasks);
    return { tasks };
  }),

  completeTask: (id) => set(s => {
    const tasks = s.tasks.map(t => t.id === id ? { ...t, status: 'done', completedAt: Date.now() } : t);
    saveTasks(tasks);
    return { tasks };
  }),

  moveToInProgress: (id) => set(s => {
    const tasks = s.tasks.map(t => t.id === id ? { ...t, status: 'in_progress' } : t);
    saveTasks(tasks);
    return { tasks };
  }),

  // ─── Agent integration ───

  assignToAgent: (taskId, agentTaskId) => set(s => {
    const tasks = s.tasks.map(t => t.id === taskId
      ? { ...t, status: 'agent_working', agentTaskId }
      : t
    );
    saveTasks(tasks);
    return { tasks };
  }),

  createSubtasksFromPlan: (parentId, subtasks, agentTaskId) => {
    const newTasks = subtasks.map(st => ({
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title: st.title,
      description: st.description || '',
      status: 'agent_working',
      priority: 'medium',
      files: st.files || [],
      createdAt: Date.now(),
      completedAt: null,
      parentId,
      agentTaskId,
      agentSubtaskId: st.id,
      source: 'agent',
      review: null,
      agentPlan: null,
    }));

    set(s => {
      const tasks = [...newTasks, ...s.tasks];
      saveTasks(tasks);
      return { tasks };
    });

    return newTasks;
  },

  onAgentComplete: (taskId, review) => set(s => {
    const status = review?.approved !== false ? 'done' : 'needs_review';
    const tasks = s.tasks.map(t => t.id === taskId
      ? { ...t, status, review, completedAt: status === 'done' ? Date.now() : null }
      : t
    );
    saveTasks(tasks);
    return { tasks };
  }),

  onAgentError: (taskId, error) => set(s => {
    const tasks = s.tasks.map(t => t.id === taskId
      ? { ...t, status: 'todo', agentTaskId: null, review: null }
      : t
    );
    saveTasks(tasks);
    return { tasks };
  }),

  // ─── Dependencies ───

  /** Set explicit dependencies on a task. Validates against cycles. */
  setDependencies: (taskId, dependsOn) => set(s => {
    // Cycle detection: walk the dependency graph from the new deps
    const allTasks = new Map(s.tasks.map(t => [t.id, t]));
    function hasCycle(start, target, visited = new Set()) {
      if (start === target) return true;
      if (visited.has(start)) return false;
      visited.add(start);
      const t = allTasks.get(start);
      for (const dep of (t?.dependsOn || [])) {
        if (hasCycle(dep, target, visited)) return true;
      }
      return false;
    }
    for (const dep of dependsOn) {
      if (hasCycle(dep, taskId)) {
        console.warn(`[taskStore] Refused dependency: cycle detected via ${dep}`);
        return {};
      }
    }
    const tasks = s.tasks.map(t => t.id === taskId ? { ...t, dependsOn } : t);
    saveTasks(tasks);
    return { tasks };
  }),

  /**
   * Check if all dependencies of a task are satisfied (status === 'done').
   * Returns { ready, blockedBy } — blockedBy lists deps that are not yet done.
   */
  getDependencyStatus: (taskId) => {
    const all = get().tasks;
    const t = all.find(x => x.id === taskId);
    if (!t || !t.dependsOn?.length) return { ready: true, blockedBy: [] };
    const blockedBy = [];
    for (const depId of t.dependsOn) {
      const dep = all.find(x => x.id === depId);
      if (!dep) continue;  // missing dep — skip silently
      if (dep.status !== 'done') blockedBy.push(dep);
    }
    return { ready: blockedBy.length === 0, blockedBy };
  },

  /** Cascade: when a task fails, mark all tasks that depend on it as blocked. */
  cascadeFailure: (failedTaskId, reason) => set(s => {
    const cascade = new Set([failedTaskId]);
    let changed = true;
    // Walk forward to find all transitive dependents
    while (changed) {
      changed = false;
      for (const t of s.tasks) {
        if (cascade.has(t.id)) continue;
        if (t.dependsOn?.some(d => cascade.has(d))) {
          cascade.add(t.id);
          changed = true;
        }
      }
    }
    // Don't include the failed task itself
    cascade.delete(failedTaskId);
    if (cascade.size === 0) return {};
    const tasks = s.tasks.map(t =>
      cascade.has(t.id) && t.status !== 'done'
        ? { ...t, status: 'blocked', blockReason: `Waiting on failed dependency: ${reason}` }
        : t
    );
    saveTasks(tasks);
    return { tasks };
  }),

  /** Cascade unblock: when a task succeeds, unblock dependent tasks if their deps are now satisfied. */
  cascadeUnblock: () => set(s => {
    const all = s.tasks;
    const tasks = all.map(t => {
      if (t.status !== 'blocked') return t;
      const allDepsDone = (t.dependsOn || []).every(depId => {
        const dep = all.find(x => x.id === depId);
        return dep && dep.status === 'done';
      });
      if (allDepsDone) return { ...t, status: 'todo', blockReason: null };
      return t;
    });
    saveTasks(tasks);
    return { tasks };
  }),

  /** Mark a task as edited while it's being worked on. */
  markEditedDuringRun: (taskId) => set(s => {
    const tasks = s.tasks.map(t => t.id === taskId ? { ...t, editedDuringRun: true } : t);
    saveTasks(tasks);
    return { tasks };
  }),

  /** Mark a task as paused (agent was interrupted, can resume). */
  markPaused: (taskId, sessionId) => set(s => {
    const tasks = s.tasks.map(t => t.id === taskId
      ? { ...t, status: 'paused', pausedAt: Date.now(), pausedSessionId: sessionId }
      : t
    );
    saveTasks(tasks);
    return { tasks };
  }),

  // ─── Drag-drop reordering + moving between columns ───

  /** Change a task's status (used when dropped on a different column). */
  changeStatus: (taskId, newStatus) => set(s => {
    const tasks = s.tasks.map(t => {
      if (t.id !== taskId) return t;
      const patch = { status: newStatus };
      if (newStatus === 'done') patch.completedAt = Date.now();
      return { ...t, ...patch };
    });
    saveTasks(tasks);
    return { tasks };
  }),

  /**
   * Reorder a task so it comes immediately before or after targetId within the top-level list.
   * Both tasks must be top-level (no parentId).
   */
  reorderTask: (draggedId, targetId, position = 'before') => set(s => {
    const dragged = s.tasks.find(t => t.id === draggedId);
    const target = s.tasks.find(t => t.id === targetId);
    if (!dragged || !target || dragged.id === target.id) return {};

    // Remove dragged from list, then insert relative to target
    const without = s.tasks.filter(t => t.id !== draggedId);
    const targetIdx = without.findIndex(t => t.id === targetId);
    if (targetIdx < 0) return {};
    const insertAt = position === 'after' ? targetIdx + 1 : targetIdx;
    const tasks = [...without.slice(0, insertAt), dragged, ...without.slice(insertAt)];
    saveTasks(tasks);
    return { tasks };
  }),

  /** Update arbitrary editable metadata fields. */
  editTask: (taskId, patch) => set(s => {
    // Only allow a safe subset of fields to be edited
    const allowed = ['title', 'description', 'priority', 'files'];
    const sanitized = {};
    for (const k of allowed) {
      if (k in patch) sanitized[k] = patch[k];
    }
    const tasks = s.tasks.map(t => t.id === taskId ? { ...t, ...sanitized } : t);
    saveTasks(tasks);
    return { tasks };
  }),

  /** Update live agent progress info for a task (called by agentStore). */
  updateAgentProgress: (taskId, progress) => set(s => {
    const tasks = s.tasks.map(t => t.id === taskId ? { ...t, agentProgress: progress } : t);
    // Don't persist progress — it's ephemeral per-session state
    return { tasks };
  }),

  // ─── Queries ───

  setFilter: (filter) => set({ filter }),

  getFilteredTasks: () => {
    const { tasks, filter } = get();
    // Only return top-level tasks (children render inside parents)
    const topLevel = tasks.filter(t => !t.parentId);
    if (filter === 'all') return topLevel;
    return topLevel.filter(t => t.status === filter);
  },

  getSubtasks: (parentId) => {
    return get().tasks.filter(t => t.parentId === parentId);
  },

  getTasksForFile: (filePath) => {
    return get().tasks.filter(t => t.files.includes(filePath));
  },

  getStats: () => {
    const tasks = get().tasks;
    return {
      total: tasks.length,
      todo: tasks.filter(t => t.status === 'todo').length,
      inProgress: tasks.filter(t => t.status === 'in_progress' || t.status === 'agent_working').length,
      needsReview: tasks.filter(t => t.status === 'needs_review').length,
      done: tasks.filter(t => t.status === 'done').length,
    };
  },
}));
