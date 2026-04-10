/**
 * Repo context — AGENTS.md / CLAUDE.md ingestion + cached repo wiki.
 *
 * Loaded once per server boot, refreshed when git HEAD changes significantly.
 * Injected as a stable cached preamble in every agent's system prompt so the
 * cache prefix is shared across all parallel runs.
 */

import { readFile, writeFile, stat, access } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

let _cache = null;  // { agentsMd, repoWiki, gitSha, repoPath }

function getWikiPath(repoPath) {
  const dir = join(homedir(), '.hexis');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const hash = createHash('sha1').update(repoPath).digest('hex').slice(0, 12);
  return join(dir, `wiki-${hash}.json`);
}

/** Read AGENTS.md (preferred) or CLAUDE.md fallback from repo root. */
async function loadAgentsMd(repoPath) {
  const candidates = ['AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md'];
  for (const name of candidates) {
    try {
      const fullPath = join(repoPath, name);
      await access(fullPath);
      const content = await readFile(fullPath, 'utf-8');
      // Cap at 8KB to keep system prompts cache-friendly
      return content.slice(0, 8192);
    } catch { /* try next */ }
  }
  return null;
}

/** Get current git HEAD sha for cache invalidation. */
async function getGitSha(repoPath) {
  try {
    const { stdout } = await execAsync('git rev-parse HEAD', { cwd: repoPath, timeout: 3000 });
    return stdout.trim();
  } catch {
    return 'no-git';
  }
}

/** Initialize repo context — loads AGENTS.md and repo wiki on server start. */
export async function initRepoContext(repoPath) {
  const agentsMd = await loadAgentsMd(repoPath);
  const gitSha = await getGitSha(repoPath);

  // Try to load cached wiki from disk
  let repoWiki = null;
  try {
    const wikiPath = getWikiPath(repoPath);
    const raw = await readFile(wikiPath, 'utf-8');
    const cached = JSON.parse(raw);
    if (cached.gitSha === gitSha && cached.content) {
      repoWiki = cached.content;
    }
  } catch { /* cache miss */ }

  _cache = { agentsMd, repoWiki, gitSha, repoPath, learnedMd: null };
  // Load learned conventions (separate file, persists across sessions)
  _cache.learnedMd = await loadLearnedMd();

  console.log(`  ✦ Repo context loaded: AGENTS.md=${agentsMd ? 'yes' : 'no'} wiki=${repoWiki ? 'cached' : 'pending'} learned=${_cache.learnedMd ? 'yes' : 'no'}`);

  // If no cached wiki, generate one in the background (non-blocking)
  if (!repoWiki) {
    setImmediate(() => {
      generateRepoWiki(repoPath).catch(err => {
        console.warn('[repo-context] Background wiki generation failed:', err.message);
      });
    });
  }

  return _cache;
}

/**
 * Generate the repo wiki by running a single Sonnet agent that explores the codebase.
 * Runs once on first startup, cached by git HEAD sha.
 * Imported lazily to avoid circular dep with agent-orchestrator.
 */
async function generateRepoWiki(repoPath) {
  console.log('  ✦ Generating repo wiki (one-time, ~30s)...');
  // Lazy import to avoid circular dependency
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.anthropic_api_key;

  const prompt = `Explore this codebase and produce a concise architecture summary. The output will be cached and injected into every future agent's context, so make it dense and useful.

Sections to include:
1. **Project type & stack** (1-2 lines)
2. **Entry points** (main files: server, frontend, CLI — file paths only)
3. **Key directories** (what each top-level dir contains, 1 line each)
4. **Main patterns/conventions** (state management, styling, testing — file path examples)
5. **Build & test commands** (extract from package.json scripts)

Format as markdown. Cap at 1500 words. Use Glob/Grep/Read efficiently — don't read every file.`;

  let wikiContent = '';
  let resultMessage = null;

  try {
    const stream = query({
      prompt,
      options: {
        cwd: repoPath,
        model: 'sonnet',
        effort: 'medium',
        allowedTools: ['Read', 'Glob', 'Grep'],
        permissionMode: 'bypassPermissions',
        maxTurns: 25,
        // No maxBudgetUsd — Hexis runs on subscription, budget is unused.
        env,
        settingSources: ['user', 'project', 'local'],
      },
    });

    for await (const message of stream) {
      if (message.type === 'result') {
        resultMessage = message;
      }
    }

    if (resultMessage && resultMessage.result && !resultMessage.is_error) {
      wikiContent = resultMessage.result;
      await saveRepoWiki(wikiContent);
      console.log(`  ✦ Repo wiki generated (${wikiContent.length} chars, $${(resultMessage.total_cost_usd || 0).toFixed(4)})`);
    }
  } catch (err) {
    console.warn('  ✦ Repo wiki generation error:', err.message);
  }
}

