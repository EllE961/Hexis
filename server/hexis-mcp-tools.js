/**
 * Hexis-specific MCP tools — first-class tools agents can call directly.
 *
 * These give agents domain-specific operations (run tests, check lint, get
 * project stats, persistent memory, git intel) without having to guess the
 * right `npm run` or `git log` incantation via the Bash tool. More reliable,
 * structured output, and often token-efficient vs shell parsing.
 *
 * Memory model:
 *   - `memory_view(path?)`   — list memories directory or read a file
 *   - `memory_write(path, content)` — overwrite a memory file
 *   - `memory_append(path, content)` — append to a memory file
 *   - `memory_search(query)` — grep-based search across all memories
 *   - `memory_delete(path)`  — delete a memory file
 *
 * Memory is stored per-repo under `<repoPath>/.hexis/memories/`.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { exec as _exec } from 'child_process';
import { promisify } from 'util';
import { mkdir, readFile, writeFile, unlink, readdir, stat } from 'fs/promises';
import { join, relative, resolve, normalize } from 'path';
import { existsSync } from 'fs';
import { jinaFetch, arxivSearch, githubSearch, hnSearch, npmInfo, ddgSearch } from './research-tools.js';

const exec = promisify(_exec);

// ─── Memory store helpers ───

function memoryRoot(repoPath) {
  return join(repoPath, '.hexis', 'memories');
}

/** Validate + resolve a memory path, rejecting traversal outside the root. */
function safeMemoryPath(repoPath, userPath) {
  const root = memoryRoot(repoPath);
  // Normalize — strip leading slashes, resolve ".."
  const clean = normalize(userPath || '').replace(/^([/\\])+/, '');
  const abs = resolve(root, clean);
  if (!abs.startsWith(root)) {
    throw new Error(`Invalid memory path "${userPath}" — must stay within /memories/`);
  }
  return abs;
}

async function ensureMemoryDir(repoPath) {
  await mkdir(memoryRoot(repoPath), { recursive: true });
}

