import express from 'express';
import { resolve, dirname, relative, isAbsolute, sep } from 'path';
import { fileURLToPath } from 'url';
import { writeFile, access, readFile } from 'fs/promises';
import { execSync, exec, spawn } from 'child_process';
import { buildGraph } from './graph-builder.js';
import { updateMarkdownLinks } from './link-updater.js';
import {
  initGit, getGit, getCurrentBranch, getBranches, getCommitHistory,
  getBranchDiff, getFileDiff, getWorkingDiff, getStatus,
  stageFiles, unstageFiles, commitChanges, pushChanges, pullChanges,
  createBranch, checkoutBranch, mergeBranch, deleteBranch, moveFile,
  stashList, stashPush, stashPop, stashDrop,
  getBlame, getCommitDetail,
  amendCommit, revertCommit, resetTo, fetchRemote,
} from './git-analyzer.js';
import { startWatcher } from './watcher.js';
import { startTask, cancelTask, approveTask, writeTask, resumeTaskFn, researchTask, chatMessage, cancelChat, disposeChat, warmupSdk } from './agent-orchestrator.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { initStateStore, getStateStore } from './state-store.js';
import { initRepoContext } from './repo-context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Target path: CLI arg > env var > parent of this server dir
const REPO_PATH = (process.argv[2] || process.env.HEXIS_TARGET || resolve(__dirname, '..')).replace(/\\/g, '/');
const PORT = parseInt(process.env.HEXIS_PORT || '3001', 10);
const HOST = process.env.HEXIS_HOST || '127.0.0.1';

// This API runs shell commands, writes files and drives git, so it only answers the Hexis UI on
// this machine. The Host check blocks DNS rebinding; the Origin and Sec-Fetch-Site checks block
// other websites open in the same browser from calling it.
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const ALLOWED_ORIGINS = new Set(
  (process.env.HEXIS_ALLOWED_ORIGINS
    || 'http://localhost:5173,http://127.0.0.1:5173,tauri://localhost,http://tauri.localhost,https://tauri.localhost')
    .split(',').map(o => o.trim()).filter(Boolean),
);

const app = express();
app.use((req, res, next) => {
  const hostname = (req.headers.host || '').replace(/:\d+$/, '');
  if (!LOCAL_HOSTNAMES.has(hostname)) return res.status(403).json({ error: 'Forbidden host' });
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return res.status(403).json({ error: 'Forbidden origin' });
  if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'Forbidden' });
  next();
});
app.use(express.json({ limit: '5mb' }));

initGit(REPO_PATH);

// Initialize persistent state store
const stateStore = initStateStore(REPO_PATH);
await stateStore.load();
console.log(`  ✦ State loaded: ${stateStore.getTasks().length} tasks, ${stateStore.getRuns().length} runs`);

// Initialize repo context (AGENTS.md, repo wiki, cached preamble for agents)
await initRepoContext(REPO_PATH);

// Fire-and-forget SDK warmup — kills first-turn cold start on chat mode.
// Runs in the background, doesn't block listen(). See agent-orchestrator.warmupSdk.
warmupSdk(REPO_PATH).catch(() => {});

// SSE clients
const sseClients = new Set();
function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) client.write(msg);
}

function isPathSafe(filePath) {
  // relative() rather than a prefix check, so a sibling like `../Hexis-other` can't pass
  const rel = relative(resolve(REPO_PATH), resolve(REPO_PATH, filePath));
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
}

// ─── Graph ───

