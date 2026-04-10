/**
 * Agent Store — tracks AI agent state, tasks, and activity.
 *
 * Supports MULTIPLE concurrent runs — each run is tracked in `runs: Map<runId, RunState>`.
 * `activeTask` is the "focused" run for UI compatibility (most recent).
 * `agents` is a flat array of ALL agents across ALL runs.
 * `cellActivity` is a flat map — each entry has its own agentId, so concurrent agents
 *   on different files coexist naturally.
 *
 * SSE events from the server carry `runId` so we route them to the right run.
 * Agent IDs are prefixed with runId (e.g. `agent-abc::planner`) to avoid collisions.
 */

import { create } from 'zustand';
import { useTaskStore } from './taskStore.js';

export const AGENT_ROLES = {
  writer:     { name: 'Scribe',    color: '#F0A030', icon: '✎' },
  planner:    { name: 'Foreman',   color: '#F59E0B', icon: '📋' },
  coder:      { name: 'Artisan',   color: '#14B8A6', icon: '🔧' },
  tester:     { name: 'Inspector', color: '#A855F7', icon: '🔍' },
  reviewer:   { name: 'Critic',    color: '#3B82F6', icon: '🧐' },
  documenter: { name: 'Docwriter', color: '#EC4899', icon: '📖' },
};

// Max parallel task runs (Writer is separate and can always run)
const MAX_PARALLEL_RUNS = 3;

// ─── History persistence ───

const HISTORY_KEY = 'hexis-agent-history';

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveHistory(history) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 50)));
  } catch { /* ignore */ }
}

// Helper: extract role from prefixed agent ID like "agent-abc::planner"
function roleFromAgentId(agentId) {
  if (!agentId) return 'coder';
  const m = agentId.match(/::(planner|coder|reviewer|tester|documenter|writer)/);
  return m ? m[1] : (agentId.includes('writer') ? 'writer' : 'coder');
}

// Helper: create an empty run state
function makeRun(id, prompt, linkedTaskId = null, claimedFiles = []) {
  return {
    id,
    prompt,
    status: 'planning',
    plan: null,
    subtasks: [],
    startedAt: Date.now(),
    tokensUsed: 0,
    cost: 0,
    linkedTaskId,
    review: null,
    error: null,
    claimedFiles: new Set(claimedFiles),  // files this run is working on
  };
}

// Priority ranking for task ordering (higher = run first)
const PRIORITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };

// Check if two file sets overlap
function filesOverlap(a, b) {
  for (const f of a) if (b.has(f)) return true;
  return false;
}