/** Build the MCP server bound to a specific repo path. */
export function buildHexisMcpServer(repoPath) {

  // ═══ Testing ═══
  const runHexisTests = tool(
    'runTests',
    'Run the project test suite. Optionally filter by file path. Returns pass/fail counts and failing test details. Returns a clean "no-tests-configured" status if package.json has no test script instead of erroring.',
    {
      filter: z.string().optional().describe('Optional file path to filter tests'),
    },
    async (args) => {
      // Pre-flight: if there's no test script configured, return a clean
      // status rather than invoking npm and getting a hard error back.
      // This keeps agents from stalling on a task that legitimately has
      // no tests yet.
      try {
        const pkgRaw = await readFile(join(repoPath, 'package.json'), 'utf-8');
        const pkg = JSON.parse(pkgRaw);
        const scripts = pkg.scripts || {};
        const hasTest = scripts.test && scripts.test.trim() &&
                        scripts.test !== 'echo "Error: no test specified" && exit 1';
        if (!hasTest) {
          return {
            content: [{
              type: 'text',
              text: 'No tests configured — package.json has no `test` script. Treat this as "0 tests, all passed" and move on.',
            }],
          };
        }
      } catch {
        // No package.json at all (or unreadable) — same story, no tests.
        return {
          content: [{
            type: 'text',
            text: 'No tests configured — no readable package.json at repo root. Treat this as "0 tests, all passed" and move on.',
          }],
        };
      }

      const cmd = args.filter
        ? `npm test -- --run "${args.filter}"`
        : 'npm test -- --run';
      try {
        const { stdout, stderr } = await exec(cmd, {
          cwd: repoPath,
          timeout: 120000,
          maxBuffer: 5 * 1024 * 1024,
        });
        const out = `${stdout}\n${stderr}`;
        const passMatch = out.match(/(\d+)\s+pass/i);
        const failMatch = out.match(/(\d+)\s+fail/i);
        return {
          content: [{
            type: 'text',
            text: `Tests completed.\nPassing: ${passMatch?.[1] || 'unknown'}\nFailing: ${failMatch?.[1] || '0'}\n\n${out.slice(-3000)}`,
          }],
        };
      } catch (err) {
        // Graceful fallback: if the error output indicates "missing
        // script: test" (can happen if package.json changes between
        // pre-flight and exec), surface it as the clean status too.
        const combined = `${err.stdout || ''}\n${err.stderr || ''}`;
        if (/missing script:\s*(["'])?test\1?/i.test(combined) ||
            /npm error Missing script: "test"/i.test(combined)) {
          return {
            content: [{
              type: 'text',
              text: 'No tests configured — `npm test` reported missing script. Treat this as "0 tests, all passed" and move on.',
            }],
          };
        }
        return {
          content: [{
            type: 'text',
            text: `Tests failed:\n${(err.stdout || '').slice(-3000)}\n${(err.stderr || '').slice(-1000)}`,
          }],
          isError: true,
        };
      }
    },
    { annotations: { title: 'Run project tests' } },
  );

  // ═══ Lint ═══
  const runHexisLint = tool(
    'runLint',
    'Run ESLint on changed files or a specific path. Returns errors/warnings.',
    {
      file: z.string().optional().describe('Optional file to lint (default: all changed files)'),
    },
    async (args) => {
      const cmd = args.file
        ? `npx eslint "${args.file}" 2>&1 || true`
        : 'npx eslint . --max-warnings 0 2>&1 || true';
      try {
        const { stdout } = await exec(cmd, {
          cwd: repoPath,
          timeout: 60000,
          maxBuffer: 2 * 1024 * 1024,
        });
        return {
          content: [{
            type: 'text',
            text: stdout.slice(0, 3000) || 'No lint output (clean).',
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Lint error: ${err.message}` }],
          isError: true,
        };
      }
    },
    { annotations: { title: 'Run linter', readOnlyHint: true } },
  );

  // ═══ Repo stats ═══
  const getRepoStats = tool(
    'getRepoStats',
    'Get high-level stats about this repo: file counts by extension, last 5 commits, current branch.',
    {},
    async () => {
      try {
        const [filesOut, commitsOut, branchOut] = await Promise.all([
          exec('git ls-files', { cwd: repoPath, maxBuffer: 5 * 1024 * 1024 }),
          exec('git log --oneline -5', { cwd: repoPath }),
          exec('git rev-parse --abbrev-ref HEAD', { cwd: repoPath }),
        ]);
        const files = filesOut.stdout.split('\n').filter(Boolean);
        const byExt = {};
        for (const f of files) {
          const ext = f.split('.').pop().toLowerCase();
          byExt[ext] = (byExt[ext] || 0) + 1;
        }
        const topExts = Object.entries(byExt)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([ext, count]) => `  .${ext}: ${count}`)
          .join('\n');
        return {
          content: [{
            type: 'text',
            text: `Branch: ${branchOut.stdout.trim()}\nTotal files: ${files.length}\n\nTop extensions:\n${topExts}\n\nRecent commits:\n${commitsOut.stdout}`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Failed to get stats: ${err.message}` }],
          isError: true,
        };
      }
    },
    { annotations: { title: 'Repo statistics', readOnlyHint: true } },
  );

  // ═══ Git intelligence ═══

  const getGitContext = tool(
    'getGitContext',
    'Get git blame + recent commits touching specific files. Use before editing to understand history and avoid reverting recent fixes.',
    {
      files: z.array(z.string()).describe('File paths to get context for'),
      maxCommits: z.number().optional().describe('Max commits per file (default: 5)'),
    },
    async (args) => {
      const max = args.maxCommits || 5;
      const chunks = [];
      for (const file of args.files.slice(0, 20)) {
        try {
          const { stdout: log } = await exec(
            `git log --oneline -${max} -- "${file}"`,
            { cwd: repoPath, timeout: 10000 }
          );
          if (log.trim()) {
            chunks.push(`## ${file}\n${log.trim()}`);
          } else {
            chunks.push(`## ${file}\n(no history — new file)`);
          }
        } catch (err) {
          chunks.push(`## ${file}\nerror: ${err.message}`);
        }
      }
      return {
        content: [{ type: 'text', text: chunks.join('\n\n').slice(0, 4000) || 'No git context found.' }],
      };
    },
    { annotations: { title: 'Git history for files', readOnlyHint: true } },
  );

  const getGitDiff = tool(
    'getGitDiff',
    'Get the current uncommitted diff for files in the working tree. Used by reviewers to see exactly what the coder changed.',
    {
      files: z.array(z.string()).optional().describe('Optional file filter'),
      staged: z.boolean().optional().describe('Show staged diff instead of unstaged'),
    },
    async (args) => {
      try {
        const stagedFlag = args.staged ? '--cached' : '';
        const fileArgs = args.files?.length ? `-- ${args.files.map(f => `"${f}"`).join(' ')}` : '';
        const { stdout } = await exec(
          `git diff ${stagedFlag} ${fileArgs}`,
          { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 }
        );
        return {
          content: [{
            type: 'text',
            text: stdout.trim() ? stdout.slice(0, 20000) : 'No diff — working tree clean.',
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `git diff error: ${err.message}` }],
          isError: true,
        };
      }
    },
    { annotations: { title: 'Current uncommitted diff', readOnlyHint: true } },
  );

  // ═══ Memory tools (persistent, cross-session) ═══

  const memoryView = tool(
    'memory_view',
    'List the memories directory or read a single memory file. Memory is persisted per-repo under .hexis/memories/ and survives across runs. Call this at the start of every task to recall learned conventions and prior context.',
    {
      path: z.string().optional().describe('Relative path under /memories/. Omit to list root.'),
    },
    async (args) => {
      await ensureMemoryDir(repoPath);
      try {
        if (!args.path || args.path === '' || args.path === '/' || args.path === '.') {
          // List directory
          const entries = await readdir(memoryRoot(repoPath), { withFileTypes: true });
          if (entries.length === 0) {
            return { content: [{ type: 'text', text: '(memory is empty — no prior context)' }] };
          }
          const lines = [];
          for (const entry of entries) {
            const p = join(memoryRoot(repoPath), entry.name);
            if (entry.isDirectory()) {
              lines.push(`📁 ${entry.name}/`);
            } else {
              const s = await stat(p);
              lines.push(`📄 ${entry.name} (${s.size} bytes)`);
            }
          }
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }
        const abs = safeMemoryPath(repoPath, args.path);
        if (!existsSync(abs)) {
          return { content: [{ type: 'text', text: `(not found: ${args.path})` }] };
        }
        const s = await stat(abs);
        if (s.isDirectory()) {
          const entries = await readdir(abs, { withFileTypes: true });
          const lines = entries.map(e => e.isDirectory() ? `📁 ${e.name}/` : `📄 ${e.name}`);
          return { content: [{ type: 'text', text: lines.join('\n') || '(empty directory)' }] };
        }
        const content = await readFile(abs, 'utf8');
        return { content: [{ type: 'text', text: content }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `memory_view error: ${err.message}` }],
          isError: true,
        };
      }
    },
    { annotations: { title: 'View persistent memory', readOnlyHint: true } },
  );

  const memoryWrite = tool(
    'memory_write',
    'Create or overwrite a memory file. Use for structured facts that should survive across sessions — conventions, patterns, gotchas learned during review. Always prefer `memory_append` for logs; use `memory_write` for single-source-of-truth files.',
    {
      path: z.string().describe('Relative path like "learned.md" or "runs/task-123.md"'),
      content: z.string().describe('File content (plain text or markdown preferred)'),
    },
    async (args) => {
      try {
        await ensureMemoryDir(repoPath);
        const abs = safeMemoryPath(repoPath, args.path);
        await mkdir(join(abs, '..'), { recursive: true });
        await writeFile(abs, args.content, 'utf8');
        return {
          content: [{ type: 'text', text: `✓ wrote ${relative(memoryRoot(repoPath), abs)} (${args.content.length} bytes)` }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `memory_write error: ${err.message}` }],
          isError: true,
        };
      }
    },
    { annotations: { title: 'Write persistent memory' } },
  );

  const memoryAppend = tool(
    'memory_append',
    'Append content to a memory file, creating it if missing. Use this for logs, learned conventions accumulating over time, and run history. The appended content gets a date-stamped section header.',
    {
      path: z.string().describe('Relative path like "learned.md"'),
      content: z.string().describe('Content to append'),
      header: z.string().optional().describe('Optional section header (adds markdown ## line)'),
    },
    async (args) => {
      try {
        await ensureMemoryDir(repoPath);
        const abs = safeMemoryPath(repoPath, args.path);
        await mkdir(join(abs, '..'), { recursive: true });
        const stamp = new Date().toISOString().slice(0, 10);
        const header = args.header ? `\n\n## ${stamp} — ${args.header}\n` : `\n\n### ${stamp}\n`;
        const body = header + args.content + '\n';
        const existing = existsSync(abs) ? await readFile(abs, 'utf8') : '';
        await writeFile(abs, existing + body, 'utf8');
        return {
          content: [{ type: 'text', text: `✓ appended to ${relative(memoryRoot(repoPath), abs)}` }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `memory_append error: ${err.message}` }],
          isError: true,
        };
      }
    },
    { annotations: { title: 'Append to persistent memory' } },
  );

  const memorySearch = tool(
    'memory_search',
    'Grep-search across all memory files for a keyword. Returns matching lines with file paths. Use to recall prior decisions quickly.',
    {
      query: z.string().describe('Search term (plain text, case-insensitive)'),
    },
    async (args) => {
      await ensureMemoryDir(repoPath);
      const root = memoryRoot(repoPath);
      const hits = [];
      async function walk(dir) {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          const p = join(dir, e.name);
          if (e.isDirectory()) {
            await walk(p);
          } else {
            try {
              const content = await readFile(p, 'utf8');
              const lower = content.toLowerCase();
              const ql = args.query.toLowerCase();
              if (lower.includes(ql)) {
                const lines = content.split('\n');
                const matchLines = [];
                lines.forEach((line, i) => {
                  if (line.toLowerCase().includes(ql)) {
                    matchLines.push(`  ${i + 1}: ${line.trim().slice(0, 180)}`);
                  }
                });
                hits.push(`## ${relative(root, p)}\n${matchLines.slice(0, 5).join('\n')}`);
              }
            } catch { /* skip unreadable */ }
          }
        }
      }
      try {
        await walk(root);
        return {
          content: [{
            type: 'text',
            text: hits.length
              ? hits.join('\n\n').slice(0, 5000)
              : `(no matches for "${args.query}" in memory)`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `memory_search error: ${err.message}` }],
          isError: true,
        };
      }
    },
    { annotations: { title: 'Search persistent memory', readOnlyHint: true } },
  );

  const memoryDelete = tool(
    'memory_delete',
    'Delete a memory file. Use for stale or incorrect entries.',
    {
      path: z.string().describe('Relative path to delete'),
    },
    async (args) => {
      try {
        const abs = safeMemoryPath(repoPath, args.path);
        if (!existsSync(abs)) {
          return { content: [{ type: 'text', text: `(not found: ${args.path})` }] };
        }
        await unlink(abs);
        return {
          content: [{ type: 'text', text: `✓ deleted ${args.path}` }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `memory_delete error: ${err.message}` }],
          isError: true,
        };
      }
    },
    { annotations: { title: 'Delete memory file' } },
  );

  // ═══ Research tools (web + academic + github + hn + npm) ═══
  // These give the Researcher agents free multi-source lookup without
  // needing any external MCP server install. Every tool is FREE and
  // requires no API key (GitHub optionally uses GITHUB_TOKEN env var).

  const webSearchTool = tool(
    'web_search',
    'Free web search via DuckDuckGo (no API key, unlimited polite use). Returns list of URLs + titles + snippets. This is the PRIMARY tool for discovering sources during research. Follow up with web_fetch on any promising result to actually read the full content.',
    {
      query: z.string().describe('Search query'),
      max: z.number().optional().describe('Max results (default 10, hard cap 20)'),
    },
    async (args) => {
      const r = await ddgSearch(args.query, { max: Math.min(args.max || 10, 20) });
      if (!r.ok) return { content: [{ type: 'text', text: `web_search error: ${r.error}` }], isError: true };
      if (r.data.count === 0) {
        return { content: [{ type: 'text', text: `(no results for "${args.query}" — try different keywords)` }] };
      }
      const text = r.data.results.map((x, i) => (
        `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`
      )).join('\n\n');
      return { content: [{ type: 'text', text: `# Web search: ${args.query}\n(${r.data.count} results)\n\n${text}` }] };
    },
    { annotations: { title: 'Free web search (DuckDuckGo)', readOnlyHint: true } },
  );

  const webFetch = tool(
    'web_fetch',
    'Turn any URL into clean LLM-friendly markdown via Jina Reader. Strips ads/nav/footer and returns just the main content. Use this AFTER web_search to actually read promising results. Free, no API key.',
    {
      url: z.string().describe('Full https:// URL to fetch and clean'),
      maxChars: z.number().optional().describe('Max chars to return (default 20000)'),
    },
    async (args) => {
      const r = await jinaFetch(args.url, { maxChars: args.maxChars || 20000 });
      if (!r.ok) return { content: [{ type: 'text', text: `web_fetch error: ${r.error}` }], isError: true };
      return { content: [{ type: 'text', text: `# ${args.url}\n\n${r.data.content}${r.data.truncated ? '\n\n[… truncated]' : ''}` }] };
    },
    { annotations: { title: 'Clean web page fetch (Jina Reader)', readOnlyHint: true } },
  );

  const arxivSearchTool = tool(
    'arxiv_search',
    'Search arXiv for academic papers. Free, no API key. Use for research topics where you need peer-reviewed or preprint sources.',
    {
      query: z.string().describe('Search query (natural language or field-scoped like "ti:hex grid")'),
      max: z.number().optional().describe('Max results (default 5)'),
    },
    async (args) => {
      const r = await arxivSearch(args.query, { max: args.max || 5 });
      if (!r.ok) return { content: [{ type: 'text', text: `arxiv error: ${r.error}` }], isError: true };
      const text = r.data.papers.map(p => (
        `## ${p.title}\n- Authors: ${p.authors.join(', ')}\n- Published: ${p.published}\n- Updated: ${p.updated}\n- URL: ${p.id}\n- Summary: ${p.summary}`
      )).join('\n\n') || '(no papers found)';
      return { content: [{ type: 'text', text: `# arXiv: ${args.query}\n\n${text}` }] };
    },
    { annotations: { title: 'arXiv paper search', readOnlyHint: true } },
  );

  const githubSearchTool = tool(
    'github_search',
    'Search GitHub for repositories, code, or issues. Free public API (60 req/hr unauthenticated, 5000 with GITHUB_TOKEN). Use the `stars:>N language:X` qualifiers to narrow results. Essential for finding active libraries and community sentiment.',
    {
      query: z.string().describe('Search query. Can include GitHub qualifiers like "stars:>1000 language:typescript"'),
      type: z.enum(['repositories', 'code', 'issues']).optional().describe('What to search (default: repositories)'),
      max: z.number().optional().describe('Max results (default 10)'),
    },
    async (args) => {
      const r = await githubSearch(args.query, { type: args.type || 'repositories', max: args.max || 10 });
      if (!r.ok) return { content: [{ type: 'text', text: `github error: ${r.error}` }], isError: true };
      const items = r.data.items;
      let text;
      if (r.data.type === 'repositories') {
        text = items.map(i => (
          `## ${i.fullName}  (★${i.stars}  forks:${i.forks}  ${i.language || '?'})\n- ${i.description}\n- License: ${i.license || 'none'}  Updated: ${i.updated}\n- Topics: ${i.topics.join(', ') || '—'}\n- ${i.url}`
        )).join('\n\n') || '(no repos)';
      } else if (r.data.type === 'issues') {
        text = items.map(i => (
          `## ${i.title}  [${i.state}] (${i.repository})\n- Comments: ${i.comments}  Created: ${i.created}\n- ${i.url}\n- ${i.body.slice(0, 200)}`
        )).join('\n\n') || '(no issues)';
      } else {
        text = items.map(i => `- ${i.repository} :: ${i.path}\n  ${i.url}`).join('\n') || '(no code results)';
      }
      return { content: [{ type: 'text', text: `# GitHub ${r.data.type}: ${args.query}\n(${r.data.total} total, showing ${r.data.count})\n\n${text}` }] };
    },
    { annotations: { title: 'GitHub search (repos/code/issues)', readOnlyHint: true } },
  );

  const hnSearchTool = tool(
    'hn_search',
    'Search Hacker News via Algolia API. Free, unlimited, no API key. Use for community sentiment, real-world production experience, and to find discussion of libraries/tools.',
    {
      query: z.string().describe('Search query'),
      tag: z.enum(['story', 'comment', 'poll']).optional().describe('What to search (default: story)'),
      max: z.number().optional().describe('Max results (default 10)'),
    },
    async (args) => {
      const r = await hnSearch(args.query, { max: args.max || 10, tag: args.tag || 'story' });
      if (!r.ok) return { content: [{ type: 'text', text: `hn error: ${r.error}` }], isError: true };
      const text = r.data.hits.map(h => (
        `## ${h.title}  (${h.points}pts, ${h.numComments} comments)\n- ${h.created} by ${h.author}\n- Link: ${h.url}\n- HN: ${h.hnUrl}`
      )).join('\n\n') || '(no HN results)';
      return { content: [{ type: 'text', text: `# HN: ${args.query}\n\n${text}` }] };
    },
    { annotations: { title: 'Hacker News search', readOnlyHint: true } },
  );

  const npmInfoTool = tool(
    'npm_info',
    'Get metadata for an npm package: latest version, license, weekly downloads, last publish date, repository URL, maintainer count. Essential for vetting library maturity and detecting abandonment.',
    {
      package: z.string().describe('NPM package name (e.g. "zustand")'),
    },
    async (args) => {
      const r = await npmInfo(args.package);
      if (!r.ok) return { content: [{ type: 'text', text: `npm error: ${r.error}` }], isError: true };
      const d = r.data;
      const text = `# npm: ${d.name}
- Latest version: ${d.latestVersion}
- License: ${d.license || 'unknown'}
- Weekly downloads: ${d.weeklyDownloads?.toLocaleString() || 'unknown'}
- Description: ${d.description}
- Repository: ${d.repository || '—'}
- Homepage: ${d.homepage || '—'}
- Maintainers: ${d.maintainers.join(', ')}
- Created: ${d.created}
- Last publish: ${d.lastPublish}
- Direct dependencies: ${d.depCount}`;
      return { content: [{ type: 'text', text }] };
    },
    { annotations: { title: 'NPM package metadata', readOnlyHint: true } },
  );

  // Research memory — a dedicated space separate from learned.md so reports
  // don't pollute the conventions file. Stored under .hexis/memories/research/
  const researchMemorySave = tool(
    'research_memory_save',
    'Save a completed research report to persistent memory under .hexis/memories/research/{slug}.md so future research runs can reference it via memory_search. Use this at the END of every research run.',
    {
      slug: z.string().describe('Short kebab-case identifier for this research, e.g. "state-management-libs"'),
      content: z.string().describe('Full markdown report'),
    },
    async (args) => {
      try {
        const safeSlug = args.slug.replace(/[^a-z0-9-_]/gi, '-').slice(0, 80).toLowerCase();
        const path = `research/${safeSlug}.md`;
        const abs = safeMemoryPath(repoPath, path);
        await mkdir(join(abs, '..'), { recursive: true });
        await writeFile(abs, args.content, 'utf8');
        return {
          content: [{ type: 'text', text: `✓ saved research to ${path} (${args.content.length} bytes)` }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `research_memory_save error: ${err.message}` }], isError: true };
      }
    },
    { annotations: { title: 'Save research report to memory' } },
  );

  return createSdkMcpServer({
    name: 'hexis',
    version: '2.0.0',
    tools: [
      runHexisTests,
      runHexisLint,
      getRepoStats,
      getGitContext,
      getGitDiff,
      memoryView,
      memoryWrite,
      memoryAppend,
      memorySearch,
      memoryDelete,
      webSearchTool,
      webFetch,
      arxivSearchTool,
      githubSearchTool,
      hnSearchTool,
      npmInfoTool,
      researchMemorySave,
    ],
  });
}
