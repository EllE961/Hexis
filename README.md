# ⬡ Hexis

**AI-native honeycomb IDE** — every file is a hex cell, every folder is a territory, AI agents are bees.

## Features

### Hex Grid Canvas
- Direct Canvas2D rendering with pan/zoom/culling
- 5 semantic zoom levels: satellite → region → city → street → interior
- Warm honeycomb visual style with section-colored territories
- Velocity-based zoom with exponential ease-out — immediate pan, cursor-anchored zoom, no bounce

### Code Editor
- CodeMirror 6 with 35+ language support
- Multi-tab editor with context menu (close, close others, close to right)
- Auto-save with dirty state tracking
- Honey-themed syntax highlighting

### Dock System
- Panels (Editor + embedded file tree, AI, Chat, Git, Search, Bookmarks, Local History, Terminal, Timeline, Tasks) dock to left/right/bottom or float freely
- Drag any panel header to reposition; snap zones highlight the target edge with a live amber preview
- Per-panel collapse, maximize, and close controls in the header
- Size and position persisted in `panelStore` across sessions
- Editor panel hosts a collapsible VS Code–style file tree sidebar (Ctrl+Shift+E)

### Git Integration
- Branch management: create, checkout, delete, merge
- Staging: stage/unstage individual files or all
- Commit with amend support
- Push/Pull with ahead/behind indicators
- Stash: push, pop, list
- "Ship It" one-click: stage all → commit → push
- Blame, revert, reset
- Visual diff overlay on hex grid
- Commit history timeline (Ctrl+T)

### AI Agents (Claude Integration)
- Task pipeline: Writer → Plan → Code → (Test loop) → Multi-persona Review (correctness / security / style) → Self-critique
- Per-role model routing via `server/agent-profiles.js` — Haiku for Writer, Sonnet/Opus for Plan / Code / Review
- Up to 3 concurrent pipelines with per-run event tagging and unique agent IDs
- Smart Writer skip when prompt is already specific; smart Reviewer skip when nothing changed
- Session resume on review-fix loop for 50–80% input-token savings
- Opt-in git worktree isolation per run via `server/worktree-manager.js`
- Server-side task + agent-run persistence with crash recovery via `server/state-store.js` (`~/.hexis/state-{hash}.json`)
- AGENTS.md / CLAUDE.md repo-context ingestion via `server/repo-context.js`
- In-process MCP tools exposed to agents (runTests, runLint, getRepoStats) via `server/hexis-mcp-tools.js` — distinct from the standalone `mcp-server.js`
- Animated bee agents with Bezier flight paths
- Pollen trails showing data flow
- Real-time cell visualization (reading = blue, editing = teal) driven by actual tool call events, not guesses
- Streaming output with token/cost tracking; multi-turn sessions with resume and budget/turn limits
- Structured JSON output via per-stage schemas (plan, review, task-writer)
- Subscription auth by default (OAuth via Claude Code CLI, no API key required)

### More
- **Command Palette** (Ctrl+K) — fuzzy search files, commands, branches
- **Terminal** (Ctrl+`) — integrated shell
- **Task Board** (Ctrl+B) — kanban: todo, in progress, done
- **Test Runner** — detect framework, run tests, show pass/fail
- **Onboarding** — 5-step first-launch tutorial
- **MCP Server** — standalone `node mcp-server.js` process that exposes the doc graph to Claude Code as MCP tools (search, health, git status, orphans, stale nodes); register under `mcpServers` in `.claude/settings.local.json`

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+O` | Open folder (native picker) |
| `Ctrl+K` | Command palette |
| `Ctrl+Shift+E` | Toggle file tree explorer |
| `Ctrl+Shift+L` | Re-optimize hex layout |
| `Ctrl+I` | AI agents panel |
| `Ctrl+G` | Git panel |
| `Ctrl+T` | History timeline |
| `Ctrl+B` | Task board |
| `` Ctrl+` `` | Terminal |
| `Ctrl+S` | Save file |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo file operations |
| `Escape` | Deselect / close |

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Web dev mode — Express server + Vite client (via concurrently)
npm run dev

# 3. CLI — run on a target directory (defaults to cwd), optional --port flag
npm start
node cli.js /path/to/your/project
node cli.js /path/to/your/project --port 3001

# 4. Native desktop app via Tauri 2.0
npm run tauri:dev

# 5. Run the test suite (Vitest)
npm test
```

After `npm link` or global install, the `hexis` command is available on PATH.

## Using Hexis on your project

Hexis is a standalone IDE — you don't need to fork it or copy files into
your project. Install once, then open any folder:

```bash
# Tauri desktop app (recommended for day-to-day use)
npm run tauri:build                    # produces a .exe / .dmg / .AppImage
# then launch it and click File → Open Folder (or Ctrl+O) to pick any project

# CLI — pass the target directory as an argument
hexis /path/to/your/project
node cli.js /path/to/your/project

# Environment variable — handy for scripts and launchers
HEXIS_TARGET=/path/to/your/project npm run dev
```

Inside each project you open, Hexis creates a `.hexis/` folder for its
runtime state. Most of what lives there is regenerated on demand — add
this block to **your project's `.gitignore`**:

```gitignore
# ─── Hexis IDE runtime artifacts ───
.hexis/layout.json            # hex grid group positions cache
.hexis/state-*.json           # per-agent-run state snapshots
.hexis/memories/research/     # generated per-run research reports
.hexis/memories/runs/         # episodic memory per run
```

The one file worth committing is `.hexis/memories/learned.md` — a
distilled set of conventions that review agents accumulate as they work
on your codebase. It's project content, not runtime junk.

Everything Hexis stores is per-workspace: bookmarks, local history,
task board, hex layout, and undo history are all keyed by the folder
path so opening a different project gives you a clean slate.

## Architecture

- **Frontend**: React 18 + Zustand + Canvas2D + CodeMirror 6
- **Backend**: Express + simple-git + Claude Agent SDK, with per-run state persistence (SQLite-free JSON journal at ~/.hexis/state-{hash}.json), optional git-worktree isolation, and in-process MCP tools for agents
- **Desktop**: Tauri 2.0 + Rust (SQLite via rusqlite)

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Rendering | Canvas2D, custom hex math |
| UI | React 18, Tailwind CSS |
| State | Zustand |
| Editor | CodeMirror 6 |
| Git | simple-git (Express backend) |
| AI | @anthropic-ai/claude-agent-sdk (streaming agents, structured output) |
| MCP | @modelcontextprotocol/sdk (standalone mcp-server.js + in-process agent tools) |
| Desktop | Tauri 2.0 |
| Database | SQLite (WAL mode) |
| Testing | Vitest |

## License

MIT
