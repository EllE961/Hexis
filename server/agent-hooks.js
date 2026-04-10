/**
 * Agent hooks — SDK-level pre/post tool hooks and session hooks.
 *
 * The hooks layer is where we enforce invariants and inject context WITHOUT
 * relying on the agent reading a prompt. If the policy says "don't edit
 * tauri.conf.json", a PreToolUse hook hard-blocks the edit. If we want the
 * agent to see recent git history, a SessionStart hook injects it.
 *
 * Building blocks:
 *   - `buildHooks(opts)` returns an object shaped like the SDK's
 *     `hooks` option: `{ PreToolUse: [{matcher, hooks: [fn]}], ... }`.
 *   - `opts.diffTracker` collects cumulative file changes across the run so
 *     the reviewer can be handed the full diff.
 *   - `opts.protectedFiles` is a regex for files that must never be edited.
 *   - `opts.repoPath` is used to read git context for the SessionStart hook.
 */

import { exec as _exec } from 'child_process';
import { promisify } from 'util';
import { relative } from 'path';

const exec = promisify(_exec);

/**
 * Default protected files — never edit without explicit user consent.
 * Covers tauri config, lockfiles, secrets, and the `.claude/` directory.
 */
export const DEFAULT_PROTECTED = /(^|[/\\])(tauri\.conf\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.env(\.[^/\\]+)?|node_modules([/\\]|$)|\.git([/\\]|$))/i;

/**
 * Create a diff tracker that accumulates the set of edited files and their
 * tool-call history across a run. Shared across hooks + orchestrator so the
 * final reviewer can be handed the full changeset.
 */
export function createDiffTracker() {
  const edits = [];          // { tool, file, ts }
  const touchedFiles = new Set();
  return {
    record(tool, file) {
      if (!file) return;
      edits.push({ tool, file, ts: Date.now() });
      touchedFiles.add(file);
    },
    get edits() { return edits; },
    get touchedFiles() { return [...touchedFiles]; },
    get count() { return edits.length; },
    summary() {
      return {
        totalEdits: edits.length,
        filesTouched: touchedFiles.size,
        files: [...touchedFiles],
      };
    },
  };
}

/**
 * Build the hooks object for a run.
 *
 * @param {Object} opts
 * @param {string} opts.repoPath                  - working directory
 * @param {ReturnType<typeof createDiffTracker>} [opts.diffTracker] - diff accumulator
 * @param {RegExp} [opts.protectedFiles]          - regex of files to hard-block
 * @param {Function} [opts.broadcast]             - (event) => void, for UI updates
 * @param {string[]} [opts.focusFiles]            - files to include in SessionStart git log
 * @param {boolean} [opts.injectGitHistory]       - inject last 10 commits of focus files on SessionStart
 */
export function buildHooks(opts = {}) {
  const {
    repoPath,
    diffTracker,
    protectedFiles = DEFAULT_PROTECTED,
    broadcast,
    focusFiles = [],
    injectGitHistory = true,
  } = opts;

  // ─── PreToolUse — block protected files on any write/edit ───
  const preToolUseBlock = async (input) => {
    if (!input || typeof input !== 'object') return {};
    const tool = input.tool_name;
    const toolInput = input.tool_input || {};
    if (!['Write', 'Edit', 'NotebookEdit', 'MultiEdit'].includes(tool)) return {};
    const file = toolInput.file_path || toolInput.path || toolInput.notebook_path || '';
    if (file && protectedFiles.test(file)) {
      if (broadcast) {
        broadcast({
          type: 'agent_stream',
          text: `\n[⛔ blocked edit to protected file: ${file}]\n`,
        });
      }
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `Hexis protected-files policy: ${file} may not be modified. If the change is intentional, the user must edit this file manually.`,
        },
      };
    }
    return {};
  };

  // ─── PostToolUse — track every successful edit + broadcast ───
  const postToolUseTrack = async (input) => {
    if (!input || typeof input !== 'object') return {};
    const tool = input.tool_name;
    const toolInput = input.tool_input || {};
    if (!['Write', 'Edit', 'NotebookEdit', 'MultiEdit'].includes(tool)) return {};
    const file = toolInput.file_path || toolInput.path || toolInput.notebook_path || '';
    if (!file) return {};
    const rel = safeRelative(repoPath, file);
    if (diffTracker) diffTracker.record(tool.toLowerCase(), rel);
    if (broadcast) {
      broadcast({ type: 'agent_editing', file: rel, tool });
    }
    return { async: true };
  };

  // ─── SessionStart — inject git history for focus files ───
  const sessionStartGitContext = async () => {
    if (!injectGitHistory || focusFiles.length === 0) return {};
    try {
      const files = focusFiles.slice(0, 10);
      const chunks = [];
      for (const file of files) {
        try {
          const { stdout } = await exec(
            `git log --oneline -5 -- "${file}"`,
            { cwd: repoPath, timeout: 5000 }
          );
          if (stdout.trim()) {
            chunks.push(`## ${file}\n${stdout.trim()}`);
          }
        } catch { /* ignore per-file errors */ }
      }
      if (chunks.length === 0) return {};
      const context = `# Recent git history for focus files\n\n${chunks.join('\n\n')}`;
      return {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: context,
        },
      };
    } catch {
      return {};
    }
  };

  // ─── PostToolUseFailure — log failures to run log ───
  // (Stored by the orchestrator into the memory system.)
  const onFailureLog = async (input) => {
    if (!input || !broadcast) return {};
    const tool = input.tool_name || 'unknown';
    const err = input.tool_response?.error || input.error || 'unknown error';
    broadcast({
      type: 'agent_stream',
      text: `\n[tool failure: ${tool} — ${String(err).slice(0, 200)}]\n`,
    });
    return {};
  };

  return {
    PreToolUse: [
      { matcher: 'Write|Edit|NotebookEdit|MultiEdit', hooks: [preToolUseBlock] },
    ],
    PostToolUse: [
      { matcher: 'Write|Edit|NotebookEdit|MultiEdit', hooks: [postToolUseTrack] },
    ],
    PostToolUseFailure: [
      { hooks: [onFailureLog] },
    ],
    SessionStart: [
      { hooks: [sessionStartGitContext] },
    ],
  };
}

/** Make a path relative to the repo root, with forward slashes. */
function safeRelative(repoPath, filePath) {
  if (!filePath) return filePath;
  try {
    const rel = relative(repoPath, filePath).replace(/\\/g, '/');
    return rel.startsWith('..') ? filePath : rel;
  } catch {
    return filePath;
  }
}
