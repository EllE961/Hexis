import express from 'express';
import cors from 'cors';
import { resolve, dirname } from 'path';
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
import { startTask, cancelTask, approveTask, writeTask, resumeTaskFn, researchTask } from './agent-orchestrator.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { initStateStore, getStateStore } from './state-store.js';
import { initRepoContext } from './repo-context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Target path: CLI arg > env var > parent of this server dir
const REPO_PATH = (process.argv[2] || process.env.HEXIS_TARGET || resolve(__dirname, '..')).replace(/\\/g, '/');
const PORT = parseInt(process.env.HEXIS_PORT || '3001', 10);

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

initGit(REPO_PATH);

// Initialize persistent state store
const stateStore = initStateStore(REPO_PATH);
await stateStore.load();
console.log(`  ✦ State loaded: ${stateStore.getTasks().length} tasks, ${stateStore.getRuns().length} runs`);

// Initialize repo context (AGENTS.md, repo wiki, cached preamble for agents)
await initRepoContext(REPO_PATH);

// SSE clients
const sseClients = new Set();
function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) client.write(msg);
}

function isPathSafe(filePath) {
  const full = resolve(REPO_PATH, filePath);
  return full.startsWith(REPO_PATH.replace(/\//g, '\\')) || full.startsWith(REPO_PATH);
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
    const fullPath = resolve(REPO_PATH, filePath);
    await writeFile(fullPath, content, 'utf-8');
    res.json({ ok: true, path: filePath });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
app.delete('/api/folder', async (req, res) => {
  const { path: folderPath, recursive } = req.query;
  if (!folderPath) return res.status(400).json({ error: 'path required' });
  if (!isPathSafe(folderPath)) return res.status(403).json({ error: 'path outside repo' });
  try {
    const fullPath = resolve(REPO_PATH, folderPath);
    try {
      const trashModule = await import('trash');
      const trash = trashModule.default;
      await trash(fullPath);
    } catch (trashErr) {
      console.warn('[trash] fallback to rm:', trashErr.message);
      const { rm } = await import('fs/promises');
      await rm(fullPath, { recursive: recursive === 'true', force: false });
    }
    res.json({ ok: true, path: folderPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
        model: 'claude-sonnet-4-5',
        fallbackModel: 'claude-sonnet-4-5',
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

  // Update markdown links across the repo
  let updatedLinks = [];
  if (updateLinks) {
    try {
      updatedLinks = await updateMarkdownLinks(REPO_PATH, from, to, getGit());
    } catch (err) {
      // Non-fatal — the move succeeded, link update is best-effort
      console.error('[move] Link update error:', err.message);
    }
  }

  res.json({ ok: true, from, to, updatedLinks });
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

// ─── SSE ───

app.get('/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('data: {"type":"connected"}\n\n');
  // Send full snapshot to new client so it can rebuild its view
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

app.listen(PORT, () => {
  console.log(`\n  ✦ Hexis server running at http://localhost:${PORT}`);
  console.log(`  ✦ Watching: ${REPO_PATH}`);
  console.log(`  ✦ SSE endpoint: http://localhost:${PORT}/events\n`);
});
