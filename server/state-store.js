/**
 * Server-side state store with disk persistence and crash recovery.
 *
 * Persists tasks, runs, and a journal of events to ~/.hexis/state-{repoHash}.json
 * Auto-saves after every mutation (debounced).
 *
 * On startup:
 *   - Loads previous state from disk
 *   - Resets any orphaned `running`/`agent_working` runs to `interrupted`
 *     so the user can see what was lost and decide to retry
 *
 * The frontend syncs with this via /api/state endpoints — it's the source of truth.
 * localStorage on the browser becomes a cache only.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';

// Where state lives on disk
function getStateDir() {
  const dir = join(homedir(), '.hexis');
  if (!existsSync(dir)) {
    try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  }
  return dir;
}

function getStatePath(repoPath) {
  const hash = createHash('sha1').update(repoPath).digest('hex').slice(0, 12);
  return join(getStateDir(), `state-${hash}.json`);
}

const EMPTY_STATE = {
  version: 1,
  tasks: [],            // full task list
  runs: {},             // runId → run state
  taskHistory: [],      // completed runs (last 100)
  updatedAt: 0,
};

class StateStore {
  constructor(repoPath) {
    this.repoPath = repoPath;
    this.statePath = getStatePath(repoPath);
    this.state = { ...EMPTY_STATE };
    this._saveTimer = null;
    this._listeners = new Set();
  }

  // ─── Persistence ───

  async load() {
    try {
      const raw = await readFile(this.statePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1) {
        this.state = {
          ...EMPTY_STATE,
          ...parsed,
          tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
          runs: parsed.runs || {},
          taskHistory: Array.isArray(parsed.taskHistory) ? parsed.taskHistory : [],
        };
        // Reset orphaned runs (they were running when the server crashed)
        this._recoverOrphanedRuns();
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn('[state-store] Failed to load state:', err.message);
      }
      this.state = { ...EMPTY_STATE };
    }
    return this.state;
  }

  _recoverOrphanedRuns() {
    let recovered = 0;
    for (const [runId, run] of Object.entries(this.state.runs)) {
      if (['planning', 'executing', 'reviewing'].includes(run.status)) {
        run.status = 'interrupted';
        run.interruptedAt = Date.now();
        run.interruptReason = 'Server restarted while this run was active';
        recovered++;

        // If a board task was linked, reset it to todo so it can be retried
        if (run.linkedTaskId) {
          const task = this.state.tasks.find(t => t.id === run.linkedTaskId);
          if (task && task.status === 'agent_working') {
            task.status = 'todo';
            task.agentTaskId = null;
          }
        }
      }
    }
    if (recovered > 0) {
      console.log(`[state-store] Recovered ${recovered} orphaned run(s) on startup`);
    }
  }

  // Debounced disk write — coalesce rapid mutations
  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(async () => {
      this._saveTimer = null;
      this.state.updatedAt = Date.now();
      try {
        await writeFile(this.statePath, JSON.stringify(this.state, null, 2), 'utf-8');
      } catch (err) {
        console.warn('[state-store] Failed to save state:', err.message);
      }
    }, 250);
  }

  // ─── Subscribe to changes (for SSE broadcasts) ───
  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _notify(event) {
    for (const fn of this._listeners) {
      try { fn(event); } catch (err) { console.warn(err); }
    }
  }

  // ─── Tasks ───

  getTasks() { return this.state.tasks; }
  getTask(id) { return this.state.tasks.find(t => t.id === id) || null; }

  addTask(task) {
    // Insert at front
    this.state.tasks = [task, ...this.state.tasks];
    this._scheduleSave();
    this._notify({ type: 'task_added', task });
    return task;
  }

  updateTask(id, patch) {
    let updated = null;
    this.state.tasks = this.state.tasks.map(t => {
      if (t.id !== id) return t;
      updated = { ...t, ...patch };
      return updated;
    });
    if (updated) {
      this._scheduleSave();
      this._notify({ type: 'task_updated', task: updated });
    }
    return updated;
  }

  deleteTask(id) {
    const before = this.state.tasks.length;
    // Also delete children
    this.state.tasks = this.state.tasks.filter(t => t.id !== id && t.parentId !== id);
    if (this.state.tasks.length !== before) {
      this._scheduleSave();
      this._notify({ type: 'task_deleted', id });
    }
  }

  // ─── Runs ───

  getRun(id) { return this.state.runs[id] || null; }
  getRuns() { return Object.values(this.state.runs); }

  createRun(run) {
    this.state.runs[run.id] = { ...run, events: [], journaledAt: Date.now() };
    this._scheduleSave();
    return this.state.runs[run.id];
  }

  updateRun(id, patch) {
    const existing = this.state.runs[id];
    if (!existing) return null;
    const updated = { ...existing, ...patch };
    this.state.runs[id] = updated;

    // If terminal, archive to history
    if (['done', 'error', 'cancelled', 'interrupted'].includes(updated.status)) {
      this.state.taskHistory = [updated, ...this.state.taskHistory].slice(0, 100);
    }

    this._scheduleSave();
    return updated;
  }

  /** Append an event to the run's journal — used for replay/debug. */
  journalEvent(runId, event) {
    const run = this.state.runs[runId];
    if (!run) return;
    if (!run.events) run.events = [];
    // Cap journal size — keep last 500 events per run
    run.events.push({ ...event, t: Date.now() });
    if (run.events.length > 500) run.events.splice(0, run.events.length - 500);
    this._scheduleSave();
  }

  removeRun(id) {
    const existing = this.state.runs[id];
    if (existing) {
      delete this.state.runs[id];
      this._scheduleSave();
    }
  }

  // ─── Snapshot for new SSE clients ───
  getSnapshot() {
    return {
      tasks: this.state.tasks,
      runs: this.state.runs,
      taskHistory: this.state.taskHistory.slice(0, 20),
    };
  }

  /** Wipe all state — for debugging. */
  reset() {
    this.state = { ...EMPTY_STATE };
    this._scheduleSave();
  }
}

let _instance = null;

export function initStateStore(repoPath) {
  _instance = new StateStore(repoPath);
  return _instance;
}

export function getStateStore() {
  if (!_instance) throw new Error('State store not initialized — call initStateStore first');
  return _instance;
}