app.get('/api/graph', async (req, res) => {
  try {
    const graph = await buildGraph(REPO_PATH);
    const branch = await getCurrentBranch();
    const branches = await getBranches();
    const commits = await getCommitHistory(200);
    res.json({ ...graph, currentBranch: branch, branches, commits });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── File Read/Write ───

app.get('/api/file', async (req, res) => {
  const { path: filePath } = req.query;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  try {
    const { readFile } = await import('fs/promises');
    const fullPath = resolve(REPO_PATH, filePath);
    if (!isPathSafe(filePath)) return res.status(403).json({ error: 'path outside repo' });
    const content = await readFile(fullPath, 'utf-8');
    res.json({ path: filePath, content });
  } catch {
    res.status(404).json({ error: 'File not found' });
  }
});

app.put('/api/file', async (req, res) => {
  const { path: filePath, content } = req.body;
  if (!filePath || content == null) return res.status(400).json({ error: 'path and content required' });
  if (!isPathSafe(filePath)) return res.status(403).json({ error: 'path outside repo' });
  try {
    const { mkdir } = await import('fs/promises');
    const fullPath = resolve(REPO_PATH, filePath);
    const parent = resolve(fullPath, '..');
    await mkdir(parent, { recursive: true });
    await writeFile(fullPath, content, 'utf-8');
    res.json({ ok: true, path: filePath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Layout state persistence ───
// Dedicated endpoint for .hexis/layout.json. Returns 200 with `state: null`
// when the file doesn't exist yet (first run) so the client doesn't spam
// the console with 404s on a harmless missing-file case.

const LAYOUT_STATE_PATH = '.hexis/layout.json';

app.get('/api/layout-state', async (_req, res) => {
  try {
    const { readFile } = await import('fs/promises');
    const fullPath = resolve(REPO_PATH, LAYOUT_STATE_PATH);
    const content = await readFile(fullPath, 'utf-8');
    res.json({ state: JSON.parse(content) });
  } catch {
    // Missing or unreadable — not an error, just no state yet
    res.json({ state: null });
  }
});

app.put('/api/layout-state', async (req, res) => {
  try {
    const { mkdir } = await import('fs/promises');
    const fullPath = resolve(REPO_PATH, LAYOUT_STATE_PATH);
    const parent = resolve(fullPath, '..');
    await mkdir(parent, { recursive: true });
    await writeFile(fullPath, JSON.stringify(req.body, null, 2), 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/layout-state', async (_req, res) => {
  try {
    const { unlink } = await import('fs/promises');
    await unlink(resolve(REPO_PATH, LAYOUT_STATE_PATH));
    res.json({ ok: true });
  } catch {
    // Already gone — fine
    res.json({ ok: true });
  }
});

// ─── File/Folder CRUD — create/delete/move ───
//
// These sit alongside PUT /api/file (save existing content) and power
// the hex grid's drag-drop + right-click file operations.

// POST /api/file/create  { path, content? }
// Create a new file (empty by default). Fails if the file already exists.
app.post('/api/file/create', async (req, res) => {
  const { path: filePath, content = '' } = req.body || {};
  if (!filePath) return res.status(400).json({ error: 'path required' });
  if (!isPathSafe(filePath)) return res.status(403).json({ error: 'path outside repo' });
  try {
    const { mkdir, access, writeFile: fsWriteFile } = await import('fs/promises');
    const fullPath = resolve(REPO_PATH, filePath);
    // Refuse to clobber an existing file
    try {
      await access(fullPath);
      return res.status(409).json({ error: 'file already exists' });
    } catch { /* file doesn't exist — good */ }
    const parent = resolve(fullPath, '..');
    await mkdir(parent, { recursive: true });
    await fsWriteFile(fullPath, content, 'utf-8');
    res.json({ ok: true, path: filePath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/file?path=...
// Moves to the OS trash via the `trash` package (recoverable in recycle
// bin). Falls back to permanent unlink if trash fails.
app.delete('/api/file', async (req, res) => {
  const { path: filePath } = req.query;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  if (!isPathSafe(filePath)) return res.status(403).json({ error: 'path outside repo' });
  try {
    const fullPath = resolve(REPO_PATH, filePath);
    try {
      const trashModule = await import('trash');
      const trash = trashModule.default;
      await trash(fullPath);
    } catch (trashErr) {
      console.warn('[trash] fallback to unlink:', trashErr.message);
      const { unlink } = await import('fs/promises');
      await unlink(fullPath);
    }
    res.json({ ok: true, path: filePath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/folder/create  { path }
app.post('/api/folder/create', async (req, res) => {
  const { path: folderPath } = req.body || {};
  if (!folderPath) return res.status(400).json({ error: 'path required' });
  if (!isPathSafe(folderPath)) return res.status(403).json({ error: 'path outside repo' });
  try {
    const { mkdir, stat } = await import('fs/promises');
    const fullPath = resolve(REPO_PATH, folderPath);
    // Pre-check: if a FILE already exists at that path, mkdir would throw
    // a cryptic EEXIST. Return a clear error instead.
    try {
      const st = await stat(fullPath);
      if (st.isFile()) {
        return res.status(409).json({
          error: `A file named "${folderPath}" already exists at that location. Rename or delete it first.`,
        });
      }
      if (st.isDirectory()) {
        return res.status(409).json({ error: `Folder "${folderPath}" already exists.` });
      }
    } catch { /* doesn't exist — good, proceed */ }
    await mkdir(fullPath, { recursive: true });
    res.json({ ok: true, path: folderPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/folder/move  { from, to }
// Renames an entire directory (and everything inside it).
app.post('/api/folder/move', async (req, res) => {
  const { from, to } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  if (!isPathSafe(from) || !isPathSafe(to)) return res.status(403).json({ error: 'path outside repo' });
  try {
    const { mkdir, rename } = await import('fs/promises');
    const fromFull = resolve(REPO_PATH, from);
    const toFull = resolve(REPO_PATH, to);
    const parent = resolve(toFull, '..');
    await mkdir(parent, { recursive: true });
    await rename(fromFull, toFull);
    res.json({ ok: true, from, to });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/folder?path=...&recursive=true
// Moves to trash when possible, falls back to permanent rm -rf.
// Idempotent: if the path doesn't exist, returns ok (already deleted).
app.delete('/api/folder', async (req, res) => {
  const { path: folderPath, recursive } = req.query;
  if (!folderPath) return res.status(400).json({ error: 'path required' });
  if (!isPathSafe(folderPath)) return res.status(403).json({ error: 'path outside repo' });
  try {
    const fullPath = resolve(REPO_PATH, folderPath);
    const { stat, rm } = await import('fs/promises');

    // Idempotent: nonexistent path is treated as already-deleted success.
    // Prevents 500s on double-delete or retry after a successful trash call.
    try {
      await stat(fullPath);
    } catch (statErr) {
      if (statErr.code === 'ENOENT') {
        return res.json({ ok: true, path: folderPath, alreadyGone: true });
      }
      throw statErr;
    }

    try {
      const trashModule = await import('trash');
      const trash = trashModule.default;
      await trash(fullPath);
    } catch (trashErr) {
      console.warn('[trash] fallback to rm:', trashErr.message);
      // force: true so missing-file / permission-edge errors don't bubble up
      await rm(fullPath, { recursive: recursive === 'true', force: true });
    }
    res.json({ ok: true, path: folderPath });
  } catch (err) {
    console.error('[DELETE /api/folder] failed:', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// ─── Workspace Search (ripgrep) ───
//
// POST /api/search { pattern, regex?, caseSensitive?, glob?, max? }
// Returns [{ path, line, col, text, matches: [[start, end], ...] }]
//
// Uses ripgrep in JSON mode. Requires `rg` on the system PATH; falls
// back to a plain-text error message if it isn't installed.
app.post('/api/search', async (req, res) => {
  const { pattern, regex = false, caseSensitive = false, glob = null, max = 500 } = req.body || {};
  if (!pattern || typeof pattern !== 'string') {
    return res.status(400).json({ error: 'pattern required' });
  }
  if (pattern.length > 500) {
    return res.status(400).json({ error: 'pattern too long' });
  }

  const args = ['--json', '--max-count', '200'];
  if (!regex) args.push('--fixed-strings');
  if (!caseSensitive) args.push('--ignore-case');
  if (glob) args.push('--glob', glob);
  args.push('--', pattern, '.');

  let rg;
  try {
    rg = spawn('rg', args, { cwd: REPO_PATH });
  } catch (err) {
    return res.status(500).json({ error: `Failed to spawn ripgrep: ${err.message}` });
  }

  const results = [];
  let buffer = '';
  let count = 0;
  let killed = false;

  rg.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf-8');
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type !== 'match') continue;
        const m = msg.data;
        results.push({
          path: (m.path?.text || '').replace(/\\/g, '/'),
          line: m.line_number,
          col: (m.submatches?.[0]?.start ?? 0),
          text: (m.lines?.text || '').replace(/\r?\n$/, ''),
          matches: (m.submatches || []).map((s) => [s.start, s.end]),
        });
        count++;
        if (count >= max && !killed) {
          killed = true;
          try { rg.kill(); } catch {}
        }
      } catch {
        // Ignore parse errors — rg occasionally emits partial lines
      }
    }
  });

  let errorOut = '';
  rg.stderr.on('data', (d) => { errorOut += d.toString('utf-8'); });

  rg.on('close', (code) => {
    // rg exit code 1 = no matches (normal), 0 = matches, >1 = error
    if (code !== null && code > 1 && !killed) {
      return res.status(500).json({ error: errorOut || `ripgrep exited with code ${code}` });
    }
    res.json({ results, truncated: killed });
  });

  rg.on('error', (err) => {
    if (!res.headersSent) {
      res.status(500).json({ error: `ripgrep not available: ${err.message}` });
    }
  });
});

// ─── AI Inline Edit (Ctrl+K) ───
//
// POST /api/ai/edit { filePath, before, selection, after, instruction }
// Calls Claude via the agent SDK with NO tools and a tight system
// prompt. Returns { newCode } — exactly the rewritten selection,
// nothing else. Strips any markdown code fences the model adds.
app.post('/api/ai/edit', async (req, res) => {
  const { filePath, before = '', selection = '', after = '', instruction = '' } = req.body || {};
  if (!instruction || typeof instruction !== 'string') {
    return res.status(400).json({ error: 'instruction required' });
  }
  if (instruction.length > 2000) {
    return res.status(400).json({ error: 'instruction too long' });
  }

  // Trim context windows to keep the prompt reasonable
  const MAX_CTX = 2000;
  const ctxBefore = before.length > MAX_CTX ? before.slice(-MAX_CTX) : before;
  const ctxAfter = after.length > MAX_CTX ? after.slice(0, MAX_CTX) : after;

  const prompt =
`You are editing a portion of the file \`${filePath || 'unknown'}\` inside the Hexis editor.

The user wants to transform the SELECTED region according to this instruction:
>>> ${instruction.trim()} <<<

Context BEFORE the selection (do not modify):
\`\`\`
${ctxBefore}
\`\`\`

The SELECTED region (this is what you rewrite):
\`\`\`
${selection}
\`\`\`

Context AFTER the selection (do not modify):
\`\`\`
${ctxAfter}
\`\`\`

Return ONLY the new version of the SELECTED region. Do not include the surrounding
context, do not include markdown code fences, do not include commentary. The output
will be pasted directly into the editor in place of the selection.`;

  try {
    const stream = query({
      prompt,
      options: {
        // Note: fallbackModel is intentionally omitted. The SDK throws
        // "Fallback model cannot be the same as the main model" if both
        // match, and there's no sensible different fallback for a
        // single-shot inline edit.
        model: 'claude-sonnet-4-5',
        settingSources: ['user', 'project', 'local'],
        maxTurns: 1,
        allowedTools: [],
        permissionMode: 'plan',
        env: cleanEnvForAi(),
      },
    });

    let collected = '';
    for await (const message of stream) {
      if (message.type === 'assistant' && message.message?.content) {
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text) {
            collected += block.text;
          }
        }
      }
      if (message.type === 'result' || message.type === 'final') break;
    }
    try { stream.close?.(); } catch {}

    let newCode = collected.trim();
    // Strip ``` fences if the model added them
    const fenceMatch = newCode.match(/^```[\w]*\n?([\s\S]*?)\n?```$/);
    if (fenceMatch) newCode = fenceMatch[1];
    // Strip leading/trailing blank lines but preserve internal ones
    newCode = newCode.replace(/^\n+/, '').replace(/\n+$/, '');

    res.json({ newCode });
  } catch (err) {
    console.error('AI edit failed:', err);
    res.status(500).json({ error: err.message || 'AI edit failed' });
  }
});

function cleanEnvForAi() {
  // Strip API key to force subscription OAuth (matches agent-orchestrator)
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.anthropic_api_key;
  return env;
}

// ─── File Move ───

app.post('/api/file/move', async (req, res) => {
  const { from, to, updateLinks = true } = req.body;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  if (!isPathSafe(from) || !isPathSafe(to)) return res.status(403).json({ error: 'path outside repo' });
  if (from === to) return res.status(400).json({ error: 'source and destination are the same' });

  // Check source exists
  try {
    await access(resolve(REPO_PATH, from));
  } catch {
    return res.status(404).json({ error: `Source file not found: ${from}` });
  }

  // Check destination doesn't exist
  try {
    await access(resolve(REPO_PATH, to));
    return res.status(409).json({ error: `Destination already exists: ${to}` });
  } catch {
    // Good — destination doesn't exist
  }

  // Perform the move
  const result = await moveFile(from, to);
  if (result.error) return res.status(500).json(result);

  // Update markdown links across the repo — UNLESS the move fell back
  // to plain fs.rename for an untracked file. Untracked files can't have
  // inbound markdown references yet, so the full-repo scan is wasted work.
  let updatedLinks = [];
  if (updateLinks && !result.fallback) {
    try {
      updatedLinks = await updateMarkdownLinks(REPO_PATH, from, to, getGit());
    } catch (err) {
      // Non-fatal — the move succeeded, link update is best-effort
      console.error('[move] Link update error:', err.message);
    }
  }

  res.json({ ok: true, from, to, updatedLinks, fallback: !!result.fallback });
});

// ─── Git Read ───

app.get('/api/branches', async (req, res) => {
  const branches = await getBranches();
  const current = await getCurrentBranch();
  res.json({ branches, current });
});

app.get('/api/commits', async (req, res) => {
  const limit = parseInt(req.query.limit) || 200;
  res.json(await getCommitHistory(limit));
});

app.get('/api/git/status', async (req, res) => {
  res.json(await getStatus());
});

app.get('/api/diff/branch', async (req, res) => {
  const { from = 'main', to = 'HEAD' } = req.query;
  res.json(await getBranchDiff(to, from));
});

app.get('/api/diff/file', async (req, res) => {
  const { path, from, to } = req.query;
  if (!path) return res.status(400).json({ error: 'path required' });
  // If no from/to, get working directory diff (uncommitted changes)
  if (!from && !to) {
    res.json({ path, diff: await getWorkingDiff(path) });
  } else {
    res.json({ path, diff: await getFileDiff(path, to || 'HEAD', from || 'main') });
  }
});

// ─── Git Write ───

app.post('/api/git/add', async (req, res) => {
  const { files } = req.body;
  if (!files?.length) return res.status(400).json({ error: 'files required' });
  res.json(await stageFiles(files));
});

app.post('/api/git/commit', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  res.json(await commitChanges(message));
});

app.post('/api/git/push', async (req, res) => {
  const { remote, branch } = req.body || {};
  res.json(await pushChanges(remote, branch));
});

app.post('/api/git/pull', async (req, res) => {
  const { remote, branch } = req.body || {};
  res.json(await pullChanges(remote, branch));
});

app.post('/api/git/branch', async (req, res) => {
  const { name, from } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  res.json(await createBranch(name, from));
});

app.post('/api/git/checkout', async (req, res) => {
  const { branch } = req.body;
  if (!branch) return res.status(400).json({ error: 'branch required' });
  const result = await checkoutBranch(branch);
  if (result.ok) broadcast({ type: 'branchChange', branch });
  res.json(result);
});

app.post('/api/git/merge', async (req, res) => {
  const { branch } = req.body;
  if (!branch) return res.status(400).json({ error: 'branch required' });
  res.json(await mergeBranch(branch));
});

app.delete('/api/git/branch', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  res.json(await deleteBranch(name));
});

// ─── Stash ───

app.get('/api/git/stash', async (req, res) => {
  res.json(await stashList());
});

app.post('/api/git/stash', async (req, res) => {
  const { message } = req.body || {};
  res.json(await stashPush(message));
});

app.post('/api/git/stash/pop', async (req, res) => {
  const { index = 0 } = req.body || {};
  res.json(await stashPop(index));
});

app.delete('/api/git/stash', async (req, res) => {
  const { index = 0 } = req.body || {};
  res.json(await stashDrop(index));
});

// ─── Blame & Commit Detail ───

app.get('/api/git/blame', async (req, res) => {
  const { path } = req.query;
  if (!path) return res.status(400).json({ error: 'path required' });
  res.json(await getBlame(path));
});

app.get('/api/git/commit/:hash', async (req, res) => {
  const { hash } = req.params;
  if (!hash) return res.status(400).json({ error: 'hash required' });
  res.json(await getCommitDetail(hash));
});

// ─── Amend, Revert, Reset ───

app.post('/api/git/amend', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  res.json(await amendCommit(message));
});

app.post('/api/git/revert', async (req, res) => {
  const { hash } = req.body;
  if (!hash) return res.status(400).json({ error: 'hash required' });
  res.json(await revertCommit(hash));
});

app.post('/api/git/reset', async (req, res) => {
  // If body has `files`, it's the existing unstage operation
  const { files, hash, mode } = req.body || {};
  if (files?.length) {
    return res.json(await unstageFiles(files));
  }
  // Otherwise it's the new reset-to-commit operation
  if (!hash) return res.status(400).json({ error: 'hash required' });
  res.json(await resetTo(hash, mode));
});

// ─── Fetch ───

app.post('/api/git/fetch', async (req, res) => {
  res.json(await fetchRemote());
});

// ─── Agent (Claude AI) ───

app.post('/api/agent/start', (req, res) => {
  const { taskId, prompt, files } = req.body;
  if (!taskId || !prompt) return res.status(400).json({ error: 'taskId and prompt required' });
  try {
    startTask(taskId, prompt, REPO_PATH, broadcast, files);
    res.json({ ok: true, taskId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Task Writer: refine raw user input into a polished task
app.post('/api/task/write', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  try {
    const refined = await writeTask(prompt, REPO_PATH, broadcast);
    res.json({ ok: true, task: refined });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Deep research pipeline — "Best Option Guarantee"
// Body: { taskId, query, createTasks?, focusArea?, workerCount? }
app.post('/api/research/start', (req, res) => {
  const { taskId, query, createTasks, focusArea, workerCount } = req.body;
  if (!taskId || !query) return res.status(400).json({ error: 'taskId and query required' });
  try {
    researchTask(taskId, query, REPO_PATH, broadcast, {
      createTasks: createTasks === true,
      focusArea: focusArea || '',
      workerCount: workerCount || 3,
    });
    res.json({ ok: true, taskId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Chat mode — direct conversational agent, no pipeline
// Body: { chatId, message, sessionId?, model? }
// Returns { ok, sessionId, text, tokens, cost } once the turn completes.
// Events also stream via SSE (chat_turn_started, agent_stream,
// chat_turn_complete, chat_turn_failed) so the UI can render tokens live.
app.post('/api/chat/message', async (req, res) => {
  const { chatId, message, sessionId, model } = req.body || {};
  if (!chatId || !message) return res.status(400).json({ error: 'chatId and message required' });
  try {
    const result = await chatMessage(chatId, message, REPO_PATH, broadcast, {
      sessionId: sessionId || null,
      model: model || 'sonnet',
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

// Cancel an in-flight chat turn.
app.post('/api/chat/cancel', (req, res) => {
  const { chatId } = req.body || {};
  if (!chatId) return res.status(400).json({ error: 'chatId required' });
  cancelChat(chatId);
  res.json({ ok: true });
});

// Dispose a chat's server-side state (UI is closing it).
app.post('/api/chat/dispose', (req, res) => {
  const { chatId } = req.body || {};
  if (!chatId) return res.status(400).json({ error: 'chatId required' });
  disposeChat(chatId);
  res.json({ ok: true });
});

app.post('/api/agent/approve', (req, res) => {
  const { taskId } = req.body;
  if (!taskId) return res.status(400).json({ error: 'taskId required' });
  approveTask(taskId);
  res.json({ ok: true });
});

app.post('/api/agent/cancel', (req, res) => {
  const { taskId } = req.body;
  if (!taskId) return res.status(400).json({ error: 'taskId required' });
  cancelTask(taskId);
  res.json({ ok: true });
});

app.post('/api/agent/resume', async (req, res) => {
  const { taskId, prompt } = req.body;
  if (!taskId) return res.status(400).json({ error: 'taskId required' });
  try {
    await resumeTaskFn(taskId, prompt || '', REPO_PATH, broadcast);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Terminal ───

const BLOCKED_PATTERNS = [
  /rm\s+(-rf?|--recursive)\s+\/\s*$/i,
  /rm\s+(-rf?|--recursive)\s+\/\*/i,
  /rm\s+(-rf?)\s+~\s*$/i,
  /format\s+[a-z]:/i,
  /mkfs\./i,
  /dd\s+if=.*of=\/dev\//i,
  /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;/,       // fork bomb
  />\s*\/dev\/sd[a-z]/i,
  /shutdown/i,
  /reboot/i,
  /init\s+[0-6]/i,
];

app.post('/api/terminal/exec', (req, res) => {
  const { command } = req.body;
  if (!command || typeof command !== 'string') {
    return res.status(400).json({ error: 'command required' });
  }

  const trimmed = command.trim();
  if (!trimmed) {
    return res.status(400).json({ error: 'command cannot be empty' });
  }

  // Block dangerous commands
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return res.status(403).json({ error: `Blocked: command matched a restricted pattern` });
    }
  }

  const timeout = 10_000; // 10 seconds

  exec(trimmed, { cwd: REPO_PATH, timeout, maxBuffer: 1024 * 1024, shell: true }, (err, stdout, stderr) => {
    if (err) {
      // Timeout
      if (err.killed) {
        return res.json({ stdout: stdout || '', stderr: 'Command timed out (10s limit)', exitCode: 124 });
      }
      return res.json({
        stdout: stdout || '',
        stderr: stderr || err.message || 'Unknown error',
        exitCode: err.code ?? 1,
      });
    }
    res.json({ stdout: stdout || '', stderr: stderr || '', exitCode: 0 });
  });
});

// ─── Test Runner ───

let lastTestResults = null;

async function detectTestFramework(repoPath) {
  try {
    const pkgRaw = await readFile(resolve(repoPath, 'package.json'), 'utf-8');
    const pkg = JSON.parse(pkgRaw);
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

    if (allDeps.vitest) return { framework: 'vitest', command: 'npx vitest run --reporter=json' };
    if (allDeps.jest) return { framework: 'jest', command: 'npx jest --json --no-coverage' };
    if (allDeps.mocha) return { framework: 'mocha', command: 'npx mocha --reporter json --recursive' };

    // Check scripts for hints
    const testScript = pkg.scripts?.test || '';
    if (testScript.includes('vitest')) return { framework: 'vitest', command: 'npx vitest run --reporter=json' };
    if (testScript.includes('jest')) return { framework: 'jest', command: 'npx jest --json --no-coverage' };
    if (testScript.includes('mocha')) return { framework: 'mocha', command: 'npx mocha --reporter json --recursive' };
  } catch { /* no package.json */ }

  // Check for pytest (Python)
  try {
    await access(resolve(repoPath, 'pytest.ini'));
    return { framework: 'pytest', command: 'python -m pytest --tb=short -q --json-report --json-report-file=-' };
  } catch { /* no pytest.ini */ }

  try {
    await access(resolve(repoPath, 'pyproject.toml'));
    const pyproject = await readFile(resolve(repoPath, 'pyproject.toml'), 'utf-8');
    if (pyproject.includes('pytest') || pyproject.includes('[tool.pytest')) {
      return { framework: 'pytest', command: 'python -m pytest --tb=short -q --json-report --json-report-file=-' };
    }
  } catch { /* no pyproject.toml */ }

  try {
    await access(resolve(repoPath, 'setup.cfg'));
    const setupCfg = await readFile(resolve(repoPath, 'setup.cfg'), 'utf-8');
    if (setupCfg.includes('pytest')) {
      return { framework: 'pytest', command: 'python -m pytest --tb=short -q --json-report --json-report-file=-' };
    }
  } catch { /* no setup.cfg */ }

  return null;
}

function parseVitestResults(raw) {
  const data = JSON.parse(raw);
  const tests = [];
  let passed = 0, failed = 0;

  for (const suite of data.testResults || []) {
    for (const t of suite.assertionResults || []) {
      const status = t.status === 'passed' ? 'pass' : 'fail';
      if (status === 'pass') passed++; else failed++;
      tests.push({
        name: t.ancestorTitles?.length ? `${t.ancestorTitles.join(' > ')} > ${t.title}` : t.title,
        file: suite.name?.replace(/\\/g, '/'),
        status,
        duration: t.duration || 0,
        error: t.failureMessages?.length ? t.failureMessages.join('\n') : undefined,
      });
    }
  }

  return { passed, failed, total: passed + failed, tests, framework: 'vitest' };
}

function parseJestResults(raw) {
  const data = JSON.parse(raw);
  const tests = [];
  let passed = 0, failed = 0;

  for (const suite of data.testResults || []) {
    for (const t of suite.testResults || suite.assertionResults || []) {
      const status = t.status === 'passed' ? 'pass' : 'fail';
      if (status === 'pass') passed++; else failed++;
      tests.push({
        name: t.ancestorTitles?.length ? `${t.ancestorTitles.join(' > ')} > ${t.title}` : (t.fullName || t.title),
        file: (suite.testFilePath || suite.name || '').replace(/\\/g, '/'),
        status,
        duration: t.duration || 0,
        error: t.failureMessages?.length ? t.failureMessages.join('\n') : undefined,
      });
    }
  }

  return { passed, failed, total: passed + failed, tests, framework: 'jest' };
}

function parseMochaResults(raw) {
  const data = JSON.parse(raw);
  const tests = [];
  let passed = 0, failed = 0;

  for (const t of data.tests || []) {
    const status = t.err && Object.keys(t.err).length > 0 ? 'fail' : 'pass';
    if (status === 'pass') passed++; else failed++;
    tests.push({
      name: t.fullTitle || t.title,
      file: (t.file || '').replace(/\\/g, '/'),
      status,
      duration: t.duration || 0,
      error: t.err?.message || undefined,
    });
  }

  for (const t of data.failures || []) {
    if (!tests.some(existing => existing.name === (t.fullTitle || t.title))) {
      failed++;
      tests.push({
        name: t.fullTitle || t.title,
        file: (t.file || '').replace(/\\/g, '/'),
        status: 'fail',
        duration: t.duration || 0,
        error: t.err?.message || undefined,
      });
    }
  }

  return { passed, failed, total: passed + failed, tests, framework: 'mocha' };
}

function parsePytestResults(raw) {
  const data = JSON.parse(raw);
  const tests = [];
  let passed = 0, failed = 0;

  for (const t of data.tests || []) {
    const status = t.outcome === 'passed' ? 'pass' : 'fail';
    if (status === 'pass') passed++; else failed++;
    tests.push({
      name: t.nodeid || t.name,
      file: (t.nodeid?.split('::')[0] || '').replace(/\\/g, '/'),
      status,
      duration: t.call?.duration || t.duration || 0,
      error: t.call?.longrepr || t.longrepr || undefined,
    });
  }

  return { passed, failed, total: passed + failed, tests, framework: 'pytest' };
}

app.post('/api/tests/run', async (req, res) => {
  try {
    const detected = await detectTestFramework(REPO_PATH);
    if (!detected) {
      return res.status(404).json({ error: 'No test framework detected. Supports: vitest, jest, mocha, pytest.' });
    }

    const { framework, command } = detected;
    let stdout;
    try {
      stdout = execSync(command, {
        cwd: REPO_PATH,
        timeout: 60000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0', CI: 'true' },
      });
    } catch (execErr) {
      // Many test runners exit with code 1 when tests fail — that's expected
      stdout = execErr.stdout || '';
      if (!stdout && execErr.stderr) {
        return res.status(500).json({ error: `Test runner failed: ${execErr.stderr.slice(0, 500)}` });
      }
    }

    // Extract JSON from output (some runners prefix with non-JSON text)
    const jsonStart = stdout.indexOf('{');
    const jsonStr = jsonStart >= 0 ? stdout.slice(jsonStart) : stdout;

    let results;
    const parsers = { vitest: parseVitestResults, jest: parseJestResults, mocha: parseMochaResults, pytest: parsePytestResults };
    results = parsers[framework](jsonStr);
    results.ranAt = Date.now();

    // Make file paths relative to repo root
    const repoNormalized = REPO_PATH.replace(/\\/g, '/');
    results.tests = results.tests.map(t => ({
      ...t,
      file: t.file.replace(repoNormalized + '/', '').replace(repoNormalized, ''),
    }));

    lastTestResults = results;
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tests/status', (req, res) => {
  if (!lastTestResults) {
    return res.json({ passed: 0, failed: 0, total: 0, tests: [], framework: null, ranAt: null });
  }
  res.json(lastTestResults);
});

// ─── State sync API (server-side persistence) ───

// Snapshot of current state — frontend hydrates from this on connect/refresh
app.get('/api/state', (req, res) => {
  res.json(stateStore.getSnapshot());
});

// Tasks CRUD — frontend calls these instead of mutating localStorage directly
app.post('/api/tasks', (req, res) => {
  const task = req.body;
  if (!task?.id || !task?.title) return res.status(400).json({ error: 'task id and title required' });
  stateStore.addTask(task);
  broadcast({ type: 'state_task_added', task });
  res.json({ ok: true, task });
});

app.patch('/api/tasks/:id', (req, res) => {
  const updated = stateStore.updateTask(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'not found' });
  broadcast({ type: 'state_task_updated', task: updated });
  res.json({ ok: true, task: updated });
});

app.delete('/api/tasks/:id', (req, res) => {
  stateStore.deleteTask(req.params.id);
  broadcast({ type: 'state_task_deleted', id: req.params.id });
  res.json({ ok: true });
});

// ─── Workspace ───

// Returns the REPO_PATH the server is locked to. Used by the client to
// scope per-project localStorage keys (chats, layout, history, etc.) so
// switching HEXIS_TARGET between projects doesn't leak state.
app.get('/api/workspace', (_req, res) => {
  res.json({ path: REPO_PATH });
});

// Returns the raw contents of .hexis/memories/learned.md plus a
// freshness map. Freshness is pre-computed server-side keyed by the
// exact rule line text (stripping the leading bullet marker) so the
// client doesn't need to duplicate the hash function. Value is 0..1
// where 1 = applied today, 0 = never / >30d ago.
app.get('/api/memory/learned', async (_req, res) => {
  try {
    const path = resolve(REPO_PATH, '.hexis', 'memories', 'learned.md');
    const meta = await loadMemoryMeta();
    let content = '';
    let exists = true;
    try { content = await readFile(path, 'utf-8'); }
    catch (err) {
      if (err.code === 'ENOENT') { exists = false; }
      else throw err;
    }
    // Build freshness-by-text map
    const freshness = {};
    if (exists) {
      for (const line of content.split(/\r?\n/)) {
        const m = /^\s*-\s+(.+)$/.exec(line);
        if (m) {
          const text = m[1];
          freshness[text] = freshnessScore(meta, text);
        }
      }
    }
    res.json({ path: '.hexis/memories/learned.md', content, exists, freshness });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Auto-seed learned.md from CLAUDE.md / AGENTS.md / .claude/CLAUDE.md
// when learned.md is empty. Extracts convention-like bullets
// (lines starting with "- " or imperative verbs like "use", "don't",
// "prefer", "always", "never") and appends them as scoped rules.
// Idempotent: refuses to run if learned.md already has > 3 rules.
app.post('/api/memory/seed', async (_req, res) => {
  try {
    const { readFile, writeFile, mkdir } = await import('fs/promises');
    const memDir = resolve(REPO_PATH, '.hexis', 'memories');
    const learnedPath = resolve(memDir, 'learned.md');

    // Refuse if learned.md already has content
    let existing = '';
    try { existing = await readFile(learnedPath, 'utf-8'); } catch {}
    const existingRules = existing.split(/\r?\n/).filter(l => /^\s*-\s+/.test(l));
    if (existingRules.length > 3) {
      return res.status(400).json({
        error: `learned.md already has ${existingRules.length} rules — not seeding. Use /mem consolidate to reorganize instead.`,
      });
    }

    // Find a source file
    const candidates = ['CLAUDE.md', 'AGENTS.md', '.claude/CLAUDE.md'];
    let srcPath = null;
    let srcContent = '';
    for (const name of candidates) {
      try {
        const p = resolve(REPO_PATH, name);
        const c = await readFile(p, 'utf-8');
        srcPath = name;
        srcContent = c;
        break;
      } catch {}
    }
    if (!srcPath) {
      return res.status(404).json({ error: 'No CLAUDE.md / AGENTS.md found to seed from' });
    }

    // Extract convention-like bullets
    const imperative = /^(use|don't|do not|prefer|always|never|avoid|treat|ensure|make sure|check)/i;
    const seeded = [];
    for (const line of srcContent.split(/\r?\n/)) {
      const bullet = /^\s*-\s+(.+)$/.exec(line);
      if (bullet) {
        const text = bullet[1].trim();
        if (text.length > 10 && text.length < 280) seeded.push(text);
        continue;
      }
      // Also catch imperative sentences outside bullets
      const sentence = line.trim();
      if (sentence.length > 15 && sentence.length < 280 && imperative.test(sentence)) {
        seeded.push(sentence.replace(/[.!?]+$/, ''));
      }
    }

    if (seeded.length === 0) {
      return res.status(404).json({ error: `No convention-like statements found in ${srcPath}` });
    }

    // Cap at 30 rules so we don't flood with every bullet
    const capped = seeded.slice(0, 30);
    const stamp = new Date().toISOString().slice(0, 10);
    const block =
      `## Learned\n\n` +
      capped.map(r => `- ${r} _(seed from ${srcPath}, ${stamp})_`).join('\n') +
      '\n';
    const next = existing.trim() ? existing + '\n\n' + block : block;

    await mkdir(memDir, { recursive: true });
    await writeFile(learnedPath, next, 'utf-8');

    res.json({
      ok: true,
      source: srcPath,
      count: capped.length,
      total_found: seeded.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Haiku-powered consolidation of learned.md:
//   - Read the current file
//   - Back it up to learned.YYYY-MM-DD.md.bak
//   - Ask Haiku to dedupe similar rules, drop clearly-outdated ones,
//     and organize remaining rules into categories (Rules / File
//     conventions / Pitfalls / Facts)
//   - Write the organized result back to learned.md
//
// Response: { before: n, after: n, backup: path, preview: string }
// Returns 400 if learned.md doesn't exist or has < 5 rules (not
// worth running Haiku for small files).
app.post('/api/memory/consolidate', async (_req, res) => {
  try {
    const { readFile, writeFile, mkdir } = await import('fs/promises');
    const memDir = resolve(REPO_PATH, '.hexis', 'memories');
    const path = resolve(memDir, 'learned.md');
    let content = '';
    try { content = await readFile(path, 'utf-8'); }
    catch { return res.status(404).json({ error: 'learned.md does not exist yet' }); }

    const beforeRules = content.split(/\r?\n/).filter(l => /^\s*-\s+/.test(l));
    if (beforeRules.length < 5) {
      return res.status(400).json({
        error: `Only ${beforeRules.length} rules in learned.md — not worth consolidating yet (needs ≥ 5).`,
      });
    }

    // Backup current file
    await mkdir(memDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const backupPath = resolve(memDir, `learned.${stamp}.md.bak`);
    await writeFile(backupPath, content, 'utf-8');

    // Ask Haiku to consolidate
    const consolidatePrompt = `You are reorganizing a project memory file. Here are the current rules — each a short bullet. Some are duplicates, some are outdated, some could be merged.

TASK:
1. Dedupe: merge bullets that say substantially the same thing. Keep the clearest phrasing.
2. Drop obviously outdated/contradictory rules (keep the newest).
3. Organize the remaining bullets into these sections in order:
   ## Rules       (general do / don't statements)
   ## File conventions  (rules that apply to a specific file or directory)
   ## Pitfalls    (gotchas, bugs to avoid, things that broke before)
   ## Facts       (neutral facts about the codebase)
4. Preserve any existing \`[scope: ...]\` tags verbatim — they're part of the rule.
5. Keep the \`_(source, date)_\` italic footers from the originals if present.
6. Output ONLY the markdown file contents. No preamble, no explanation.

Current learned.md contents:
\`\`\`
${content}
\`\`\``;

    const stream = query({
      prompt: consolidatePrompt,
      options: {
        cwd: REPO_PATH,
        model: 'haiku',
        effort: 'low',
        allowedTools: [],
        permissionMode: 'plan',
        maxTurns: 1,
        settingSources: [],
      },
    });
    let result = '';
    for await (const message of stream) {
      if (message.type === 'assistant' && message.message?.content) {
        for (const block of message.message.content) {
          if (block.type === 'text') result += block.text;
        }
      }
    }
    const consolidated = result.trim();
    if (!consolidated || consolidated.length < 100) {
      return res.status(500).json({ error: 'Consolidator returned empty or too-short result' });
    }

    await writeFile(path, consolidated, 'utf-8');

    const afterRules = consolidated.split(/\r?\n/).filter(l => /^\s*-\s+/.test(l));
    res.json({
      ok: true,
      before: beforeRules.length,
      after: afterRules.length,
      backup: `.hexis/memories/learned.${stamp}.md.bak`,
      preview: consolidated.slice(0, 1200),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search learned.md for rules matching a query. Used by /mem search
// in chat and by the auto-inject context header.
//
// Rules can carry a scope tag: `- rule text [scope: src/components/*]`
// (glob pattern). When the request includes a `files` parameter
// (comma-separated paths), rules matching any of those files via
// their scope get a score boost. Global rules (no scope tag) always
// qualify. File-scoped rules only qualify when their glob matches at
// least one supplied file.
//
// Query: ?q=<text>&limit=5&files=src/a.js,src/b.js
app.get('/api/memory/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  const limit = Math.max(1, Math.min(20, parseInt(req.query.limit || '5', 10)));
  const files = (req.query.files || '')
    .split(',')
    .map(f => f.trim())
    .filter(Boolean);
  try {
    const { readFile } = await import('fs/promises');
    const path = resolve(REPO_PATH, '.hexis', 'memories', 'learned.md');
    let content = '';
    try { content = await readFile(path, 'utf-8'); } catch { return res.json({ results: [] }); }

    // Extract bullet rules (lines starting with `- `)
    const rawRules = [];
    for (const line of content.split(/\r?\n/)) {
      const m = /^\s*-\s+(.+)$/.exec(line);
      if (m) rawRules.push(m[1]);
    }

    // Parse each rule for its scope tag and strip the tag from the text.
    // Format: `text [scope: glob1, glob2]` → { rule: 'text', scopes: ['glob1', 'glob2'] }
    const parsed = rawRules.map(raw => {
      const m = /^(.*?)\s*\[scope:\s*([^\]]+)\]\s*$/i.exec(raw);
      if (m) {
        return {
          rule: m[1].trim(),
          scopes: m[2].split(',').map(s => s.trim()).filter(Boolean),
        };
      }
      return { rule: raw, scopes: [] };
    });

    // If no query AND no file filter, return empty (avoid dumping the
    // whole file via an unrelated GET).
    if (!q && files.length === 0) return res.json({ results: [] });

    // Filter by scope if a file filter is present:
    // - Global rules (no scopes) always qualify
    // - Scoped rules match when:
    //     a) the scope glob matches at least one supplied file, OR
    //     b) the scope glob is a PARENT of at least one file (so a
    //        `src/components/*` rule applies to
    //        `src/components/deeply/nested.jsx`), OR
    //     c) the scope references the parent directory of a file
    //        (so `src/components` matches `src/components/Foo.jsx`)
    // Parent-directory match is implicit: we also test the file's
    // parent chain against the scope.
    const expandedFiles = files.flatMap(f => parentPaths(f));
    const scopeFiltered = files.length === 0
      ? parsed
      : parsed.filter(p =>
          p.scopes.length === 0 ||
          p.scopes.some(s =>
            expandedFiles.some(f => matchGlob(f, s)) ||
            // Also allow the scope to be a bare path prefix (e.g.
            // `src/components` matching `src/components/Foo.jsx`).
            files.some(f => f.startsWith(s.replace(/\/\*+$/, '') + '/') || f === s)
          ));

    // If no query, return the filtered list as-is (up to `limit`)
    if (!q) {
      return res.json({
        results: scopeFiltered.slice(0, limit).map(p => ({ rule: p.rule, score: 1, scopes: p.scopes })),
      });
    }

    // Token-level match with a score; dedupe stopwords and short tokens
    const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'with', 'is', 'are', 'be']);
    const terms = q.toLowerCase().split(/\s+/).filter(t => t.length > 2 && !STOP.has(t));
    if (terms.length === 0) return res.json({ results: [] });

    // Load freshness metadata so we can boost recently-used rules
    const meta = await loadMemoryMeta();

    const scored = scopeFiltered.map(p => {
      const lower = p.rule.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (lower.includes(t)) score += 1;
      }
      // File-scoped rules that MATCHED the file filter get a boost —
      // they're more specific than global rules and should rank first.
      if (files.length > 0 && p.scopes.length > 0) score += 0.5;
      // Freshness boost: recently-applied rules get up to +0.3.
      // Prevents stale rules from outranking newer more-relevant ones.
      const fresh = freshnessScore(meta, p.rule);
      score += fresh * 0.3;
      return { rule: p.rule, score, scopes: p.scopes, freshness: fresh };
    }).filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // Bump last-applied for the rules we're about to return.
    // Fire-and-forget — don't block the response.
    bumpAppliedRules(scored.map(r => r.rule)).catch(() => {});

    res.json({ results: scored });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Memory freshness tracking ──────────────────────────────────
// learned.md stays as plain markdown so it's human-editable and
// diff-friendly. But we need a way to track *usage* of each rule
// for freshness ranking without polluting the file itself.
// Solution: a sidecar JSON at `.hexis/memories/meta.json` keyed by
// a short hash of each rule's text:
//   { "<hash>": { "applied": [<timestamp>, ...], "lastApplied": <ts> } }
// Rules that get injected into turns bump their entry; the Memory
// panel + search both read these to weight + dim stale rules.

import { createHash as _createHash } from 'crypto';
function ruleHash(text) {
  return _createHash('sha1').update(text.trim().toLowerCase()).digest('hex').slice(0, 12);
}

async function loadMemoryMeta() {
  try {
    const { readFile } = await import('fs/promises');
    const metaPath = resolve(REPO_PATH, '.hexis', 'memories', 'meta.json');
    const raw = await readFile(metaPath, 'utf-8');
    return JSON.parse(raw);
  } catch { return {}; }
}

async function saveMemoryMeta(meta) {
  try {
    const { mkdir, writeFile } = await import('fs/promises');
    const dir = resolve(REPO_PATH, '.hexis', 'memories');
    await mkdir(dir, { recursive: true });
    const metaPath = resolve(dir, 'meta.json');
    await writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
  } catch { /* ignore */ }
}

// Bump the last-applied timestamp for each rule, prune old entries
// beyond the 20 most recent applications per rule.
async function bumpAppliedRules(rules) {
  if (!rules || rules.length === 0) return;
  const meta = await loadMemoryMeta();
  const now = Date.now();
  for (const r of rules) {
    const h = ruleHash(r);
    if (!meta[h]) meta[h] = { applied: [], lastApplied: 0 };
    meta[h].applied.push(now);
    if (meta[h].applied.length > 20) meta[h].applied = meta[h].applied.slice(-20);
    meta[h].lastApplied = now;
  }
  await saveMemoryMeta(meta);
}

// Return freshness score in [0, 1]: 1 = used today, 0 = never
// used or >30d ago. Linear decay over 30 days.
function freshnessScore(meta, ruleText) {
  const entry = meta[ruleHash(ruleText)];
  if (!entry || !entry.lastApplied) return 0;
  const ageDays = (Date.now() - entry.lastApplied) / (24 * 60 * 60 * 1000);
  if (ageDays <= 0) return 1;
  if (ageDays >= 30) return 0;
  return 1 - ageDays / 30;
}

// Expand a file path into its "parent chain" — the file itself
// plus every ancestor directory, each with a trailing `/**`
// appended. This lets us match scope globs like `src/**` against
// a file like `src/components/Foo.jsx` by including
// `src/components/Foo.jsx`, `src/components/**`, `src/**`.
function parentPaths(file) {
  const parts = file.split('/');
  const out = [file];
  for (let i = parts.length - 1; i > 0; i--) {
    const dir = parts.slice(0, i).join('/');
    out.push(dir + '/**');
    out.push(dir + '/*');
  }
  return out;
}

// Tiny glob matcher — supports `*` (any except `/`) and `**` (any).
// Good enough for scope tags like `src/components/*.jsx` or
// `server/**/*.js`. Not a full glob spec.
function matchGlob(path, pattern) {
  const re = new RegExp(
    '^' +
    pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')   // escape regex specials
      .replace(/\*\*/g, '<<DOUBLE>>')          // placeholder for **
      .replace(/\*/g, '[^/]*')                 // single * → any non-slash
      .replace(/<<DOUBLE>>/g, '.*') +          // ** → anything
    '$',
  );
  return re.test(path);
}

// Update a rule by matching its exact current text and replacing
// it with new text. Body: { oldText, newText }. Safer than
// index-based patching because learned.md is human-editable and
// line numbers drift.
app.patch('/api/memory/learned', async (req, res) => {
  const { oldText, newText } = req.body || {};
  if (!oldText || !newText) {
    return res.status(400).json({ error: 'oldText and newText required' });
  }
  try {
    const { readFile, writeFile } = await import('fs/promises');
    const path = resolve(REPO_PATH, '.hexis', 'memories', 'learned.md');
    const content = await readFile(path, 'utf-8');
    // Match a full bullet line containing oldText (case sensitive)
    const lines = content.split(/\r?\n/);
    let replaced = 0;
    const next = lines.map(line => {
      if (!replaced && /^\s*-\s+/.test(line) && line.includes(oldText)) {
        replaced++;
        return line.replace(oldText, newText);
      }
      return line;
    }).join('\n');
    if (!replaced) return res.status(404).json({ error: 'rule not found' });
    await writeFile(path, next, 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a rule by matching its exact current text. Body: { text }.
app.delete('/api/memory/learned', async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  try {
    const { readFile, writeFile } = await import('fs/promises');
    const path = resolve(REPO_PATH, '.hexis', 'memories', 'learned.md');
    const content = await readFile(path, 'utf-8');
    const lines = content.split(/\r?\n/);
    let deleted = 0;
    const next = lines.filter(line => {
      if (!deleted && /^\s*-\s+/.test(line) && line.includes(text)) {
        deleted++;
        return false;
      }
      return true;
    }).join('\n');
    if (!deleted) return res.status(404).json({ error: 'rule not found' });
    await writeFile(path, next, 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Append a rule to .hexis/memories/learned.md. Used by the chat
// "star to memory" button and future programmatic memory ops.
// Body: { rule: string, source?: 'chat' | 'user' | 'task' }
app.post('/api/memory/learned', async (req, res) => {
  const { rule, source } = req.body || {};
  if (!rule || typeof rule !== 'string' || !rule.trim()) {
    return res.status(400).json({ error: 'rule required' });
  }
  try {
    const { mkdir, readFile, writeFile } = await import('fs/promises');
    const dir = resolve(REPO_PATH, '.hexis', 'memories');
    await mkdir(dir, { recursive: true });
    const path = resolve(dir, 'learned.md');
    let existing = '';
    try { existing = await readFile(path, 'utf-8'); } catch {}
    const stamp = new Date().toISOString().slice(0, 10);
    const tag = source === 'chat' ? 'chat' : source === 'task' ? 'task' : 'user';
    const entry = `- ${rule.trim()} _(${tag}, ${stamp})_\n`;
    // Find or create a `## Learned` section (canonical header)
    let next;
    if (/^##\s+Learned\b/mi.test(existing)) {
      next = existing.replace(/^(##\s+Learned[^\n]*\n+)/mi, `$1${entry}`);
    } else {
      const header = existing.trim() ? '\n\n' : '';
      next = existing + header + `## Learned\n\n${entry}`;
    }
    await writeFile(path, next, 'utf-8');
    res.json({ ok: true, entry: entry.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Compact an array of chat turns into a one-paragraph summary via
// Haiku. Body: { turns: [{role, content}, ...] }. Returns
// { summary: string }. Used by /compact in the chat panel to
// preserve context while freeing tokens for long sessions.
app.post('/api/chat/compact', async (req, res) => {
  const { turns } = req.body || {};
  if (!Array.isArray(turns) || turns.length === 0) {
    return res.status(400).json({ error: 'turns required' });
  }
  try {
    // Format turns as a plain transcript for the summarizer
    const transcript = turns
      .map(t => `${t.role === 'user' ? 'USER' : 'ASSISTANT'}: ${(t.content || '').slice(0, 2000)}`)
      .join('\n\n');
    const summarizerPrompt = `Summarize this chat conversation into a compact paragraph (under 400 words) that preserves the key context, decisions made, files touched, and any unresolved questions. Write in third person as if briefing a new assistant joining the conversation. Focus on facts, not pleasantries.

---

${transcript}

---

Write only the summary paragraph — no preamble, no "Here's the summary".`;

    // Reuse the SDK query directly — Haiku, no tools, one turn
    const stream = query({
      prompt: summarizerPrompt,
      options: {
        cwd: REPO_PATH,
        model: 'haiku',
        effort: 'low',
        allowedTools: [],
        permissionMode: 'plan',
        maxTurns: 1,
        settingSources: [],
      },
    });
    let summary = '';
    for await (const message of stream) {
      if (message.type === 'assistant' && message.message?.content) {
        for (const block of message.message.content) {
          if (block.type === 'text') summary += block.text;
        }
      }
    }
    res.json({ summary: summary.trim() || '[summarizer returned empty]' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SSE ───

app.get('/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  // Include the repo path on connect so clients can scope their
  // per-project state immediately, before any real events arrive.
  res.write(`data: ${JSON.stringify({ type: 'connected', repoPath: REPO_PATH })}\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'state_snapshot', state: stateStore.getSnapshot() })}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ─── Watcher ───

startWatcher(REPO_PATH, (delta) => {
  console.log(`[watcher] ${delta.type}:`, delta.changes?.map(c => `${c.action} ${c.path}`).join(', '));
  broadcast({ type: 'fileChange', ...delta });
});

// ─── Start ───

app.listen(PORT, HOST, () => {
  console.log(`\n  ✦ Hexis server running at http://${HOST}:${PORT}`);
  console.log(`  ✦ Watching: ${REPO_PATH}`);
  console.log(`  ✦ SSE endpoint: http://${HOST}:${PORT}/events\n`);
});