// Normalize a file path for consistent comparison
function normalizeFile(f) {
  return (f || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

// ─── Store ───

export const useAgentStore = create((set, get) => ({
  panelOpen: false,
  runs: new Map(),          // runId → RunState (all concurrent runs)
  activeTask: null,         // focused run for UI compat (latest run)
  agents: [],               // flat list of all agents across all runs
  taskHistory: loadHistory(),
  cellActivity: new Map(),
  streamOutput: '',
  pendingPlan: null,

  // ─── Panel ───
  togglePanel: () => set(s => ({ panelOpen: !s.panelOpen })),
  openPanel: () => set({ panelOpen: true }),
  closePanel: () => set({ panelOpen: false }),

  // ─── Submit raw input to Task Writer, which refines and queues it ───
  submitToWriter: async (rawPrompt) => {
    try {
      const res = await fetch('/api/task/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: rawPrompt }),
      });
      const data = await res.json();
      if (data.error) {
        console.error('Task writer failed:', data.error);
        return null;
      }
      return data.task;
    } catch (err) {
      console.error('Task writer request failed:', err);
      return null;
    }
  },

  // ─── Pick next queued task(s) with deps + conflict detection + priority ordering ───
  pickNextQueuedTask: async () => {
    const taskStore = useTaskStore.getState();
    const runs = get().runs;

    // Collect files currently claimed by all active runs
    const globalClaimed = new Set();
    let activeCount = 0;
    for (const r of runs.values()) {
      if (!['done', 'error', 'cancelled', 'paused'].includes(r.status)) {
        activeCount++;
        for (const f of (r.claimedFiles || [])) globalClaimed.add(normalizeFile(f));
      }
    }

    const slots = MAX_PARALLEL_RUNS - activeCount;
    if (slots <= 0) return;

    // First, unblock any tasks whose deps are now satisfied
    taskStore.cascadeUnblock();
    const refreshedTaskStore = useTaskStore.getState();

    // Queue candidates — every top-level todo task (manual or agent_queued)
    // gets auto-picked when dependencies are satisfied. Tasks marked
    // `autoRun: false` are skipped (user can opt-out per task).
    const candidates = refreshedTaskStore.tasks.filter(t => {
      if (t.parentId) return false;
      if (t.status !== 'todo') return false;
      if (t.autoRun === false) return false;  // explicit opt-out
      const { ready } = refreshedTaskStore.getDependencyStatus(t.id);
      return ready;
    });

    // Sort by priority (desc), then by createdAt (asc = FIFO)
    candidates.sort((a, b) => {
      const pa = PRIORITY_RANK[a.priority] || 2;
      const pb = PRIORITY_RANK[b.priority] || 2;
      if (pb !== pa) return pb - pa;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });

    // Pick tasks that don't conflict with running tasks OR each other
    const scheduled = [];
    const willClaim = new Set(globalClaimed);
    for (const task of candidates) {
      if (scheduled.length >= slots) break;
      const taskFiles = new Set((task.files || []).map(normalizeFile));

      if (taskFiles.size === 0) {
        scheduled.push(task);
        continue;
      }

      if (!filesOverlap(taskFiles, willClaim)) {
        scheduled.push(task);
        for (const f of taskFiles) willClaim.add(f);
      }
    }

    for (const next of scheduled) {
      await get().submitTaskFromBoard(next);
    }
  },

  // ─── Submit task (freeform prompt from AIPanel) ───
  submitTask: async (prompt) => {
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const run = makeRun(taskId, prompt, null);

    set(s => {
      const runs = new Map(s.runs);
      runs.set(taskId, run);
      return {
        runs,
        activeTask: run,
        streamOutput: '',
        pendingPlan: null,
      };
    });

    try {
      const res = await fetch('/api/agent/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, prompt }),
      });
      const data = await res.json();
      if (data.error) {
        get()._updateRun(taskId, { status: 'error', error: data.error });
      }
    } catch (err) {
      get()._updateRun(taskId, { status: 'error', error: err.message });
    }
  },

  // ─── Deep Research: "Best Option Guarantee" pipeline ───
  // Dispatches a multi-phase research run: plan → parallel workers → rank →
  // adversarial critic → synthesis → optional task extraction. Events come
  // back via the same SSE stream (research_started, research_plan_ready,
  // research_gather_complete, research_ranking_complete,
  // research_critique_complete, research_report_ready, research_tasks_ready,
  // research_complete).
  submitResearchTask: async (query, { createTasks = false, focusArea = '', workerCount = 3 } = {}) => {
    const taskId = `research-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const run = makeRun(taskId, `[research] ${query}`, null);
    run.kind = 'research';

    set(s => {
      const runs = new Map(s.runs);
      runs.set(taskId, run);
      return {
        runs,
        activeTask: run,
        streamOutput: '',
        pendingPlan: null,
      };
    });

    try {
      const res = await fetch('/api/research/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, query, createTasks, focusArea, workerCount }),
      });
      const data = await res.json();
      if (data.error) {
        get()._updateRun(taskId, { status: 'error', error: data.error });
      }
    } catch (err) {
      get()._updateRun(taskId, { status: 'error', error: err.message });
    }
  },

  // ─── Submit task from TaskBoard (linked to a board task) ───
  submitTaskFromBoard: async (boardTask) => {
    const taskId = `agent-${boardTask.id}-${Math.random().toString(36).slice(2, 6)}`;
    const taskStore = useTaskStore.getState();

    // ─── Memory carryover: gather context from completed dependencies ───
    let priorContext = '';
    if (boardTask.dependsOn?.length) {
      const priorSummaries = [];
      const allTasks = taskStore.tasks;
      const allHistory = get().taskHistory;
      for (const depId of boardTask.dependsOn) {
        const depTask = allTasks.find(t => t.id === depId);
        if (!depTask) continue;
        // Find the run history record for this dep
        const depRun = allHistory.find(h => h.linkedTaskId === depId);
        const summary = [`### ${depTask.title}`];
        if (depTask.description) summary.push(`Description: ${depTask.description}`);
        if (depTask.agentPlan) summary.push(`Plan: ${depTask.agentPlan}`);
        if (depRun?.review?.summary) summary.push(`Review: ${depRun.review.summary}`);
        if (depTask.files?.length) summary.push(`Files: ${depTask.files.join(', ')}`);
        priorSummaries.push(summary.join('\n'));
      }
      if (priorSummaries.length) {
        priorContext = `\n\n## Prior tasks in this chain (already completed)\n\n${priorSummaries.join('\n\n---\n\n')}\n\n## Your task (continuing from above)\n\n`;
      }
    }

    const prompt = priorContext + (boardTask.description
      ? `${boardTask.title}\n\n${boardTask.description}`
      : boardTask.title);

    taskStore.assignToAgent(boardTask.id, taskId);

    const claimedFiles = (boardTask.files || []).map(normalizeFile);
    const run = makeRun(taskId, prompt, boardTask.id, claimedFiles);

    set(s => {
      const runs = new Map(s.runs);
      runs.set(taskId, run);
      return { runs, activeTask: run, streamOutput: '', pendingPlan: null };
    });

    try {
      const res = await fetch('/api/agent/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, prompt, files: boardTask.files }),
      });
      const data = await res.json();
      if (data.error) {
        get()._updateRun(taskId, { status: 'error', error: data.error });
        taskStore.onAgentError(boardTask.id, data.error);
        taskStore.cascadeFailure(boardTask.id, data.error);
      }
    } catch (err) {
      get()._updateRun(taskId, { status: 'error', error: err.message });
      taskStore.onAgentError(boardTask.id, err.message);
      taskStore.cascadeFailure(boardTask.id, err.message);
    }
  },

  // ─── Pause a running task (saves session, can resume later) ───
  pauseTask: async (runId) => {
    const targetId = runId || get().activeTask?.id;
    if (!targetId) return;
    const run = get().runs.get(targetId);
    if (!run) return;

    try {
      await fetch('/api/agent/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: targetId }),
      });
    } catch {}

    get()._updateRun(targetId, { status: 'paused', pausedAt: Date.now() });
    if (run.linkedTaskId) {
      useTaskStore.getState().markPaused(run.linkedTaskId, targetId);
    }
  },

  // ─── Resume a paused task with optional additional instructions ───
  resumeTask: async (runId, additionalInstructions = '') => {
    const run = get().runs.get(runId);
    if (!run || run.status !== 'paused') return;

    const newPrompt = additionalInstructions
      ? `Continue from where you left off. Additional instructions:\n\n${additionalInstructions}`
      : 'Continue from where you left off.';

    get()._updateRun(runId, { status: 'planning' });

    try {
      await fetch('/api/agent/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: runId, prompt: newPrompt }),
      });
    } catch (err) {
      get()._updateRun(runId, { status: 'error', error: err.message });
    }
  },

  // ─── Cancel a specific run (or the active one) ───
  cancelTask: async (runId) => {
    const targetId = runId || get().activeTask?.id;
    if (!targetId) return;
    const run = get().runs.get(targetId);
    if (!run) return;

    try {
      await fetch('/api/agent/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: targetId }),
      });
    } catch { /* ignore */ }

    if (run.linkedTaskId) {
      useTaskStore.getState().onAgentError(run.linkedTaskId, 'Cancelled by user');
    }

    // Remove any cellActivity for this run's agents
    set(s => {
      const cellActivity = new Map(s.cellActivity);
      for (const [fp, act] of cellActivity) {
        if (act.agentId?.startsWith(`${targetId}::`)) cellActivity.delete(fp);
      }
      return { cellActivity };
    });

    get()._updateRun(targetId, { status: 'cancelled' });
  },

  // ─── Internal: update a specific run's state ───
  _updateRun: (runId, patch) => {
    let transitionedToTerminal = false;
    set(s => {
      const runs = new Map(s.runs);
      const existing = runs.get(runId);
      if (!existing) return {};
      const wasTerminal = ['done', 'error', 'cancelled'].includes(existing.status);
      const updated = { ...existing, ...patch };
      const isTerminal = ['done', 'error', 'cancelled'].includes(updated.status);
      if (!wasTerminal && isTerminal) transitionedToTerminal = true;
      runs.set(runId, updated);
      const activeTask = s.activeTask?.id === runId ? updated : s.activeTask;
      return { runs, activeTask };
    });
    // When a run finishes (any terminal state), check if waiting tasks can now be picked up
    if (transitionedToTerminal) {
      setTimeout(() => get().pickNextQueuedTask(), 200);
    }
  },

  // ─── Focus a different run (e.g. when clicking a bee) ───
  focusRun: (runId) => set(s => {
    const run = s.runs.get(runId);
    if (run) return { activeTask: run };
    return {};
  }),

  // ─── SSE event handlers ───

  onAgentEvent: (event) => {
    const { type, runId } = event;
    const taskStore = useTaskStore.getState();

    // Task Writer events don't have a run context — handle separately
    if (type === 'task_written') {
      const refined = event.task;
      if (!refined) return;
      taskStore.addTask(
        refined.title || 'Untitled',
        refined.description || '',
        refined.files || [],
        refined.priority || 'medium',
        { source: 'agent_queued' },
      );
      setTimeout(() => get().pickNextQueuedTask(), 100);
      return;
    }

    // Writer agent lifecycle events — no runId on writer, show as general agents
    if (type === 'agent_spawned' && event.role === 'writer') {
      set(s => ({
        agents: [...s.agents, {
          id: event.agentId,
          role: 'writer',
          model: event.model,
          status: 'running',
          currentFile: null,
          tokensUsed: 0,
          output: '',
        }],
      }));
      return;
    }
    if (type === 'agent_complete' && event.agentId?.startsWith('writer-')) {
      set(s => ({
        agents: s.agents.map(a =>
          a.id === event.agentId
            ? { ...a, status: 'done', tokensUsed: event.tokensUsed, output: event.summary }
            : a
        ),
      }));
      return;
    }
    if (type === 'agent_error' && event.agentId?.startsWith('writer-')) {
      set(s => ({
        agents: s.agents.map(a =>
          a.id === event.agentId ? { ...a, status: 'error', output: event.error } : a
        ),
      }));
      return;
    }

    // All other events must have a runId
    if (!runId) return;
    const run = get().runs.get(runId);
    if (!run) return;

    // ─── Research pipeline events ───
    if (type === 'research_started') {
      get()._updateRun(runId, { status: 'researching', researchQuery: event.query });
      return;
    }
    if (type === 'research_plan_ready') {
      get()._updateRun(runId, {
        researchPlan: event.summary,
        researchSubQuestions: event.subQuestions,
        researchRubric: event.rubric,
      });
      return;
    }
    if (type === 'research_gather_complete') {
      get()._updateRun(runId, {
        researchFindingsCount: event.findingsCount,
        researchUniqueSources: event.uniqueSources,
        researchCandidateCount: event.candidateCount,
      });
      return;
    }
    if (type === 'research_ranking_complete') {
      get()._updateRun(runId, { researchInterimShortlist: event.shortlist });
      return;
    }
    if (type === 'research_critique_complete') {
      get()._updateRun(runId, { researchCritique: event.critique });
      return;
    }
    if (type === 'research_report_ready') {
      get()._updateRun(runId, {
        researchReport: {
          slug: event.slug,
          verdict: event.verdict,
          shortlist: event.shortlist,
          crossVerification: event.crossVerification,
          openQuestions: event.openQuestions,
          nextSteps: event.nextSteps,
          referencesCount: event.referencesCount,
          fullMarkdown: event.fullMarkdown,
        },
      });
      return;
    }
    if (type === 'research_tasks_ready') {
      // Spawn task board entries from the research next steps
      for (const ns of (event.tasks || [])) {
        taskStore.addTask(
          ns.title || 'From research',
          ns.description || '',
          [],
          ns.priority || 'medium',
          { source: 'research', researchSlug: event.researchSlug },
        );
      }
      return;
    }
    if (type === 'research_complete') {
      get()._updateRun(runId, {
        status: 'done',
        researchComplete: true,
        verdict: event.verdict,
        tokensUsed: event.tokensUsed,
        cost: event.cost,
      });
      return;
    }

    const handlers = {
      'plan_ready': () => {
        // Expand claimed files with whatever the planner discovered
        const newClaimed = new Set(run.claimedFiles || []);
        for (const st of (event.subtasks || [])) {
          for (const f of (st.files || [])) newClaimed.add(normalizeFile(f));
        }

        const patch = {
          status: event.awaitingApproval ? 'awaiting_approval' : 'executing',
          plan: event.plan,
          subtasks: event.subtasks,
          claimedFiles: newClaimed,
        };
        get()._updateRun(runId, patch);

        if (run.linkedTaskId) {
          taskStore.updateTask(run.linkedTaskId, { agentPlan: event.plan });
          if (!event.awaitingApproval) {
            taskStore.createSubtasksFromPlan(
              run.linkedTaskId,
              event.subtasks,
              runId,
            );
          }
        }

        // A newly-expanded claim might unblock other queued tasks on different files
        // (conflict check will re-run on next task_complete, so no immediate action needed)
      },

      'agent_spawned': () => set(s => ({
        agents: [...s.agents, {
          id: event.agentId,
          runId,
          role: event.role,
          model: event.model,
          status: 'running',
          currentFile: null,
          subtaskId: event.subtaskId,
          tokensUsed: 0,
          output: '',
        }],
      })),

      'agent_reading': () => {
        const activity = new Map(get().cellActivity);
        for (const [fp, act] of activity) {
          if (act.agentId === event.agentId) activity.delete(fp);
        }
        activity.set(event.file, { agentId: event.agentId, runId, action: 'reading', since: Date.now() });
        set(s => ({
          cellActivity: activity,
          agents: s.agents.map(a => a.id === event.agentId ? { ...a, currentFile: event.file, status: 'reading' } : a),
        }));
        // Sync to linked board task so the card shows live progress
        if (run.linkedTaskId) {
          const role = roleFromAgentId(event.agentId);
          taskStore.updateAgentProgress(run.linkedTaskId, {
            phase: 'reading',
            currentFile: event.file,
            agentRole: role,
            updatedAt: Date.now(),
          });
        }
      },

      'agent_editing': () => {
        const activity = new Map(get().cellActivity);
        for (const [fp, act] of activity) {
          if (act.agentId === event.agentId) activity.delete(fp);
        }
        activity.set(event.file, { agentId: event.agentId, runId, action: 'editing', since: Date.now() });
        set(s => ({
          cellActivity: activity,
          agents: s.agents.map(a => a.id === event.agentId ? { ...a, currentFile: event.file, status: 'editing' } : a),
        }));
        if (run.linkedTaskId) {
          const role = roleFromAgentId(event.agentId);
          taskStore.updateAgentProgress(run.linkedTaskId, {
            phase: 'editing',
            currentFile: event.file,
            agentRole: role,
            updatedAt: Date.now(),
          });
        }
      },

      'agent_done_file': () => {
        const activity = new Map(get().cellActivity);
        activity.delete(event.file);
        set({ cellActivity: activity });
      },

      'agent_stream': () => {
        // Only update streamOutput if this is the focused run
        if (get().activeTask?.id === runId) {
          set(s => ({ streamOutput: s.streamOutput + event.text }));
        }
      },

      'agent_complete': () => {
        const activity = new Map(get().cellActivity);
        for (const [fp, act] of activity) {
          if (act.agentId === event.agentId) activity.delete(fp);
        }
        set(s => ({
          cellActivity: activity,
          agents: s.agents.map(a => a.id === event.agentId
            ? { ...a, status: 'done', currentFile: null, tokensUsed: event.tokensUsed, output: event.summary }
            : a
          ),
        }));
      },

      'agent_error': () => {
        set(s => ({
          agents: s.agents.map(a => a.id === event.agentId
            ? { ...a, status: 'error', output: event.error }
            : a
          ),
        }));
        if (event.agentId?.endsWith('::orchestrator')) {
          if (run.linkedTaskId) {
            taskStore.onAgentError(run.linkedTaskId, event.error);
            // Cascade: any tasks depending on this one get blocked with reason
            taskStore.cascadeFailure(run.linkedTaskId, event.error);
          }
          get()._updateRun(runId, { status: 'error', error: event.error });
        }
      },

      'subtask_complete': () => {
        get()._updateRun(runId, {
          subtasks: run.subtasks.map(st =>
            st.id === event.subtaskId ? { ...st, status: 'done' } : st
          ),
        });
        if (run.linkedTaskId) {
          const child = taskStore.tasks.find(t =>
            t.parentId === run.linkedTaskId && t.agentSubtaskId === event.subtaskId
          );
          if (child) taskStore.completeTask(child.id);
        }
      },

      'task_complete': () => {
        const finalRun = { ...run, status: 'done', tokensUsed: event.tokensUsed, cost: event.cost, completedAt: Date.now() };
        const history = [...get().taskHistory, finalRun];
        saveHistory(history);

        set(s => {
          const cellActivity = new Map(s.cellActivity);
          for (const [fp, act] of cellActivity) {
            if (act.runId === runId) cellActivity.delete(fp);
          }
          return { cellActivity, taskHistory: history };
        });

        get()._updateRun(runId, { status: 'done', tokensUsed: event.tokensUsed, cost: event.cost });

        if (run.linkedTaskId) {
          taskStore.onAgentComplete(run.linkedTaskId, run.review);
          taskStore.updateAgentProgress(run.linkedTaskId, null);  // clear live progress
          // Unblock any tasks that were waiting on this one
          taskStore.cascadeUnblock();
        }

        setTimeout(() => get().pickNextQueuedTask(), 500);
      },

      'task_review': () => {
        get()._updateRun(runId, { status: 'reviewing', review: event.review });
        if (run.linkedTaskId) {
          taskStore.updateTask(run.linkedTaskId, { review: event.review });
        }
      },

      'tokens_update': () => {
        get()._updateRun(runId, {
          tokensUsed: event.total,
          cost: event.cost,
          cacheHits: event.cacheHits,
        });
      },

      // ─── Worktree lifecycle (opt-in isolation) ───
      'worktree_created': () => {
        get()._updateRun(runId, { worktreePath: event.path, isolated: true });
      },
      'worktree_merged': () => {
        get()._updateRun(runId, { worktreeMerged: true });
      },
      'worktree_merge_conflict': () => {
        get()._updateRun(runId, {
          worktreeMerged: false,
          mergeConflict: true,
          mergeError: event.error,
          mergeDiff: event.diff,
        });
      },
      'worktree_merge_failed': () => {
        get()._updateRun(runId, { worktreeMerged: false, mergeError: event.error });
      },
    };

    if (handlers[type]) handlers[type]();
  },

  // ─── Getters ───
  getFilesBeingRead: () => {
    const files = [];
    for (const [path, activity] of get().cellActivity) {
      if (activity.action === 'reading') files.push(path);
    }
    return files;
  },

  getFilesBeingEdited: () => {
    const files = [];
    for (const [path, activity] of get().cellActivity) {
      if (activity.action === 'editing') files.push(path);
    }
    return files;
  },

  getCellAgentState: (filePath) => {
    return get().cellActivity.get(filePath) || null;
  },

  /** Get all runs (active or done) linked to a board task. */
  getRunsForTask: (taskId) => {
    const result = [];
    for (const r of get().runs.values()) {
      if (r.linkedTaskId === taskId) result.push(r);
    }
    return result;
  },

  /** Get all agents (across all runs) currently working on a board task. */
  getAgentsForTask: (taskId) => {
    const runIds = new Set();
    for (const r of get().runs.values()) {
      if (r.linkedTaskId === taskId) runIds.add(r.id);
    }
    return get().agents.filter(a => runIds.has(a.runId));
  },
}));
