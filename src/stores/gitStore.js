/**
 * Git Store — manages git status, branches, and operations.
 * Reads from Tauri (git2-rs) or Express (simple-git) backend.
 */

import { create } from 'zustand';

const IS_TAURI = typeof window !== 'undefined' && window.__TAURI_INTERNALS__;

// Filter out irrelevant files
const IGNORE_PREFIXES = ['node_modules/', '.git/', 'dist/', 'target/', 'nebula/'];

function filterFiles(files) {
  return (files || []).filter(f => !IGNORE_PREFIXES.some(p => f.startsWith(p)) && !f.startsWith('.'));
}

export const useGitStore = create((set, get) => ({
  currentBranch: 'main',
  branches: [],
  modified: [],     // uncommitted changes (working tree)
  staged: [],       // staged for commit
  untracked: [],    // new files not in git
  deleted: [],
  conflicted: [],
  ahead: 0,
  behind: 0,
  loading: false,
  lastFetched: 0,

  // Get git status for a specific file path
  getFileStatus: (filePath) => {
    const { modified, staged, untracked, deleted, conflicted } = get();
    if (conflicted.includes(filePath)) return 'conflict';
    if (staged.includes(filePath)) return 'staged';
    if (modified.includes(filePath)) return 'modified';
    if (untracked.includes(filePath)) return 'untracked';
    if (deleted.includes(filePath)) return 'deleted';
    return 'clean';
  },

  // Fetch git status from backend
  fetchStatus: async () => {
    try {
      set({ loading: true });
      let data;

      if (IS_TAURI) {
        // TODO Phase 4b: Replace with Tauri git2-rs command
        // For now, use Express API
        const res = await fetch('/api/git/status');
        data = await res.json();
      } else {
        const res = await fetch('/api/git/status');
        data = await res.json();
      }

      set({
        currentBranch: data.current || 'main',
        modified: filterFiles(data.modified),
        staged: filterFiles(data.staged),
        untracked: filterFiles(data.not_added),
        deleted: filterFiles(data.deleted),
        conflicted: filterFiles(data.conflicted),
        ahead: data.ahead || 0,
        behind: data.behind || 0,
        loading: false,
        lastFetched: Date.now(),
      });
    } catch (err) {
      set({ loading: false });
    }
  },

  // Fetch branches
  fetchBranches: async () => {
    try {
      const res = await fetch('/api/branches');
      const data = await res.json();
      set({
        branches: data.branches || [],
        currentBranch: data.current || get().currentBranch,
      });
    } catch {}
  },

  // Stage files
  stageFiles: async (files) => {
    try {
      await fetch('/api/git/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files }),
      });
      await get().fetchStatus();
    } catch {}
  },

  // Unstage files
  unstageFiles: async (files) => {
    try {
      await fetch('/api/git/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files }),
      });
      await get().fetchStatus();
    } catch {}
  },

  // Commit
  commit: async (message) => {
    try {
      const res = await fetch('/api/git/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      const data = await res.json();
      await get().fetchStatus();
      return data;
    } catch (err) {
      return { error: err.message };
    }
  },

  // Push
  push: async () => {
    try {
      const res = await fetch('/api/git/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      await get().fetchStatus();
      return data;
    } catch (err) {
      return { error: err.message };
    }
  },

  // Pull
  pull: async () => {
    try {
      const res = await fetch('/api/git/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      await get().fetchStatus();
      return data;
    } catch (err) {
      return { error: err.message };
    }
  },

  // Create branch + switch
  createBranch: async (name) => {
    try {
      const res = await fetch('/api/git/branch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      await get().fetchStatus();
      await get().fetchBranches();
      return data;
    } catch (err) {
      return { error: err.message };
    }
  },

  // Switch branch
  checkoutBranch: async (branch) => {
    try {
      const res = await fetch('/api/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch }),
      });
      const data = await res.json();
      await get().fetchStatus();
      return data;
    } catch (err) {
      return { error: err.message };
    }
  },

  // Ship It — stage all, auto-commit, push
  shipIt: async (commitMessage) => {
    const { modified, untracked } = get();
    const allFiles = [...modified, ...untracked];
    if (allFiles.length === 0) return { error: 'Nothing to ship' };

    // Stage all
    await get().stageFiles(allFiles);

    // Commit
    const msg = commitMessage || `ship: ${allFiles.length} file${allFiles.length > 1 ? 's' : ''} updated`;
    const commitResult = await get().commit(msg);
    if (commitResult.error) return commitResult;

    // Push
    const pushResult = await get().push();
    return pushResult;
  },

  // ─── Stash Operations ───

  stashList: async () => {
    try {
      const res = await fetch('/api/git/stash');
      return await res.json();
    } catch (err) {
      return { error: err.message };
    }
  },

  stashPush: async (message) => {
    try {
      const res = await fetch('/api/git/stash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      const data = await res.json();
      await get().fetchStatus();
      return data;
    } catch (err) {
      return { error: err.message };
    }
  },

  stashPop: async (index = 0) => {
    try {
      const res = await fetch('/api/git/stash/pop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index }),
      });
      const data = await res.json();
      await get().fetchStatus();
      return data;
    } catch (err) {
      return { error: err.message };
    }
  },

  stashDrop: async (index = 0) => {
    try {
      const res = await fetch('/api/git/stash', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index }),
      });
      return await res.json();
    } catch (err) {
      return { error: err.message };
    }
  },

  // ─── Fetch Remote ───

  fetchRemote: async () => {
    try {
      const res = await fetch('/api/git/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      await get().fetchStatus();
      return data;
    } catch (err) {
      return { error: err.message };
    }
  },

  // ─── Amend Commit ───

  amendCommit: async (message) => {
    try {
      const res = await fetch('/api/git/amend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      const data = await res.json();
      await get().fetchStatus();
      return data;
    } catch (err) {
      return { error: err.message };
    }
  },

  // ─── Revert Commit ───

  revertCommit: async (hash) => {
    try {
      const res = await fetch('/api/git/revert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash }),
      });
      const data = await res.json();
      await get().fetchStatus();
      return data;
    } catch (err) {
      return { error: err.message };
    }
  },
}));
