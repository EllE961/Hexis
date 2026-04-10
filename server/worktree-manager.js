/**
 * Worktree manager — isolated git worktrees per agent run.
 *
 * Each run gets its own copy of the repo at .hexis/worktrees/run-{id}/.
 * The agent does its work there, isolated from the user's main checkout
 * and from other concurrent runs.
 *
 * On success: changes are merged back via cherry-pick or commit copy.
 * On failure/cancel: worktree is removed.
 *
 * Falls back to using the main repo path if git worktree isn't available
 * (not a git repo, or worktree command fails).
 */

import { exec as _exec } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync } from 'fs';
import { rm } from 'fs/promises';

const exec = promisify(_exec);

const WORKTREE_BASE = join(homedir(), '.hexis', 'worktrees');

// Ensure base directory exists
if (!existsSync(WORKTREE_BASE)) {
  try { mkdirSync(WORKTREE_BASE, { recursive: true }); } catch { /* ignore */ }
}

/**
 * Create a worktree for a run. Returns the path to use as cwd.
 * If anything fails, returns the original repoPath (caller still works, just no isolation).
 */
export async function createWorktree(runId, repoPath) {
  const safeId = runId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  const worktreePath = join(WORKTREE_BASE, safeId).replace(/\\/g, '/');

  // Clean up any leftover worktree at this path first
  try {
    await exec(`git worktree remove --force "${worktreePath}"`, { cwd: repoPath, timeout: 10000 });
  } catch { /* may not exist */ }
  try { await rm(worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }

  try {
    // Detached worktree from current HEAD — agent can commit freely
    await exec(`git worktree add --detach "${worktreePath}"`, {
      cwd: repoPath,
      timeout: 30000,
    });
    return { path: worktreePath, isolated: true };
  } catch (err) {
    console.warn(`[worktree] Failed to create for ${runId}: ${err.message}. Using main repo.`);
    return { path: repoPath, isolated: false };
  }
}

/**
 * Remove a worktree after the run is done.
 * Caller decides whether to merge changes back first (separate function).
 */
export async function destroyWorktree(runId, repoPath) {
  const safeId = runId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  const worktreePath = join(WORKTREE_BASE, safeId).replace(/\\/g, '/');

  try {
    await exec(`git worktree remove --force "${worktreePath}"`, {
      cwd: repoPath,
      timeout: 15000,
    });
  } catch (err) {
    // Force remove the directory if git worktree command fails
    try { await rm(worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Get a diff of all changes made in a worktree (vs the original HEAD).
 * Stages everything first so untracked files are included in the patch.
 * Returns the patch text — used for previewing or applying back to main.
 */
export async function getWorktreeDiff(worktreePath) {
  try {
    // Stage all changes (modifications, additions, deletions) so they all appear in diff
    await exec('git add -A', { cwd: worktreePath, timeout: 10000 });
    // --cached HEAD shows the staged tree vs HEAD — includes new files
    const { stdout } = await exec('git diff --cached HEAD', {
      cwd: worktreePath,
      timeout: 10000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return '';
  }
}

/**
 * Apply a worktree's changes back to the main repo as a patch.
 * Uses git apply with 3-way merge (--3way) so it can detect conflicts cleanly.
 * Returns { applied: true } on success, or { applied: false, conflict: true, diff } on conflict.
 */
export async function applyWorktreeChanges(worktreePath, mainRepoPath) {
  try {
    const diff = await getWorktreeDiff(worktreePath);
    if (!diff.trim()) return { applied: true, empty: true };

    const { spawn } = await import('child_process');

    // Try 3-way merge first — fails cleanly on conflicts
    const result = await new Promise((resolve) => {
      let stderr = '';
      const proc = spawn('git', ['apply', '--3way', '--whitespace=nowarn', '-'], {
        cwd: mainRepoPath,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.stdin.write(diff);
      proc.stdin.end();
      proc.on('close', (code) => resolve({ code, stderr }));
      proc.on('error', (err) => resolve({ code: 1, stderr: err.message }));
    });

    if (result.code === 0) {
      return { applied: true };
    }

    // 3-way failed — likely a conflict. Save the patch for the user to apply manually.
    return {
      applied: false,
      conflict: true,
      diff,
      error: result.stderr,
    };
  } catch (err) {
    return { applied: false, conflict: false, error: err.message };
  }
}