/** Save repo wiki to disk for next boot. */
export async function saveRepoWiki(content) {
  if (!_cache) return;
  _cache.repoWiki = content;
  try {
    const wikiPath = getWikiPath(_cache.repoPath);
    await writeFile(wikiPath, JSON.stringify({
      gitSha: _cache.gitSha,
      content,
      savedAt: Date.now(),
    }, null, 2));
  } catch (err) {
    console.warn('[repo-context] Failed to save wiki:', err.message);
  }
}

// Hard consistency rules every agent in this repo follows.
// This block is identical for every agent so the prompt cache hits across runs.
const CONSISTENCY_BLOCK = `## Cross-agent consistency (REQUIRED for all agents in this repo)

You are part of a multi-agent system where multiple agents may work on this codebase
across separate tasks. Your output MUST be consistent with what other agents produce.

**Style and conventions:**
- Read existing files in the same directory before writing — match their style EXACTLY
- Follow the project conventions documented in AGENTS.md / CLAUDE.md / .hexis/learned.md
- Do not introduce new patterns when an existing pattern works
- Match: indent style, quote style, naming, import order, comment style, error handling

**Code quality gates:**
- Write complete, working code — no TODOs, no placeholders, no "..." stubs
- Validate your work: re-read the file after editing to confirm
- If a linter or test runner is available, use the runLint / runTests MCP tools
- Never commit secrets or credentials

**Output discipline:**
- When following structured output (JSON schema), match it exactly — no extra fields
- Be terse in chat output; verbose in code/comments where needed
- Cite file paths + line numbers when referencing code

**Working with prior tasks:**
- If your prompt mentions "Prior tasks in this chain", read those summaries carefully
- Build on top of what previous agents did — don't redo their work
- If you see decisions in prior tasks (e.g. "we use X for Y"), respect them`;

/**
 * Read learned conventions — unified with the Memory Tool's write location
 * at `<repoPath>/.hexis/memories/learned.md`. The Final Reviewer appends
 * distilled rules there via `mcp__hexis__memory_append`, and this loader
 * injects them into the cached system-prompt preamble on the NEXT run.
 *
 * Falls back to the legacy per-user cache at ~/.hexis/learned-{hash}.md
 * if the new location is empty (for backwards compat).
 */
async function loadLearnedMd() {
  if (!_cache) return null;
  // New canonical location (per-repo, matches memory tool)
  try {
    const projectLearned = join(_cache.repoPath, '.hexis', 'memories', 'learned.md');
    const content = await readFile(projectLearned, 'utf-8');
    return content.slice(0, 4096);
  } catch { /* fall through */ }
  // Legacy fallback
  try {
    const learnedPath = join(homedir(), '.hexis', `learned-${createHash('sha1').update(_cache.repoPath).digest('hex').slice(0, 12)}.md`);
    const content = await readFile(learnedPath, 'utf-8');
    return content.slice(0, 4096);
  } catch { return null; }
}

/**
 * Build the system prompt preamble — stable across all agents in this repo,
 * so the prompt cache hits every time.
 */
export function getRepoPreamble() {
  if (!_cache) return '';
  const parts = [CONSISTENCY_BLOCK];

  if (_cache.agentsMd) {
    parts.push('## Project conventions (AGENTS.md / CLAUDE.md)\n\n' + _cache.agentsMd);
  }
  if (_cache.repoWiki) {
    parts.push('## Repository overview\n\n' + _cache.repoWiki);
  }
  if (_cache.learnedMd) {
    parts.push('## Learned conventions (from prior runs in this repo)\n\n' + _cache.learnedMd);
  }

  return '\n\n' + parts.join('\n\n---\n\n') + '\n\n';
}

/**
 * Append a learned convention to the project memory file.
 *
 * DEPRECATED — the canonical path is now the Memory Tool, called from the
 * Final Reviewer's prompt via `mcp__hexis__memory_append`. This function is
 * kept only as a legacy entry point for code that still calls it.
 */
export async function appendLearnedConvention(text) {
  if (!_cache || !text || !text.trim()) return;
  try {
    // Write to the unified location that the Memory Tool also uses
    const memoriesDir = join(_cache.repoPath, '.hexis', 'memories');
    if (!existsSync(memoriesDir)) mkdirSync(memoriesDir, { recursive: true });
    const learnedPath = join(memoriesDir, 'learned.md');
    let existing = '';
    try { existing = await readFile(learnedPath, 'utf-8'); } catch {}
    const stamp = new Date().toISOString().slice(0, 10);
    const entry = `\n\n### ${stamp}\n${text.trim()}`;
    let combined = existing + entry;
    if (combined.length > 8192) combined = combined.slice(combined.length - 8192);
    await writeFile(learnedPath, combined);
    _cache.learnedMd = combined.slice(-4096);
  } catch (err) {
    console.warn('[repo-context] Failed to append learned convention:', err.message);
  }
}

export function getRepoContext() {
  return _cache;
}
