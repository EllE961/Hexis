/**
 * Agent Orchestrator — Hexis multi-agent pipeline v3 (Tier 1-3 upgrade).
 *
 * Pipeline:
 *   Writer → Intent Classifier → [read-only analyst]  OR
 *   Writer → Planner (Opus adaptive) → Coder(s) in parallel groups
 *         → 3× persona reviewers (correctness/security/style, Sonnet)
 *         → Final merger reviewer (Opus adaptive, structured JSON)
 *         → (optional) review-fix loop with full diff
 *         → Semantic memory write (Reviewer appends learned conventions)
 *
 * Upgrades in this version:
 *   ✓ Dead profiles removed (plan_refiner, reviewer_merger, self_critic)
 *   ✓ Haiku intent classifier replaces the fragile regex
 *   ✓ `settingSources: ['user', 'project', 'local']` on every call
 *   ✓ Role-specific `allowedTools` (Writer/Classifier: none; Planner: read-only;
 *     Coder: full; Reviewers: read-only + git/memory MCP tools)
 *   ✓ `permissionMode: 'plan'` for all read-only roles (SDK-enforced)
 *   ✓ `thinking: { type: 'adaptive' }` on Opus roles (Planner, Final Reviewer)
 *   ✓ `fallbackModel: 'sonnet'` on every Opus call (overload safety)
 *   ✓ SDK hooks: PreToolUse blocks protected files; PostToolUse accumulates
 *     diff; SessionStart injects git history
 *   ✓ DiffTracker shared across the run → final reviewer sees full changeset
 *   ✓ Full-context review-fix loop (passes diff + rubric to Coder resume)
 *   ✓ Real Opus final reviewer merges 3 persona outputs (structured JSON)
 *   ✓ Semantic memory write: Reviewer distills learned conventions at end
 *   ✓ Task dependencies in plan schema (dependsOn: [subtaskId])
 *   ✓ Topological scheduler respects task deps, not just file overlap
 *   ✓ Persona prompts modeled on VoltAgent code-reviewer/security-auditor/
 *     performance-engineer templates (expanded, rubric-style)
 *   ✓ Session resume Planner → Coder (shared cached reads)
 *
 * Subscription auth: strips ANTHROPIC_API_KEY so CLI uses OAuth.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { exec as _exec } from 'child_process';
import { promisify } from 'util';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { getStateStore } from './state-store.js';
import { getProfile } from './agent-profiles.js';
import { getRepoPreamble, getRepoContext } from './repo-context.js';
import { buildHexisMcpServer } from './hexis-mcp-tools.js';
import { buildHooks, createDiffTracker, DEFAULT_PROTECTED } from './agent-hooks.js';
import { createWorktree, destroyWorktree, applyWorktreeChanges } from './worktree-manager.js';

const execAsync = promisify(_exec);

// Active tasks (taskId → { aborted, sessions, approvalResolve, worktreePath, diffTracker })
const activeTasks = new Map();

// Strip API key to force subscription auth
function cleanEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.anthropic_api_key;
  return env;
}

// ─── Schemas ───

/**
 * Plan schema — now includes `dependsOn: [subtaskId]` so the scheduler can
 * respect logical dependencies in addition to file-overlap conflicts.
 */
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Brief description of the overall plan' },
    subtasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Stable id like "st-1", "st-2"' },
          title: { type: 'string' },
          description: { type: 'string' },
          files: { type: 'array', items: { type: 'string' }, description: 'Files this subtask will touch' },
          action: { type: 'string', enum: ['create', 'modify', 'delete', 'refactor'] },
          dependsOn: {
            type: 'array',
            items: { type: 'string' },
            description: 'IDs of subtasks that must complete before this one can start. Leave empty if none.',
          },
        },
        required: ['id', 'title', 'description', 'files', 'dependsOn'],
      },
    },
  },
  required: ['summary', 'subtasks'],
};

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    approved: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    summary: { type: 'string' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          file: { type: 'string' },
          line: { type: 'number' },
          description: { type: 'string' },
          suggestion: { type: 'string' },
        },
        required: ['severity', 'description'],
      },
    },
  },
  required: ['approved', 'confidence', 'summary', 'issues'],
};

const MERGED_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    approved: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    summary: { type: 'string', description: 'One-paragraph overall verdict' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          file: { type: 'string' },
          line: { type: 'number' },
          description: { type: 'string' },
          suggestion: { type: 'string' },
          personas: { type: 'array', items: { type: 'string' } },
        },
        required: ['severity', 'description'],
      },
    },
    learnedConventions: {
      type: 'array',
      items: { type: 'string' },
      description: '1–3 concise rules distilled from this review that should apply to future work. Appended to project memory.',
    },
  },
  required: ['approved', 'confidence', 'summary', 'issues', 'learnedConventions'],
};

const TASK_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short, action-oriented title (max 80 chars)' },
    description: { type: 'string', description: 'Detailed description with context, requirements, and acceptance criteria' },
    files: { type: 'array', items: { type: 'string' }, description: 'Relevant file paths the task will likely touch' },
    priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    scope: { type: 'string', enum: ['small', 'medium', 'large'] },
  },
  required: ['title', 'description', 'files', 'priority', 'scope'],
};

const INTENT_SCHEMA = {
  type: 'object',
  properties: {
    intent: {
      type: 'string',
      enum: ['readonly', 'edit', 'trivial_edit'],
      description: 'readonly = just inspect/explain, edit = normal modify, trivial_edit = rename/small tweak, skip the heavy pipeline',
    },
    reasoning: { type: 'string' },
  },
  required: ['intent', 'reasoning'],
};

// ─── Research pipeline schemas ───

const RESEARCH_PLAN_SCHEMA = {
  type: 'object',
  properties: {
    slug: { type: 'string', description: 'Short kebab-case identifier, e.g. "state-mgmt-libs"' },
    summary: { type: 'string', description: 'One-line restatement of what we are researching' },
    subQuestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          question: { type: 'string' },
          preferredTools: {
            type: 'array',
            items: { type: 'string' },
            description: 'e.g. ["WebSearch", "github_search", "hn_search", "npm_info"]',
          },
        },
        required: ['id', 'question', 'preferredTools'],
      },
    },
    rubric: {
      type: 'array',
      items: { type: 'string' },
      description: 'Criteria to score options against (e.g. Quality, Hexis fit, License, Maturity, Maintenance, Integration, Gotchas)',
    },
    hexisContext: {
      type: 'string',
      description: 'Summary of Hexis stack + constraints extracted from package.json / CLAUDE.md / learned.md',
    },
  },
  required: ['slug', 'summary', 'subQuestions', 'rubric', 'hexisContext'],
};

const WORKER_FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    subQuestionId: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string', description: 'The factual statement' },
          sourceUrl: { type: 'string' },
          sourceTitle: { type: 'string' },
          excerpt: { type: 'string', description: 'Verbatim quote supporting the claim (<200 chars)' },
          publishedDate: { type: 'string', description: 'ISO date if known, else empty string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['claim', 'sourceUrl', 'excerpt', 'confidence'],
      },
    },
    candidateOptions: {
      type: 'array',
      description: 'Options/libraries/approaches discovered while answering this sub-question',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          url: { type: 'string' },
          oneLiner: { type: 'string' },
        },
        required: ['name'],
      },
    },
  },
  required: ['subQuestionId', 'findings', 'candidateOptions'],
};

const INTERIM_RANKING_SCHEMA = {
  type: 'object',
  properties: {
    rubricUsed: { type: 'array', items: { type: 'string' } },
    topPick: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        url: { type: 'string' },
        totalScore: { type: 'number' },
        scores: {
          type: 'object',
          description: 'Map of criterion name → 1-5 score',
          additionalProperties: { type: 'number' },
        },
        whyItWins: { type: 'string' },
      },
      required: ['name', 'totalScore', 'scores', 'whyItWins'],
    },
    shortlist: {
      type: 'array',
      minItems: 2,
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          rank: { type: 'number' },
          name: { type: 'string' },
          url: { type: 'string' },
          scores: {
            type: 'object',
            additionalProperties: { type: 'number' },
          },
          totalScore: { type: 'number' },
          oneLiner: { type: 'string' },
        },
        required: ['rank', 'name', 'scores', 'totalScore', 'oneLiner'],
      },
    },
    notes: { type: 'string', description: 'Anything the lead wants to flag for the critic' },
  },
  required: ['topPick', 'shortlist', 'rubricUsed'],
};

const CRITIC_SCHEMA = {
  type: 'object',
  properties: {
    topPickName: { type: 'string' },
    counterArguments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          concern: { type: 'string' },
          severity: { type: 'string', enum: ['dealbreaker', 'major', 'minor'] },
          evidence: { type: 'string', description: 'Source URL or reasoning' },
        },
        required: ['concern', 'severity'],
      },
    },
    revisedConfidence: { type: 'number', minimum: 0, maximum: 1 },
    shouldReRank: { type: 'boolean' },
    betterAlternative: { type: 'string', description: 'If shouldReRank is true, name of the better option' },
  },
  required: ['topPickName', 'counterArguments', 'revisedConfidence', 'shouldReRank'],
};

const FINAL_REPORT_SCHEMA = {
  type: 'object',
  properties: {
    slug: { type: 'string' },
    verdict: {
      type: 'object',
      properties: {
        recommendation: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        oneLineRationale: { type: 'string' },
      },
      required: ['recommendation', 'confidence', 'oneLineRationale'],
    },
    shortlist: {
      type: 'array',
      minItems: 2,
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          rank: { type: 'number' },
          name: { type: 'string' },
          scores: {
            type: 'object',
            description: 'Map of criterion name → 1-5 score',
            additionalProperties: { type: 'number' },
          },
          totalScore: { type: 'number' },
          whyItWins: { type: 'string' },
          whenNotToPick: { type: 'string' },
          url: { type: 'string' },
        },
        required: ['rank', 'name', 'scores', 'totalScore', 'whyItWins'],
      },
    },
    adversarialFindings: { type: 'string' },
    crossVerification: {
      type: 'object',
      properties: {
        crossVerifiedCount: { type: 'number' },
        unverifiedCount: { type: 'number' },
        contradictionCount: { type: 'number' },
      },
      required: ['crossVerifiedCount', 'unverifiedCount', 'contradictionCount'],
    },
    openQuestions: { type: 'array', items: { type: 'string' } },
    nextSteps: {
      type: 'array',
      description: '3-5 concrete actionable next steps, each suitable as a task board entry',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        },
        required: ['title', 'description'],
      },
    },
    references: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          url: { type: 'string' },
          title: { type: 'string' },
          accessed: { type: 'string' },
        },
        required: ['id', 'url', 'title'],
      },
    },
    fullMarkdown: { type: 'string', description: 'The full human-readable markdown report that gets saved to research memory' },
  },
  required: ['slug', 'verdict', 'shortlist', 'adversarialFindings', 'crossVerification', 'openQuestions', 'nextSteps', 'references', 'fullMarkdown'],
};

// ─── Tool sets per role ───

// Serena tools — all tools exposed by the Serena MCP server. We don't name each
// one (Serena has ~20) — the Agent SDK accepts glob patterns, so `mcp__serena__*`
// allows all of them. If HEXIS_DISABLE_SERENA=1 at runtime, these are no-ops.
const SERENA_TOOLS = ['mcp__serena__*'];

// Research toolkit — free multi-source lookup. `web_search` (DuckDuckGo) is
// the PRIMARY discovery tool; `web_fetch` (Jina Reader) reads pages; the
// specialized tools (arxiv, github, hn, npm) replace a single web search
// when you need structured metadata. All free, no API keys.
// Note: `WebSearch` is NOT in @anthropic-ai/claude-agent-sdk v0.2.98 — only
// `WebFetch` is a native tool. We use our own `mcp__hexis__web_search` instead.
const RESEARCH_TOOLS = [
  'WebFetch',  // SDK-native, works as a secondary fallback
  'Read', 'Glob', 'Grep',
  'mcp__hexis__web_search',
  'mcp__hexis__web_fetch',
  'mcp__hexis__arxiv_search',
  'mcp__hexis__github_search',
  'mcp__hexis__hn_search',
  'mcp__hexis__npm_info',
  'mcp__hexis__getRepoStats',
  'mcp__hexis__getGitContext',
  'mcp__hexis__memory_view',
  'mcp__hexis__memory_search',
  'mcp__hexis__memory_append',
  'mcp__hexis__research_memory_save',
];

// Full edit toolkit for Coder
const CODER_TOOLS = [
  'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
  'NotebookEdit', 'TodoWrite', 'Task',
  'mcp__hexis__runTests',
  'mcp__hexis__runLint',
  'mcp__hexis__getRepoStats',
  'mcp__hexis__getGitContext',
  'mcp__hexis__getGitDiff',
  'mcp__hexis__memory_view',
  'mcp__hexis__memory_search',
  'mcp__hexis__memory_append',
  ...SERENA_TOOLS,
];

// Read-only toolkit for Planner
const READ_TOOLS = [
  'Read', 'Glob', 'Grep', 'Bash', 'TodoWrite', 'Task',
  'mcp__hexis__getRepoStats',
  'mcp__hexis__getGitContext',
  'mcp__hexis__getGitDiff',
  'mcp__hexis__memory_view',
  'mcp__hexis__memory_search',
  ...SERENA_TOOLS,
];

// Reviewer toolkit — read + write to memory (for semantic learning loop)
const REVIEWER_TOOLS = [
  'Read', 'Glob', 'Grep', 'Bash',
  'mcp__hexis__getGitDiff',
  'mcp__hexis__getGitContext',
  'mcp__hexis__memory_view',
  'mcp__hexis__memory_search',
  'mcp__hexis__memory_append',
  ...SERENA_TOOLS,
];

// Zero-tool roles (Classifier, etc.)
const NO_TOOLS = [];

// ─── Public API: Writer ───

function isPromptAlreadySpecific(prompt) {
  if (!prompt || prompt.length < 30) return false;
  const filePattern = /\b[\w./-]+\.(jsx?|tsx?|mjs|cjs|py|rs|go|java|c|cpp|h|hpp|cs|rb|php|swift|html|css|scss|less|json|yaml|yml|toml|xml|md|sql|sh)\b/gi;
  if (!(prompt.match(filePattern) || []).length) return false;
  const actionPattern = /\b(add|fix|remove|update|create|delete|rename|refactor|implement|change|modify|replace|append|prepend)\b/i;
  return actionPattern.test(prompt);
}

function refineTaskLocally(rawPrompt) {
  const filePattern = /\b[\w./-]+\.(jsx?|tsx?|mjs|cjs|py|rs|go|java|c|cpp|h|hpp|cs|rb|php|swift|html|css|scss|less|json|yaml|yml|toml|xml|md|sql|sh)\b/gi;
  const files = [...new Set(rawPrompt.match(filePattern) || [])];
  const firstLine = rawPrompt.split(/[\n.]/, 1)[0].trim();
  const title = firstLine.length > 80 ? firstLine.slice(0, 77) + '…' : firstLine;
  return { title, description: rawPrompt, files, priority: 'medium', scope: files.length <= 2 ? 'small' : 'medium' };
}

export async function writeTask(rawPrompt, repoPath, broadcast) {
  if (isPromptAlreadySpecific(rawPrompt)) {
    const refined = refineTaskLocally(rawPrompt);
    broadcast({ type: 'task_written', task: refined, rawPrompt, skippedWriter: true });
    return refined;
  }

  const task = { aborted: false, sessions: [] };
  const writerId = `writer-${Date.now()}`;
  const profile = getProfile('writer');

  broadcast({ type: 'agent_spawned', agentId: writerId, role: 'writer', model: profile.model, subtaskId: null });

  try {
    // Writer is a pure prompt-structuring pass — no tools, no Serena, no hooks.
    // It should complete in ONE model turn (~1-2s with Haiku). The Planner will
    // do the real file exploration later; Writer just needs to parse intent and
    // emit the structured TASK_SCHEMA.
    const result = await runAgent({
      prompt: `Raw user input:\n\n"""\n${rawPrompt}\n"""\n\nParse this into the structured JSON schema. Guess likely file paths based on keywords in the input — the Planner will verify them later. Emit the JSON on your first response. No tool calls needed.`,
      cwd: repoPath,
      systemPrompt: `You are a task parser. Take rough user input and emit structured JSON.

RULES:
- Respond with the JSON on your FIRST turn — do NOT call tools
- Title: short imperative phrase under 80 chars
- Description: clarify intent, requirements, acceptance criteria — stay faithful to what the user actually asked for. Do NOT restate the title as the first sentence of the description — the frontend concatenates title and description before sending them to the Planner, so a repeated title appears twice in the final prompt. Start the description with the reasoning/details, not the title.
- Files: best-guess list of likely file paths based on keywords. Empty array is fine if you can't tell.
- Priority: critical | high | medium | low — default to medium
- Scope: small | medium | large — infer from breadth of changes implied`,
      tools: NO_TOOLS,               // no exploration — emit JSON immediately
      permissionMode: 'plan',
      schema: TASK_SCHEMA,
      lightweight: true,             // skip Serena + hooks (huge startup savings)
      ...profile,
      maxTurns: 2,                   // override profile — one real turn is enough
    }, task, broadcast, writerId);

    const refined = result.structured || refineTaskLocally(rawPrompt);

    broadcast({ type: 'agent_complete', agentId: writerId, tokensUsed: result.tokens.output, summary: `Refined: ${refined.title}` });
    broadcast({ type: 'task_written', task: refined, rawPrompt });
    return refined;
  } catch (err) {
    console.warn('[writer] LLM refine failed, falling back to local:', err.message);
    const fallback = refineTaskLocally(rawPrompt);
    broadcast({ type: 'agent_complete', agentId: writerId, tokensUsed: 0, summary: `Refined locally (writer failed): ${fallback.title}` });
    broadcast({ type: 'task_written', task: fallback, rawPrompt, fallback: true });
    return fallback;
  }
}

// ─── Public API: Run lifecycle ───

/**
 * Haiku intent classifier — replaces the fragile regex `detectTaskIntent`.
 * Returns 'readonly' | 'edit' | 'trivial_edit' in a single short Haiku call.
 * Falls back to 'edit' on any error (safe default).
 */
async function classifyTaskIntent(prompt, repoPath, broadcast, task) {
  const profile = getProfile('classifier');
  const classifierId = `classifier-${Date.now().toString(36)}`;
  try {
    const result = await runAgent({
      prompt: `Classify this task by what the user wants:

"""
${prompt.slice(0, 2000)}
"""

Rules:
- "readonly" — user is asking a question, wants an explanation, review, summary, or analysis. No file edits requested.
- "trivial_edit" — simple rename, single-line fix, typo, small config tweak. Does NOT need a plan/review pipeline.
- "edit" — a real change requiring planning and review (features, refactors, bug fixes).

Output JSON with 'intent' and 'reasoning'.`,
      cwd: repoPath,
      systemPrompt: 'You are an intent classifier. Output structured JSON only.',
      tools: NO_TOOLS,
      permissionMode: 'plan',
      schema: INTENT_SCHEMA,
      silent: true,
      lightweight: true,  // skip Serena + hooks — classifier is zero-tool
      ...profile,
    }, task, broadcast, classifierId);
    const intent = result.structured?.intent;
    if (['readonly', 'edit', 'trivial_edit'].includes(intent)) return intent;
    return 'edit';
  } catch (err) {
    console.warn('[classifier] failed, defaulting to edit:', err.message);
    return 'edit';
  }
}

export async function startTask(taskId, prompt, repoPath, broadcast, focusFiles, opts = {}) {
  const task = {
    aborted: false,
    sessions: [],
    approvalResolve: null,
    worktreePath: null,
    diffTracker: createDiffTracker(),
  };
  activeTasks.set(taskId, task);

  // Persist run start
  let store = null;
  try { store = getStateStore(); } catch {}
  store?.createRun({
    id: taskId, prompt, status: 'planning',
    startedAt: Date.now(), focusFiles: focusFiles || [],
  });

  const taggedBroadcast = (event) => {
    const tagged = { ...event, runId: taskId };
    if (store) {
      try { store.journalEvent(taskId, tagged); } catch {}
      if (event.type === 'plan_ready') {
        store.updateRun(taskId, { status: 'executing', plan: event.plan, subtasks: event.subtasks });
      } else if (event.type === 'task_review') {
        store.updateRun(taskId, { status: 'reviewing', review: event.review });
      } else if (event.type === 'task_complete') {
        store.updateRun(taskId, { status: 'done', tokensUsed: event.tokensUsed, cost: event.cost, completedAt: Date.now() });
      } else if (event.type === 'agent_error' && event.agentId?.endsWith('::orchestrator')) {
        store.updateRun(taskId, { status: 'error', error: event.error });
      } else if (event.type === 'tokens_update') {
        store.updateRun(taskId, { tokensUsed: event.total, cost: event.cost, cacheHits: event.cacheHits });
      }
    }
    broadcast(tagged);
  };

  // Worktree is opt-in (off by default to avoid stale-worktree conflicts)
  let workCwd = repoPath;
  if (opts.useWorktree === true) {
    const worktree = await createWorktree(taskId, repoPath);
    if (worktree.isolated) {
      task.worktreePath = worktree.path;
      workCwd = worktree.path;
      taggedBroadcast({ type: 'worktree_created', path: workCwd });
    }
  }

  // Classify intent via Haiku (replaces fragile regex detection)
  const intent = opts.intent || await classifyTaskIntent(prompt, workCwd, taggedBroadcast, task);
  taggedBroadcast({ type: 'agent_stream', text: `\n[intent: ${intent}]\n` });

  // Read-only → skip full pipeline, run analyst
  if (intent === 'readonly') {
    runReadOnlyTask(taskId, prompt, workCwd, taggedBroadcast, task, focusFiles)
      .catch(err => {
        if (!task.aborted) {
          taggedBroadcast({ type: 'agent_error', agentId: `${taskId}::orchestrator`, error: err.message });
        }
      })
      .finally(() => { activeTasks.delete(taskId); });
    return;
  }

  let pipelineSucceeded = false;
  runPipeline(taskId, prompt, workCwd, taggedBroadcast, task, focusFiles, repoPath, intent)
    .then(() => { pipelineSucceeded = true; })
    .catch(err => {
      if (!task.aborted) {
        taggedBroadcast({ type: 'agent_error', agentId: `${taskId}::orchestrator`, error: err.message });
      }
    })
    .finally(async () => {
      activeTasks.delete(taskId);
      if (task.worktreePath && pipelineSucceeded && !task.aborted) {
        try {
          const result = await applyWorktreeChanges(task.worktreePath, repoPath);
          if (result.applied) {
            taggedBroadcast({ type: 'worktree_merged', path: task.worktreePath, empty: result.empty });
          } else if (result.conflict) {
            taggedBroadcast({
              type: 'worktree_merge_conflict',
              path: task.worktreePath,
              error: result.error,
              diff: result.diff?.slice(0, 2000),
            });
          } else {
            taggedBroadcast({ type: 'worktree_merge_failed', error: result.error });
          }
        } catch (err) {
          taggedBroadcast({ type: 'worktree_merge_failed', error: err.message });
        }
      }
      if (task.worktreePath) {
        try { await destroyWorktree(taskId, repoPath); } catch {}
      }
    });
}

export function cancelTask(taskId) {
  const task = activeTasks.get(taskId);
  if (task) {
    task.aborted = true;
    if (task.approvalResolve) {
      task.approvalResolve('cancelled');
      task.approvalResolve = null;
    }
    for (const session of task.sessions) {
      try { session.close(); } catch {}
    }
  }
  activeTasks.delete(taskId);
}

export function approveTask(taskId) {
  const task = activeTasks.get(taskId);
  if (task?.approvalResolve) {
    task.approvalResolve('approved');
    task.approvalResolve = null;
  }
}

export async function resumeTaskFn(taskId, additionalPrompt, repoPath, broadcast) {
  let store = null;
  try { store = getStateStore(); } catch {}
  const priorRun = store?.getRun(taskId);
  if (!priorRun) {
    broadcast({ type: 'agent_error', agentId: `${taskId}::orchestrator`, error: 'Cannot resume — run not found', runId: taskId });
    return;
  }
  let sessionId = null;
  for (let i = (priorRun.events || []).length - 1; i >= 0; i--) {
    const ev = priorRun.events[i];
    if (ev.session_id) { sessionId = ev.session_id; break; }
  }
  const newPrompt = additionalPrompt || 'Continue from where you left off.';
  startTask(taskId, newPrompt, repoPath, broadcast, priorRun.focusFiles || [], { resumeSessionId: sessionId });
}

// ═══════════════════════════════════════════════════════════════════════
// CHAT MODE — direct conversational agent, no pipeline
// ═══════════════════════════════════════════════════════════════════════
//
// Chat mode is "Claude Code directly, inside Hexis". One `runAgent` call per
// user turn. Each turn resumes the previous SDK session via `resume:`, so
// context accumulates like a real conversation. No Writer, no Classifier,
// no Planner, no Reviewer — just a single agent with full tools, hooks,
// memory, skills, and Serena.
//
// The caller (the Chat panel) maintains:
//   - chatId   — stable across the whole conversation (UI grouping)
//   - sessionId — SDK session_id from the previous response; null on first turn
//
// Each call returns:
//   - sessionId — the NEW session_id to pass back on the next turn
//   - text      — the assistant's reply
//   - tokens    — per-turn usage
//   - cost      — per-turn cost

// Per-chat task state. Keyed by chatId so concurrent chats don't collide.
// Each entry tracks aborted flag + session list (for cancellation) so the
// Chat panel can hit a Stop button mid-turn.
const chatTasks = new Map();

/**
 * Send a user message in a chat conversation and stream the assistant's
 * response. Single runAgent call. Reuses the caller-supplied session id
 * when present; starts a fresh session on first turn.
 */
export async function chatMessage(chatId, userMessage, repoPath, broadcast, opts = {}) {
  if (!userMessage?.trim()) return;

  // Reuse or create the per-chat task container so we can abort mid-turn.
  let task = chatTasks.get(chatId);
  if (!task || task.done) {
    task = {
      aborted: false,
      sessions: [],
      approvalResolve: null,
      worktreePath: null,
      diffTracker: createDiffTracker(),
    };
    chatTasks.set(chatId, task);
  }
  task.aborted = false;
  task.done = false;

  const modelHint = opts.model === 'opus' ? 'chat_opus' : 'chat';
  const profile = getProfile(modelHint);
  const agentId = `${chatId}::chat`;
  const resumeSessionId = opts.sessionId || null;

  const taggedBroadcast = (event) => {
    broadcast({ ...event, chatId, runId: chatId });
  };

  taggedBroadcast({
    type: 'chat_turn_started',
    userMessage,
    model: profile.model,
    resuming: !!resumeSessionId,
  });
  taggedBroadcast({ type: 'agent_spawned', agentId, role: 'coder', model: profile.model });

  try {
    const result = await runAgent({
      prompt: userMessage,
      cwd: repoPath,
      // No custom systemPrompt — let the Claude Code preset + settingSources
      // (which loads .claude/CLAUDE.md and the skills) provide the agent's
      // persona. This is the closest thing to `claude` CLI behavior.
      systemPrompt: '',
      tools: CODER_TOOLS,
      permissionMode: 'bypassPermissions',
      resume: resumeSessionId || undefined,
      // Sonnet by default, Opus on request
      ...profile,
    }, task, taggedBroadcast, agentId);

    taggedBroadcast({
      type: 'chat_turn_complete',
      agentId,
      sessionId: result.sessionId,
      text: result.text,
      tokensUsed: result.tokens.input + result.tokens.output,
      cost: result.cost,
      cacheHits: { read: result.tokens.cacheRead, creation: result.tokens.cacheCreation },
    });
    taggedBroadcast({
      type: 'agent_complete',
      agentId,
      tokensUsed: result.tokens.output,
      summary: 'Turn complete',
    });

    task.done = true;
    return {
      sessionId: result.sessionId,
      text: result.text,
      tokens: result.tokens.input + result.tokens.output,
      cost: result.cost,
    };
  } catch (err) {
    task.done = true;
    taggedBroadcast({
      type: 'agent_error',
      agentId,
      error: err.message || String(err),
    });
    taggedBroadcast({
      type: 'chat_turn_failed',
      error: err.message || String(err),
    });
    throw err;
  }
}

/** Abort an in-flight chat turn. */
export function cancelChat(chatId) {
  const task = chatTasks.get(chatId);
  if (!task) return;
  task.aborted = true;
  for (const s of task.sessions) { try { s.close(); } catch {} }
}

/** Clean up a chat's state when the UI closes it. */
export function disposeChat(chatId) {
  cancelChat(chatId);
  chatTasks.delete(chatId);
}

// ─── SDK query helper ───

function classifyError(err) {
  const msg = (err?.message || String(err) || '').toLowerCase();
  if (msg.includes('rate') || msg.includes('429') || msg.includes('overload')) return 'rate_limit';
  if (msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('network')) return 'network';
  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  if (msg.includes('abort') || msg.includes('cancel')) return 'cancelled';
  if (msg.includes('max turns') || msg.includes('max_turns')) return 'turns';
  return 'unknown';
}

async function runAgent(opts, task, broadcast, agentId) {
  const MAX_RETRIES = 3;
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await runAgentOnce(opts, task, broadcast, agentId);
    } catch (err) {
      lastErr = err;
      if (task.aborted) throw err;
      const kind = classifyError(err);
      if (kind === 'cancelled' || kind === 'turns' || kind === 'unknown') {
        throw err;
      }
      const delayMs = 1500 * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
      broadcast({ type: 'agent_stream', text: `\n[transient error: ${kind} — retrying in ${Math.round(delayMs/1000)}s (attempt ${attempt + 2}/${MAX_RETRIES})]\n` });
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

async function runAgentOnce(opts, task, broadcast, agentId) {
  const {
    prompt, cwd, systemPrompt, tools, schema, maxTurns,
    model, effort, thinking, fallbackModel,
    onToolUse, resume, permissionMode, silent,
    focusFiles, lightweight,
  } = opts;

  let resultData = null;
  let totalTokens = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };

  const recentTools = [];
  let stuckDetected = false;

  // Mount Hexis-specific MCP tools (always) + Serena (unless lightweight).
  // Lightweight mode is for fast zero-tool roles (Writer, Classifier) where
  // the ~2-3s Serena cold start isn't worth the cost.
  const mcpServers = { hexis: buildHexisMcpServer(cwd) };

  if (!lightweight && process.env.HEXIS_DISABLE_SERENA !== '1') {
    // Serena MCP — symbol-level LSP-backed code retrieval for 30+ languages.
    // Planner + Coder + Reviewer use `find_symbol`, `get_references`, etc.
    // instead of blind Glob/Grep/Read. Skipped in lightweight mode.
    mcpServers.serena = {
      type: 'stdio',
      command: 'uvx',
      args: [
        '--from', 'git+https://github.com/oraios/serena',
        'serena', 'start-mcp-server',
        '--context', 'claude-code',
        '--project', cwd,
        '--transport', 'stdio',
        '--enable-web-dashboard', 'false',
        '--open-web-dashboard', 'false',
        '--log-level', 'WARNING',
      ],
    };
  }

  // SDK hooks: protected-file blocker, diff tracker, git-history injection.
  // Lightweight mode skips hooks — Writer and Classifier never edit files.
  const hooks = lightweight ? undefined : buildHooks({
    repoPath: cwd,
    diffTracker: task.diffTracker,
    protectedFiles: DEFAULT_PROTECTED,
    broadcast: silent ? null : broadcast,
    focusFiles: focusFiles || [],
    injectGitHistory: !silent,
  });

  const repoPreamble = getRepoPreamble();
  const fullSystemPrompt = repoPreamble + (systemPrompt || '');

  const queryOpts = {
    cwd,
    model: model || 'sonnet',
    effort: effort || 'high',
    allowedTools: tools || CODER_TOOLS,
    permissionMode: permissionMode || 'bypassPermissions',
    maxTurns: maxTurns || 100,
    env: cleanEnv(),
    includePartialMessages: true,
    // Load CLAUDE.md / .claude/settings.json / AGENTS.md from the filesystem
    settingSources: ['user', 'project', 'local'],
    mcpServers,
    // Free progress summaries via cached forks
    agentProgressSummaries: true,
  };
  if (hooks) queryOpts.hooks = hooks;

  // Opus-only options
  if (thinking) queryOpts.thinking = thinking;
  if (fallbackModel) queryOpts.fallbackModel = fallbackModel;

  if (resume) queryOpts.resume = resume;
  if (fullSystemPrompt.trim()) {
    queryOpts.systemPrompt = {
      type: 'preset',
      preset: 'claude_code',
      append: fullSystemPrompt,
      // Strip per-session dynamic sections so cache prefix is shared across all parallel runs
      excludeDynamicSections: true,
    };
  }
  if (schema) queryOpts.outputFormat = { type: 'json_schema', schema };

  // NO maxBudgetUsd — runs on subscription. See agent-profiles.js note.

  const stream = query({ prompt, options: queryOpts });
  task.sessions.push(stream);

  try {
    for await (const message of stream) {
      if (task.aborted) {
        try { stream.close(); } catch {}
        throw new Error('Task cancelled');
      }

      // Partial text streaming (for UI tail)
      if (message.type === 'stream_event' && message.event) {
        const ev = message.event;
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          if (!silent) broadcast({ type: 'agent_stream', text: ev.delta.text });
        }
      }

      // Complete assistant messages (tool calls + reasoning)
      if (message.type === 'assistant' && message.message?.content) {
        for (const block of message.message.content) {
          if (block.type === 'tool_use') {
            const toolName = block.name;
            const input = block.input || {};

            // Stuck detection
            const sig = `${toolName}|${JSON.stringify(input).slice(0, 200)}`;
            recentTools.push(sig);
            if (recentTools.length > 5) recentTools.shift();
            if (recentTools.length === 5 && recentTools.every(s => s === sig)) {
              stuckDetected = true;
              if (!silent) broadcast({ type: 'agent_stream', text: `\n[stuck loop detected: ${toolName} called 5x with same input — terminating]\n` });
              try { stream.close(); } catch {}
              throw new Error(`Agent stuck in loop: ${toolName}`);
            }

            if (toolName === 'Read' && input.file_path) {
              const normalized = normalizePath(input.file_path, cwd);
              if (!silent) broadcast({ type: 'agent_reading', agentId, file: normalized });
              if (onToolUse) onToolUse('read', normalized);
            }
            if ((toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') && (input.file_path || input.path || input.notebook_path)) {
              const fp = input.file_path || input.path || input.notebook_path;
              const normalized = normalizePath(fp, cwd);
              if (!silent) broadcast({ type: 'agent_editing', agentId, file: normalized });
              if (onToolUse) onToolUse('edit', normalized);
            }
            if (toolName === 'Bash' && input.command && !silent) {
              broadcast({ type: 'agent_stream', text: `\n$ ${input.command}\n` });
            }
            if (toolName === 'Glob' && input.pattern && !silent) {
              broadcast({ type: 'agent_stream', text: `\n[search: ${input.pattern}]\n` });
            }
            if (toolName === 'Grep' && input.pattern && !silent) {
              broadcast({ type: 'agent_stream', text: `\n[grep: ${input.pattern}]\n` });
            }
            if (toolName?.startsWith('mcp__hexis__') && !silent) {
              broadcast({ type: 'agent_stream', text: `\n[hexis tool: ${toolName.replace('mcp__hexis__', '')}]\n` });
            }
          }
        }

        const usage = message.message.usage;
        if (usage) {
          totalTokens.input += usage.input_tokens || 0;
          totalTokens.output += usage.output_tokens || 0;
          totalTokens.cacheCreation += usage.cache_creation_input_tokens || 0;
          totalTokens.cacheRead += usage.cache_read_input_tokens || 0;
        }
      }

      if (message.type === 'result') {
        resultData = message;
      }
    }
  } finally {
    task.sessions = task.sessions.filter(s => s !== stream);
  }

  if (!resultData) throw new Error('No result from Claude Code');

  if (resultData.is_error || resultData.subtype?.startsWith('error_')) {
    throw new Error(resultData.result || `Agent error: ${resultData.subtype}`);
  }

  return {
    text: resultData.result || '',
    structured: resultData.structured_output || null,
    sessionId: resultData.session_id,
    tokens: totalTokens,
    cost: resultData.total_cost_usd || 0,
  };
}

// ─── Read-only pipeline ───

async function runReadOnlyTask(taskId, prompt, repoPath, broadcast, task, focusFiles) {
  const analystId = `${taskId}::analyst`;
  const profile = getProfile('analyst');

  broadcast({ type: 'agent_spawned', agentId: analystId, role: 'planner', model: profile.model });

  const result = await runAgent({
    prompt,
    cwd: repoPath,
    systemPrompt: `You are a code analyst. The user is asking a read-only question — DO NOT modify any files.

APPROACH:
- Start by calling memory_view("/") to check for any prior context about this repo.
- Use Glob/Grep/Read + the MCP tools (getGitContext, getGitDiff, getRepoStats) extensively.
- Be specific and cite file paths + line numbers when relevant.
- Give a clear, complete answer.

Output a thorough natural-language answer. No JSON schema required.`,
    tools: READ_TOOLS,
    permissionMode: 'plan',
    focusFiles,
    ...profile,
  }, task, broadcast, analystId);

  broadcast({ type: 'agent_complete', agentId: analystId, tokensUsed: result.tokens.output, summary: 'Analysis complete' });
  broadcast({
    type: 'task_review',
    review: {
      approved: true,
      confidence: 1.0,
      summary: result.text.slice(0, 500),
      issues: [],
      readonly: true,
    },
  });
  broadcast({
    type: 'tokens_update',
    total: result.tokens.input + result.tokens.output,
    cost: result.cost,
    cacheHits: { read: result.tokens.cacheRead, creation: result.tokens.cacheCreation },
  });
  broadcast({ type: 'task_complete', tokensUsed: result.tokens.input + result.tokens.output, cost: result.cost });
}

// ─── Full edit pipeline ───

async function runPipeline(taskId, prompt, repoPath, broadcast, task, focusFiles, originalRepoPath, intent) {
  const plannerId = `${taskId}::planner`;
  const coderId = (i) => `${taskId}::coder-${i}`;

  // ────── 1. PLAN ──────
  const plannerProfile = getProfile('planner');
  broadcast({ type: 'agent_spawned', agentId: plannerId, role: 'planner', model: plannerProfile.model, subtaskId: null });

  const focusHint = focusFiles?.length
    ? `\n\nThe user has indicated these files are most relevant:\n${focusFiles.join('\n')}`
    : '';

  const planResult = await runAgent({
    prompt: `${prompt}${focusHint}

Before you plan:
1. Call memory_view("/") to check for any learned conventions from prior runs on this repo.
2. Call getRepoStats() once to get branch + file counts.
3. Use Glob/Grep/Read to explore as needed — the SessionStart hook has already injected recent git history for focus files.

Then produce a detailed execution plan with explicit subtask dependencies.`,
    cwd: repoPath,
    systemPrompt: `You are a senior software architect creating an execution plan.

APPROACH:
- Explore the codebase first — use Glob, Grep, Read + the MCP tools (getGitContext, getRepoStats, memory_search)
- Follow existing conventions (check CLAUDE.md, AGENTS.md, existing patterns, memory_view("learned.md"))
- Break work into atomic subtasks — one logical change per subtask
- Be SPECIFIC about file paths and what to change
- Consider edge cases, tests, and related files that may need updates

CRITICAL: For each subtask, populate \`dependsOn\` with the IDs of subtasks that must complete BEFORE it can run. Use this when:
- Subtask B imports from a file Subtask A creates
- Subtask B's logic depends on Subtask A's data structure
- Subtasks B and C both modify the same module but in different ways

Output the plan as structured JSON matching the schema.`,
    tools: READ_TOOLS,
    permissionMode: 'plan',
    schema: PLAN_SCHEMA,
    focusFiles,
    ...plannerProfile,
  }, task, broadcast, plannerId);

  const plannerSessionId = planResult.sessionId;

  const plan = planResult.structured || { summary: planResult.text.slice(0, 300), subtasks: [] };
  plan.subtasks = (plan.subtasks || []).map((st, i) => ({
    id: st.id || `st-${i + 1}`,
    title: st.title || `Step ${i + 1}`,
    description: st.description || '',
    files: st.files || [],
    action: st.action || 'modify',
    dependsOn: st.dependsOn || [],
  }));

  broadcast({
    type: 'plan_ready',
    plan: plan.summary,
    subtasks: plan.subtasks.map(st => ({
      id: st.id, title: st.title, description: st.description,
      status: 'pending', files: st.files, action: st.action, dependsOn: st.dependsOn,
    })),
    awaitingApproval: false,
  });
  broadcast({ type: 'agent_complete', agentId: plannerId, tokensUsed: planResult.tokens.output, summary: 'Plan ready' });

  let totalCost = planResult.cost;
  let totalTokensUsed = planResult.tokens.input + planResult.tokens.output;
  let totalCacheRead = planResult.tokens.cacheRead;
  let totalCacheCreation = planResult.tokens.cacheCreation;

  broadcast({
    type: 'tokens_update', total: totalTokensUsed, cost: totalCost,
    cacheHits: { read: totalCacheRead, creation: totalCacheCreation },
  });

  if (task.aborted) return;

  // ────── 2. EXECUTE SUBTASKS ──────
  // Topological scheduler: respects both task deps AND file-overlap conflicts
  const allTouchedFiles = new Set();
  let lastCoderSessionId = null;
  const waves = scheduleSubtasks(plan.subtasks);
  broadcast({ type: 'agent_stream', text: `\n[scheduled ${plan.subtasks.length} subtasks into ${waves.length} wave(s)]\n` });

  for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
    if (task.aborted) return;
    const wave = waves[waveIdx];

    const waveResults = await Promise.allSettled(wave.map(async ({ subtask, originalIndex }) => {
      const agentId = coderId(originalIndex);
      const perAgentFiles = new Set();
      const coderProfile = getProfile('coder');

      broadcast({ type: 'agent_spawned', agentId, role: 'coder', model: coderProfile.model, subtaskId: subtask.id });

      // Session resume from planner → Coder inherits cached reads for free.
      // Only the FIRST coder in the first wave resumes the planner session;
      // later coders start fresh (they don't want the planner's giant context).
      const shouldResumeFromPlanner = waveIdx === 0 && originalIndex === 0 && plannerSessionId;

      const coderResult = await runAgent({
        prompt: `Execute this subtask:

TITLE: ${subtask.title}
DESCRIPTION: ${subtask.description}
FILES: ${subtask.files.join(', ')}
DEPS COMPLETE: ${subtask.dependsOn.join(', ') || 'none'}

Steps:
1. Call memory_view("learned.md") to recall any project-specific conventions
2. Read the target files (your SessionStart hook has pre-loaded git history)
3. Make the changes
4. Verify by re-reading
5. Run tests for the files you touched via mcp__hexis__runTests

Write complete, working code that matches project conventions. No placeholders.`,
        cwd: repoPath,
        systemPrompt: `You are an expert software engineer executing a subtask as part of a larger plan.

APPROACH:
- memory_view("learned.md") first — there may be rules from prior runs
- Read target files to understand context before editing
- Follow existing code style exactly (see AGENTS.md / CLAUDE.md via settingSources)
- Write complete, working code — no placeholders, no TODOs
- If you discover the task needs changes to additional files, make them
- Use TodoWrite to track multi-step work
- Verify with mcp__hexis__runTests when sensible

Protected files are enforced by a pre-tool hook — if you try to edit a lockfile or secret, the hook will deny and you must stop.`,
        tools: CODER_TOOLS,
        permissionMode: 'bypassPermissions',
        focusFiles: subtask.files,
        resume: shouldResumeFromPlanner ? plannerSessionId : undefined,
        ...coderProfile,
        onToolUse: (action, file) => {
          perAgentFiles.add(file);
          if (action === 'edit') allTouchedFiles.add(file);
        },
      }, task, broadcast, agentId);

      // Test feedback loop
      let testRetries = 0;
      let lastSessionId = coderResult.sessionId;
      let extraCost = 0;
      let extraTokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
      if (perAgentFiles.size > 0 && [...perAgentFiles].some(f => /\.(jsx?|tsx?|py|rs|go|java)$/.test(f))) {
        const testResult = await runProjectTests(repoPath, [...perAgentFiles]);
        if (testResult && testResult.failed > 0 && testResult.output) {
          broadcast({ type: 'agent_stream', text: `\n[${agentId}: tests failed ${testResult.failed}/${testResult.total} — retrying]\n` });
          for (let attempt = 0; attempt < 3; attempt++) {
            if (task.aborted) break;
            const retryResult = await runAgent({
              prompt: `Tests are failing after your changes. Fix them at the root cause.\n\nFailing output:\n\`\`\`\n${testResult.output.slice(-2500)}\n\`\`\``,
              cwd: repoPath,
              systemPrompt: `Continue your previous work. Diagnose the root cause of the test failures and fix them. Don't just suppress errors.`,
              tools: CODER_TOOLS,
              permissionMode: 'bypassPermissions',
              resume: lastSessionId,
              ...coderProfile,
              onToolUse: (action, file) => {
                perAgentFiles.add(file);
                if (action === 'edit') allTouchedFiles.add(file);
              },
            }, task, broadcast, agentId);
            lastSessionId = retryResult.sessionId;
            extraCost += retryResult.cost;
            extraTokens.input += retryResult.tokens.input;
            extraTokens.output += retryResult.tokens.output;
            extraTokens.cacheRead += retryResult.tokens.cacheRead;
            extraTokens.cacheCreation += retryResult.tokens.cacheCreation;
            testRetries++;
            const recheck = await runProjectTests(repoPath, [...perAgentFiles]);
            if (!recheck || recheck.failed === 0) {
              broadcast({ type: 'agent_stream', text: `\n[${agentId}: tests now passing]\n` });
              break;
            }
          }
        }
      }

      for (const f of perAgentFiles) broadcast({ type: 'agent_done_file', file: f });

      broadcast({ type: 'agent_complete', agentId, tokensUsed: coderResult.tokens.output + extraTokens.output, summary: `Completed: ${subtask.title}` });
      broadcast({ type: 'subtask_complete', subtaskId: subtask.id });

      return { coderResult, extraCost, extraTokens, sessionId: lastSessionId, testRetries };
    }));

    for (const settled of waveResults) {
      if (settled.status === 'fulfilled') {
        const r = settled.value;
        totalCost += r.coderResult.cost + r.extraCost;
        totalTokensUsed += r.coderResult.tokens.input + r.coderResult.tokens.output + r.extraTokens.input + r.extraTokens.output;
        totalCacheRead += r.coderResult.tokens.cacheRead + r.extraTokens.cacheRead;
        totalCacheCreation += r.coderResult.tokens.cacheCreation + r.extraTokens.cacheCreation;
        lastCoderSessionId = r.sessionId;
      } else {
        broadcast({ type: 'agent_stream', text: `\n[subtask failed: ${settled.reason?.message || 'unknown error'}]\n` });
      }
    }

    broadcast({
      type: 'tokens_update', total: totalTokensUsed, cost: totalCost,
      cacheHits: { read: totalCacheRead, creation: totalCacheCreation },
    });
  }

  if (task.aborted) return;

  // ────── 3. REVIEW ──────
  if (allTouchedFiles.size === 0) {
    broadcast({
      type: 'task_review',
      review: {
        approved: true, confidence: 1.0,
        summary: 'No files were modified — nothing to review.',
        issues: [], skipped: true,
      },
    });
    broadcast({ type: 'task_complete', tokensUsed: totalTokensUsed, cost: totalCost });
    return;
  }

  // trivial_edit = small rename/typo/one-function add → skip the full
  // 3-persona + final-merger review pipeline. Running 4 Sonnet/Opus
  // reviewers on a 13-line pure-math file costs $2+ and adds 60+
  // seconds for zero practical benefit — the classifier's whole job
  // is to identify these runs and let them bypass the heavy review.
  // We still record an auto-approved review so the Task Board shows
  // a completed card rather than an unreviewed one.
  let finalReview;
  if (intent === 'trivial_edit') {
    broadcast({ type: 'agent_stream', text: `\n[trivial_edit — skipping persona review pipeline]\n` });
    finalReview = {
      cost: 0,
      tokens: 0,
      cacheRead: 0,
      cacheCreation: 0,
      result: {
        approved: true,
        confidence: 0.9,
        summary: `Auto-approved: classified as trivial_edit (${allTouchedFiles.length} file${allTouchedFiles.length === 1 ? '' : 's'} touched). Full persona review skipped to save cost.`,
        issues: [],
        skipped: true,
      },
    };
    broadcast({ type: 'task_review', review: finalReview.result });
  } else {
    // 3a. Three personas run in parallel (Sonnet)
    const personaReviews = await runPersonaReviews(taskId, prompt, plan, allTouchedFiles, repoPath, broadcast, task);
    totalCost += personaReviews.cost;
    totalTokensUsed += personaReviews.tokens;
    totalCacheRead += personaReviews.cacheRead || 0;
    totalCacheCreation += personaReviews.cacheCreation || 0;

    // 3b. Opus merger reviewer — semantic dedup + final verdict + learned conventions
    finalReview = await runFinalReview(taskId, prompt, plan, personaReviews.personas, allTouchedFiles, repoPath, broadcast, task);
    totalCost += finalReview.cost;
    totalTokensUsed += finalReview.tokens;
    totalCacheRead += finalReview.cacheRead || 0;
    totalCacheCreation += finalReview.cacheCreation || 0;

    broadcast({ type: 'task_review', review: finalReview.result });
  }

  // ─── Review-fix loop: full-context fix on critical issues ───
  if (!finalReview.result.approved && lastCoderSessionId) {
    const criticalIssues = finalReview.result.issues?.filter(i => i.severity === 'critical') || [];
    if (criticalIssues.length > 0) {
      broadcast({ type: 'agent_stream', text: `\n[reviewer found ${criticalIssues.length} critical issues — sending back to coder with full context]\n` });
      const fixAgentId = `${taskId}::coder-fix`;
      broadcast({ type: 'agent_spawned', agentId: fixAgentId, role: 'coder', model: getProfile('coder').model });

      const issuesBlock = criticalIssues.map((i, n) => {
        const loc = i.file ? ` [${i.file}${i.line ? `:${i.line}` : ''}]` : '';
        const sugg = i.suggestion ? `\n   Suggestion: ${i.suggestion}` : '';
        return `${n + 1}.${loc} ${i.description}${sugg}`;
      }).join('\n\n');

      const fixResult = await runAgent({
        prompt: `The review found ${criticalIssues.length} CRITICAL issue(s) with your changes. You MUST address every one.

ISSUES:
${issuesBlock}

REVIEW SUMMARY:
${finalReview.result.summary}

STEPS:
1. Call getGitDiff() to see exactly what you changed
2. Read the affected files again
3. Fix every critical issue (not just papering over symptoms)
4. Run mcp__hexis__runTests to verify
5. Do not introduce new issues`,
        cwd: repoPath,
        systemPrompt: `Fix the critical issues identified in your previous work. Address root causes, not symptoms. Verify with tests.`,
        tools: CODER_TOOLS,
        permissionMode: 'bypassPermissions',
        resume: lastCoderSessionId,
        ...getProfile('coder'),
        onToolUse: (action, file) => {
          if (action === 'edit') allTouchedFiles.add(file);
        },
      }, task, broadcast, fixAgentId);

      totalCost += fixResult.cost;
      totalTokensUsed += fixResult.tokens.input + fixResult.tokens.output;
      totalCacheRead += fixResult.tokens.cacheRead;
      totalCacheCreation += fixResult.tokens.cacheCreation;

      broadcast({ type: 'agent_complete', agentId: fixAgentId, tokensUsed: fixResult.tokens.output, summary: 'Critical fixes applied' });

      finalReview.result.approved = true;
      finalReview.result.summary = `Critical issues addressed: ${finalReview.result.summary}`;
      broadcast({ type: 'task_review', review: finalReview.result });
    }
  }

  broadcast({
    type: 'tokens_update', total: totalTokensUsed, cost: totalCost,
    cacheHits: { read: totalCacheRead, creation: totalCacheCreation },
  });
  broadcast({ type: 'task_complete', tokensUsed: totalTokensUsed, cost: totalCost });
}

// ─── Persona reviewers (parallel, Sonnet) ───

const PERSONAS = [
  {
    name: 'correctness',
    title: 'Correctness Reviewer',
    // Seeded from VoltAgent code-reviewer.md
    system: `You are a correctness specialist reviewing code changes. Focus ONLY on correctness:

RUBRIC (check each):
- Logic errors, off-by-one bugs, incorrect conditionals
- Broken or missing imports/exports
- Type mismatches (React props, TS types, function signatures)
- Race conditions and improper async/await
- Error paths: missing try/catch, uncaught rejections, misleading error messages
- Edge cases: empty inputs, null/undefined, boundary values
- Resource leaks (unclosed streams, uncleared timers, unresolved promises)
- Integration: does the new code match the callers' contracts?

IGNORE: style, security, performance. Those have other reviewers.

For each issue, set severity:
- critical: bug that will break production, corrupt data, or crash
- major: probable defect that will fail under realistic inputs
- minor: worth fixing but not blocking

Output structured JSON with approved/confidence/summary/issues.`,
    focus: 'correctness, logic, types, async, error handling, integration',
  },
  {
    name: 'security',
    title: 'Security Auditor',
    // Seeded from VoltAgent security-auditor.md
    system: `You are a security auditor reviewing code changes. Focus ONLY on security:

RUBRIC (check each):
- Injection: SQL, shell, path traversal, template injection
- XSS and unsafe DOM/HTML rendering
- Hardcoded secrets, API keys, tokens, passwords
- Unsafe deserialization, eval, Function constructor
- Auth/authz: missing checks, privilege escalation, IDOR
- Sensitive data in logs or error messages
- Insecure crypto: weak hashes, random, custom crypto
- Supply chain: new untrusted dependencies, postinstall scripts
- Command injection via Bash/exec
- File system abuses: writing outside workspace, symlink attacks

IGNORE: style, correctness of business logic, performance.

For each issue, set severity:
- critical: exploitable vulnerability
- major: insecure pattern that would fail review
- minor: hardening opportunity

Output structured JSON with approved/confidence/summary/issues.`,
    focus: 'security vulnerabilities, injection, secrets, auth, crypto, supply chain',
  },
  {
    name: 'style',
    title: 'Style & Conventions Reviewer',
    system: `You are a style & conventions reviewer. Focus ONLY on project consistency:

RUBRIC (check each):
- Code style: spacing, naming, file structure — matches AGENTS.md / CLAUDE.md?
- React conventions: hook rules, component naming, props interface consistency
- Import ordering and grouping
- Tailwind class organization (if used)
- Uses theme tokens (W.*) instead of hardcoded hex colors
- Matches existing patterns in neighboring files
- Dead code, commented-out code, TODOs without owners
- Follows any conventions listed in /memories/learned.md

IGNORE: correctness bugs, security, performance. Those have other reviewers.

For each issue, set severity:
- critical: makes the codebase inconsistent in a way that will confuse other agents
- major: noticeable deviation from project patterns
- minor: nit-pick

Before finalizing, call memory_view("learned.md") to pick up project-specific conventions.

Output structured JSON with approved/confidence/summary/issues.`,
    focus: 'code style, conventions, naming, theme tokens, consistency',
  },
];

async function runPersonaReviews(taskId, prompt, plan, touchedFiles, repoPath, broadcast, task) {
  const fileList = [...touchedFiles].join(', ');
  const profile = getProfile('persona_reviewer');

  const results = await Promise.allSettled(PERSONAS.map(async (persona) => {
    const personaId = `${taskId}::reviewer-${persona.name}`;
    broadcast({ type: 'agent_spawned', agentId: personaId, role: 'reviewer', model: profile.model });

    const r = await runAgent({
      prompt: `Review the uncommitted changes in these files: ${fileList}

Original task: ${prompt}
Plan: ${plan.summary}

STEPS:
1. Call getGitDiff() ONCE to see exactly what changed (do not run git via Bash)
2. If needed, Read specific files for deeper context
3. Apply your rubric ruthlessly
4. Output structured JSON matching the schema

Focus ONLY on: ${persona.focus}`,
      cwd: repoPath,
      systemPrompt: persona.system,
      tools: REVIEWER_TOOLS,
      permissionMode: 'plan',
      schema: REVIEW_SCHEMA,
      focusFiles: [...touchedFiles],
      ...profile,
    }, task, broadcast, personaId);

    broadcast({ type: 'agent_complete', agentId: personaId, tokensUsed: r.tokens.output, summary: `${persona.name} review done` });
    return { persona: persona.name, ...r };
  }));

  let totalReviewCost = 0;
  let totalReviewTokens = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;
  const personas = [];

  for (const settled of results) {
    if (settled.status === 'fulfilled') {
      const r = settled.value;
      totalReviewCost += r.cost;
      totalReviewTokens += r.tokens.input + r.tokens.output;
      totalCacheRead += r.tokens.cacheRead;
      totalCacheCreation += r.tokens.cacheCreation;
      personas.push({
        name: r.persona,
        review: r.structured || { approved: true, confidence: 0.5, summary: r.text.slice(0, 300), issues: [] },
      });
    }
  }

  return {
    personas,
    cost: totalReviewCost,
    tokens: totalReviewTokens,
    cacheRead: totalCacheRead,
    cacheCreation: totalCacheCreation,
  };
}

// ─── Final reviewer (Opus merger) ───

async function runFinalReview(taskId, prompt, plan, personas, touchedFiles, repoPath, broadcast, task) {
  const profile = getProfile('final_reviewer');
  const finalId = `${taskId}::reviewer-final`;
  broadcast({ type: 'agent_spawned', agentId: finalId, role: 'reviewer', model: profile.model });

  const personaBlock = personas.map(p => {
    const r = p.review;
    const issues = (r.issues || []).map(i => {
      const loc = i.file ? ` [${i.file}${i.line ? `:${i.line}` : ''}]` : '';
      return `  - [${i.severity}]${loc} ${i.description}${i.suggestion ? ` (suggestion: ${i.suggestion})` : ''}`;
    }).join('\n') || '  (no issues)';
    return `### ${p.name} persona
summary: ${r.summary || '(no summary)'}
approved: ${r.approved}
confidence: ${r.confidence ?? 'n/a'}
issues:
${issues}`;
  }).join('\n\n');

  const r = await runAgent({
    prompt: `You are the final reviewer merging three specialized persona reviews into a single verdict.

ORIGINAL TASK:
${prompt}

PLAN SUMMARY:
${plan.summary}

FILES CHANGED: ${[...touchedFiles].join(', ')}

PERSONA REVIEWS:

${personaBlock}

YOUR JOB:
1. Call getGitDiff() to see the actual changes yourself
2. Merge the three reviews: deduplicate issues that describe the same thing with different wording
3. Re-rank severity based on your own judgement (sometimes a persona over-flags; sometimes they miss cross-cutting issues)
4. Produce a final verdict: approved: true only if NO critical issues remain and the majors are mild enough to ship
5. Distill 1-3 learned conventions from this review that should apply to future work. Examples: "Always use W.* tokens for colors", "Pass file_id from Files API to reviewers", "Never edit tauri.conf.json". Keep them short and imperative.
6. Output structured JSON matching the schema.

After producing the JSON, CALL mcp__hexis__memory_append with path="learned.md", header="From ${taskId}", content=the learned conventions as a bulleted list. This closes the semantic learning loop.`,
    cwd: repoPath,
    systemPrompt: `You are the senior reviewer making the final call. You're judicious: avoid rubber-stamping (auto-approve) AND avoid over-flagging. Your verdict is what ships.

When merging the three persona reviews:
- Keep the highest severity if the same issue appears in multiple personas
- Dedupe by semantic meaning, not string similarity
- Trust the security persona on security issues, the correctness persona on bugs, the style persona on conventions
- If personas disagree, use your own read of the diff to decide`,
    tools: REVIEWER_TOOLS,
    permissionMode: 'bypassPermissions', // needs memory_append
    schema: MERGED_REVIEW_SCHEMA,
    focusFiles: [...touchedFiles],
    ...profile,
  }, task, broadcast, finalId);

  broadcast({ type: 'agent_complete', agentId: finalId, tokensUsed: r.tokens.output, summary: 'Final review done' });

  const merged = r.structured || {
    approved: false,
    confidence: 0.5,
    summary: r.text.slice(0, 500),
    issues: [],
    learnedConventions: [],
  };

  return {
    result: merged,
    cost: r.cost,
    tokens: r.tokens.input + r.tokens.output,
    cacheRead: r.tokens.cacheRead,
    cacheCreation: r.tokens.cacheCreation,
  };
}

// ─── Test runner integration ───

async function runProjectTests(cwd, files = []) {
  try {
    const filter = files.length === 1 ? `--run ${files[0]}` : '--run';
    const cmd = `npm test -- ${filter}`;
    const { stdout, stderr } = await execAsync(cmd, {
      cwd,
      timeout: 120000,
      maxBuffer: 5 * 1024 * 1024,
    });
    const out = `${stdout}\n${stderr}`;
    const passMatch = out.match(/(\d+)\s+pass/i);
    const failMatch = out.match(/(\d+)\s+fail/i);
    return {
      passed: parseInt(passMatch?.[1] || '0', 10),
      failed: parseInt(failMatch?.[1] || '0', 10),
      total: (parseInt(passMatch?.[1] || '0', 10)) + (parseInt(failMatch?.[1] || '0', 10)),
      output: out.slice(-3000),
    };
  } catch (err) {
    if (err.stdout || err.stderr) {
      const out = `${err.stdout || ''}\n${err.stderr || ''}`;
      const passMatch = out.match(/(\d+)\s+pass/i);
      const failMatch = out.match(/(\d+)\s+fail/i);
      return {
        passed: parseInt(passMatch?.[1] || '0', 10),
        failed: parseInt(failMatch?.[1] || '0', 10),
        total: (parseInt(passMatch?.[1] || '0', 10)) + (parseInt(failMatch?.[1] || '0', 10)),
        output: out.slice(-3000),
      };
    }
    return null;
  }
}

// ─── Scheduler ───

/**
 * Topological scheduler — groups subtasks into "waves".
 *
 * A subtask can run in wave N iff:
 *   1. All its `dependsOn` targets finished in earlier waves
 *   2. Its file set does not overlap with other subtasks in the SAME wave
 *
 * Each wave's subtasks run in parallel. Waves run sequentially.
 */
function scheduleSubtasks(subtasks) {
  const norm = (f) => (f || '').replace(/\\/g, '/').toLowerCase();
  const byId = new Map(subtasks.map(st => [st.id, st]));
  const completed = new Set();
  const waves = [];
  const remaining = new Set(subtasks.map(st => st.id));

  // Defensive: max iterations = #subtasks * 2 (prevents infinite loop on bad deps)
  let maxIter = subtasks.length * 2 + 2;

  while (remaining.size > 0 && maxIter-- > 0) {
    // Find all ready subtasks: all deps satisfied
    const ready = [];
    for (const id of remaining) {
      const st = byId.get(id);
      const deps = st.dependsOn || [];
      if (deps.every(d => completed.has(d) || !byId.has(d))) {
        ready.push(st);
      }
    }
    if (ready.length === 0) {
      // Broken deps (cycle or reference to non-existent subtask). Ship the rest as-is.
      for (const id of remaining) {
        const st = byId.get(id);
        ready.push(st);
      }
    }

    // Pack ready subtasks into one wave — but no two in the same wave may share files
    const wave = [];
    const waveFiles = new Set();
    const deferred = [];
    for (const st of ready) {
      const sFiles = new Set((st.files || []).map(norm));
      let overlap = false;
      for (const f of sFiles) {
        if (waveFiles.has(f)) { overlap = true; break; }
      }
      if (overlap) {
        deferred.push(st);
      } else {
        wave.push({ subtask: st, originalIndex: subtasks.indexOf(st) });
        for (const f of sFiles) waveFiles.add(f);
      }
    }

    if (wave.length === 0) break; // safety
    waves.push(wave);
    for (const w of wave) {
      completed.add(w.subtask.id);
      remaining.delete(w.subtask.id);
    }
    // deferred subtasks naturally fall into the next wave
  }

  return waves;
}

function normalizePath(filePath, cwd) {
  if (!filePath) return filePath;
  let normalized = filePath.replace(/\\/g, '/');
  let cwdNorm = cwd.replace(/\\/g, '/').replace(/\/$/, '');
  if (normalized.toLowerCase().startsWith(cwdNorm.toLowerCase())) {
    normalized = normalized.slice(cwdNorm.length);
  }
  normalized = normalized.replace(/^\/+/, '');
  return normalized;
}

// ═══════════════════════════════════════════════════════════════════════
// DEEP RESEARCH PIPELINE — "Best Option Guarantee"
// ═══════════════════════════════════════════════════════════════════════

/**
 * Public entry point for a deep research task.
 *
 * Pipeline: plan (Opus) → parallel workers (Sonnet ×N) → dedupe/cross-verify →
 * rank+compare with rubric (Opus) → adversarial critic (Sonnet) → final
 * synthesis (Opus) → optional task extraction → persist to memory.
 *
 * @param {string} taskId          - unique research task ID
 * @param {string} query           - the user's research question
 * @param {string} repoPath        - repo cwd
 * @param {Function} broadcast     - SSE broadcaster
 * @param {Object} options
 * @param {boolean} options.createTasks  - if true, spawn task board entries from nextSteps
 * @param {number}  options.workerCount  - 3-5 parallel workers (default 3)
 * @param {string}  options.focusArea    - optional narrowing hint
 */
export async function researchTask(taskId, query, repoPath, broadcast, options = {}) {
  const task = {
    aborted: false,
    sessions: [],
    approvalResolve: null,
    worktreePath: null,
    diffTracker: createDiffTracker(),
  };
  activeTasks.set(taskId, task);

  let store = null;
  try { store = getStateStore(); } catch {}
  store?.createRun({
    id: taskId, prompt: `[research] ${query}`, status: 'planning',
    startedAt: Date.now(), focusFiles: [],
  });

  const taggedBroadcast = (event) => {
    const tagged = { ...event, runId: taskId };
    if (store) {
      try { store.journalEvent(taskId, tagged); } catch {}
      if (event.type === 'research_complete' || event.type === 'task_complete') {
        store.updateRun(taskId, { status: 'done', completedAt: Date.now(), tokensUsed: event.tokensUsed, cost: event.cost });
      } else if (event.type === 'agent_error' && event.agentId?.endsWith('::orchestrator')) {
        store.updateRun(taskId, { status: 'error', error: event.error });
      } else if (event.type === 'tokens_update') {
        store.updateRun(taskId, { tokensUsed: event.total, cost: event.cost });
      }
    }
    broadcast(tagged);
  };

  runResearchPipeline(taskId, query, repoPath, taggedBroadcast, task, options)
    .catch(err => {
      if (!task.aborted) {
        taggedBroadcast({ type: 'agent_error', agentId: `${taskId}::orchestrator`, error: err.message });
      }
    })
    .finally(() => { activeTasks.delete(taskId); });
}

/**
 * Wrap a phase in a hard timeout. If the phase doesn't complete within
 * `timeoutMs`, cancel the task and throw — prevents a stuck SDK query from
 * hanging the whole research run indefinitely.
 */
async function withPhaseTimeout(phaseName, timeoutMs, task, broadcast, phaseFn) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      broadcast({ type: 'agent_stream', text: `\n[⏰ ${phaseName} exceeded ${timeoutMs / 1000}s — aborting phase]\n` });
      // Mark the task aborted so in-flight sessions wind down
      task.aborted = true;
      for (const s of task.sessions) { try { s.close(); } catch {} }
      reject(new Error(`${phaseName} phase timeout after ${timeoutMs / 1000}s`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([phaseFn(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function runResearchPipeline(taskId, query, repoPath, broadcast, task, options) {
  const workerCount = Math.max(2, Math.min(5, options.workerCount || 3));
  const createTasks = options.createTasks === true;
  const focusArea = options.focusArea || '';

  const leadId = `${taskId}::research-lead`;
  const criticId = `${taskId}::research-critic`;
  const taskifierId = `${taskId}::research-taskifier`;
  const workerId = (i) => `${taskId}::research-worker-${i}`;

  // Per-phase timeout caps — generous enough for legit runs, strict enough
  // to surface stuck phases instead of hanging forever.
  const TIMEOUTS = {
    plan:   5 * 60 * 1000,  // 5 min
    gather: 8 * 60 * 1000,  // 8 min (parallel, longest bottleneck)
    rank:   4 * 60 * 1000,  // 4 min
    critic: 4 * 60 * 1000,  // 4 min
    synth:  6 * 60 * 1000,  // 6 min
  };

  let totalCost = 0;
  let totalTokens = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;
  const addUsage = (r) => {
    totalCost += r.cost;
    totalTokens += r.tokens.input + r.tokens.output;
    totalCacheRead += r.tokens.cacheRead;
    totalCacheCreation += r.tokens.cacheCreation;
  };

  broadcast({ type: 'research_started', query, workerCount, createTasks });

  // ────── PHASE 1: PLAN ──────
  const leadProfile = getProfile('researcher_lead');
  broadcast({ type: 'agent_spawned', agentId: leadId, role: 'planner', model: leadProfile.model, subtaskId: null });
  broadcast({ type: 'agent_stream', text: `\n[research phase 1/6: planning]\n` });

  const planResult = await withPhaseTimeout('plan', TIMEOUTS.plan, task, broadcast, () => runAgent({
    lightweight: true,  // skip Serena — researchers don't need code symbol search
    prompt: `Research query: "${query}"
${focusArea ? `Focus area: ${focusArea}\n` : ''}

Plan this research run. You are the LEAD for a ${workerCount}-worker research pipeline.

Steps:
1. Call memory_search with keywords from the query — check if we already researched this recently.
2. Call memory_view("learned.md") + memory_view("/") to see prior context.
3. Call getRepoStats to understand Hexis's current branch + file types.
4. Read the root package.json (Read tool) to note the exact dependencies and versions — this becomes your Hexis context for the rubric.
5. Decompose the query into ${workerCount * 2}-${workerCount * 3} sub-questions. Each sub-question:
   - is concrete and answerable via 3-5 tool calls
   - names which tools it prefers (WebSearch, github_search, hn_search, npm_info, arxiv_search, web_fetch)
   - covers different angles: popularity, maturity, fit, gotchas, alternatives
6. Define the rubric (criteria for "best option" comparison). Default: Quality, HexisFit, License, Maturity, Maintenance, Integration, Gotchas. Adjust if the query calls for different criteria.
7. Summarize Hexis's stack constraints in one paragraph (e.g., "Node 20 ESM, React 18, Vite, Zustand, Tauri, Claude Agent SDK — prefer MIT/Apache, ESM-native, tree-shakeable, active maintenance").

Output structured JSON matching RESEARCH_PLAN_SCHEMA. Do NOT begin gathering — that's the workers' job.`,
    cwd: repoPath,
    systemPrompt: `You are the research LEAD agent for Hexis. You follow the hexis-deep-research skill methodology rigorously. Your job in this phase is PLANNING ONLY — no web research yet. You plan the sub-questions and rubric so parallel workers can gather in the next phase.`,
    tools: RESEARCH_TOOLS,
    permissionMode: 'plan',
    schema: RESEARCH_PLAN_SCHEMA,
    ...leadProfile,
  }, task, broadcast, leadId));

  addUsage(planResult);
  const plan = planResult.structured || { slug: 'research', summary: query, subQuestions: [], rubric: [], hexisContext: '' };

  broadcast({ type: 'research_plan_ready', slug: plan.slug, summary: plan.summary, subQuestions: plan.subQuestions, rubric: plan.rubric });
  broadcast({ type: 'agent_complete', agentId: leadId, tokensUsed: planResult.tokens.output, summary: `Plan ready — ${plan.subQuestions.length} sub-questions` });

  if (task.aborted) return;

  // ────── PHASE 2: GATHER (parallel workers) ──────
  broadcast({ type: 'agent_stream', text: `\n[research phase 2/6: gathering (${workerCount} parallel workers)]\n` });

  // Distribute sub-questions evenly across workers
  const subQs = plan.subQuestions || [];
  const buckets = Array.from({ length: workerCount }, () => []);
  subQs.forEach((sq, i) => buckets[i % workerCount].push(sq));

  const workerProfile = getProfile('researcher_worker');
  const workerResults = await withPhaseTimeout('gather', TIMEOUTS.gather, task, broadcast, () => Promise.allSettled(buckets.map(async (bucket, i) => {
    if (bucket.length === 0) return null;
    const wId = workerId(i);
    broadcast({ type: 'agent_spawned', agentId: wId, role: 'coder', model: workerProfile.model, subtaskId: null });

    const bucketDesc = bucket.map(sq => `- [${sq.id}] ${sq.question} — preferred tools: ${sq.preferredTools.join(', ')}`).join('\n');

    const r = await runAgent({
      lightweight: true,  // skip Serena — research workers don't need code symbol search
      prompt: `You are research worker ${i + 1} of ${workerCount}. Gather findings for these sub-questions:

${bucketDesc}

For each sub-question:
1. Use the preferred tools to search broadly, then use web_fetch on the 2-3 most promising URLs to actually READ them.
2. For every claim you want to include, record: claim text, source URL, source title, a verbatim <200-char excerpt, publishedDate if known, and your confidence (0-1).
3. If the sub-question is about comparing options (libraries, tools, approaches), record each candidate in \`candidateOptions\` with name + URL + one-liner.
4. PREFER primary sources (official docs, GitHub repos, HN threads) over SEO blog posts.
5. CROSS-VERIFY: if a claim is critical, find a second independent source confirming it.
6. Use npm_info for any npm package you want to recommend — check last publish date and weekly downloads to detect abandonment.

Hexis context (for your judgment):
${plan.hexisContext}

Stop when:
- You've answered every sub-question in your bucket with ≥2 findings per question, OR
- Three consecutive tool calls return nothing new, OR
- You hit your turn limit

Output structured JSON — ONE WORKER_FINDINGS_SCHEMA object per sub-question, in an array under the key "results". The first object in "results" is for the first sub-question in your bucket, and so on.`,
      cwd: repoPath,
      systemPrompt: `You are a research worker. You follow the hexis-deep-research skill. You find sources, read them, extract cited claims, and report structured findings. You do NOT synthesize a final verdict — that's the lead's job.`,
      tools: RESEARCH_TOOLS,
      permissionMode: 'plan',
      schema: {
        type: 'object',
        properties: {
          results: {
            type: 'array',
            items: WORKER_FINDINGS_SCHEMA,
          },
        },
        required: ['results'],
      },
      ...workerProfile,
    }, task, broadcast, wId);

    broadcast({ type: 'agent_complete', agentId: wId, tokensUsed: r.tokens.output, summary: `Worker ${i + 1} done` });
    return r;
  })));

  // Collect all findings
  const allFindings = [];
  const allCandidates = new Map();  // name → { name, url, oneLiner, mentions: count }
  for (const settled of workerResults) {
    if (settled.status === 'fulfilled' && settled.value) {
      const r = settled.value;
      addUsage(r);
      const results = r.structured?.results || [];
      for (const res of results) {
        for (const f of (res.findings || [])) allFindings.push(f);
        for (const c of (res.candidateOptions || [])) {
          const key = (c.name || '').toLowerCase().trim();
          if (!key) continue;
          const existing = allCandidates.get(key);
          if (existing) {
            existing.mentions += 1;
          } else {
            allCandidates.set(key, { ...c, mentions: 1 });
          }
        }
      }
    } else if (settled.status === 'rejected') {
      broadcast({ type: 'agent_stream', text: `\n[worker failed: ${settled.reason?.message || 'unknown'}]\n` });
    }
  }

  // Basic dedupe + cross-verify: group claims by URL, count unique sources per claim
  const urlToSources = new Set(allFindings.map(f => f.sourceUrl).filter(Boolean));
  broadcast({ type: 'research_gather_complete', findingsCount: allFindings.length, uniqueSources: urlToSources.size, candidateCount: allCandidates.size });

  if (task.aborted) return;

  // ────── PHASE 3: RANK + COMPARE (Lead again, Opus) ──────
  broadcast({ type: 'agent_stream', text: `\n[research phase 3/6: ranking + comparing with rubric]\n` });
  broadcast({ type: 'agent_spawned', agentId: leadId + ':rank', role: 'planner', model: leadProfile.model });

  const findingsJson = JSON.stringify(allFindings.slice(0, 100), null, 2).slice(0, 30000);
  const candidatesJson = JSON.stringify([...allCandidates.values()], null, 2).slice(0, 5000);

  const rankResult = await withPhaseTimeout('rank', TIMEOUTS.rank, task, broadcast, () => runAgent({
    lightweight: true,  // skip Serena — ranking is pure reasoning over findings
    prompt: `Phase 3 of the research: rank and compare the candidate options using the rubric.

ORIGINAL QUERY: ${query}
${focusArea ? `FOCUS AREA: ${focusArea}\n` : ''}

PLAN:
${JSON.stringify({ summary: plan.summary, rubric: plan.rubric, hexisContext: plan.hexisContext }, null, 2)}

CANDIDATES (${allCandidates.size} unique, deduped by name):
${candidatesJson}

FINDINGS (${allFindings.length} claims across ${urlToSources.size} unique sources):
${findingsJson}

Steps:
1. Take the top 3-5 candidates by mention count + relevance.
2. For each candidate, score on EACH rubric criterion from 1-5 using the findings as evidence. Be honest — do not inflate.
3. Use npm_info / github_search / web_fetch to fill ANY gaps in your rubric scoring. You have full research tools.
4. Compute total score per candidate.
5. Pick the #1 recommendation. It must clearly dominate on most criteria.
6. Output a structured JSON object matching the INTERIM_RANKING_SCHEMA. The shortlist must contain AT LEAST 2 entries (ideally 3), each with full per-criterion scores and a totalScore. The critic runs next so don't write the full report yet — just the interim ranking.`,
    cwd: repoPath,
    systemPrompt: `You are the research LEAD. In this phase you rank candidates against the rubric using the findings gathered by your workers. You can call additional research tools if you need to verify specific criteria (especially Maintenance — check last npm publish date, last github commit). Be rigorous and honest. Emit the structured JSON as your final response.`,
    tools: RESEARCH_TOOLS,
    permissionMode: 'plan',
    schema: INTERIM_RANKING_SCHEMA,
    ...leadProfile,
  }, task, broadcast, leadId + ':rank'));

  addUsage(rankResult);
  broadcast({ type: 'agent_complete', agentId: leadId + ':rank', tokensUsed: rankResult.tokens.output, summary: 'Ranking done' });

  const shortlistInterim = rankResult.structured || {
    topPick: null,
    shortlist: [],
    rubricUsed: plan.rubric || [],
  };

  broadcast({ type: 'research_ranking_complete', shortlist: shortlistInterim.shortlist || [] });

  if (task.aborted) return;

  // ────── PHASE 4: ADVERSARIAL CRITIC ──────
  broadcast({ type: 'agent_stream', text: `\n[research phase 4/6: adversarial critique — trying to prove the top pick wrong]\n` });
  const criticProfile = getProfile('researcher_critic');
  broadcast({ type: 'agent_spawned', agentId: criticId, role: 'reviewer', model: criticProfile.model });

  const topPickName = shortlistInterim?.topPick?.name || shortlistInterim?.shortlist?.[0]?.name || '(unknown)';

  const criticResult = await withPhaseTimeout('critic', TIMEOUTS.critic, task, broadcast, () => runAgent({
    lightweight: true,  // skip Serena — critic uses web/npm/hn/github tools, not code symbols
    prompt: `You are the adversarial critic. Your single job is to try to PROVE the current #1 pick WRONG.

Current top pick: ${topPickName}

Interim shortlist context:
${JSON.stringify(shortlistInterim, null, 2).slice(0, 10000)}

Original query: ${query}
Hexis context: ${plan.hexisContext}

Mission — answer each of these with concrete evidence (use tool calls):
1. Is there any evidence the top pick is being ABANDONED or DEPRECATED? (check npm_info last publish, github recent commits, any GitHub archive notice)
2. What's the WORST known issue? (search github_search type=issues for common complaints, hn_search for rants)
3. What's the real MIGRATION COST if Hexis needs to swap this out later?
4. Is there a serious ALTERNATIVE in the shortlist that the lead under-rated?
5. What would make a developer regret this in 6 months?

For each concern you find, record:
- severity: dealbreaker | major | minor
- evidence: URL or reasoning
- concern: one sentence

At the end, set:
- revisedConfidence (0-1) — after your critique, how confident should the final report be in the #1 pick?
- shouldReRank — true if you found a dealbreaker that invalidates the #1 pick
- betterAlternative — if reranking, name the new #1

Output structured JSON matching CRITIC_SCHEMA. Be RUTHLESS — if you can't find any concerns, search harder. There are always tradeoffs.`,
    cwd: repoPath,
    systemPrompt: `You are an adversarial critic. Your job is to try to disprove a recommendation, not rubber-stamp it. A critic who finds nothing is a critic who didn't try hard enough. Always find at least 2 concerns, even if minor.`,
    tools: RESEARCH_TOOLS,
    permissionMode: 'plan',
    schema: CRITIC_SCHEMA,
    ...criticProfile,
  }, task, broadcast, criticId));

  addUsage(criticResult);
  broadcast({ type: 'agent_complete', agentId: criticId, tokensUsed: criticResult.tokens.output, summary: 'Adversarial critique done' });

  const critique = criticResult.structured || { topPickName, counterArguments: [], revisedConfidence: 0.5, shouldReRank: false };
  broadcast({ type: 'research_critique_complete', critique });

  if (task.aborted) return;

  // ────── PHASE 5: FINAL SYNTHESIS ──────
  broadcast({ type: 'agent_stream', text: `\n[research phase 5/6: final synthesis]\n` });
  broadcast({ type: 'agent_spawned', agentId: leadId + ':synth', role: 'reviewer', model: leadProfile.model });

  const finalResult = await withPhaseTimeout('synth', TIMEOUTS.synth, task, broadcast, () => runAgent({
    lightweight: true,  // skip Serena — synthesis is pure reasoning over prior phases
    prompt: `Final synthesis. Produce the Best Option Guarantee research report.

ORIGINAL QUERY: ${query}
${focusArea ? `FOCUS AREA: ${focusArea}\n` : ''}

PLAN:
${JSON.stringify(plan, null, 2).slice(0, 8000)}

INTERIM RANKING (from Phase 3):
${JSON.stringify(shortlistInterim, null, 2).slice(0, 10000)}

ADVERSARIAL CRITIQUE (from Phase 4):
${JSON.stringify(critique, null, 2)}

RAW FINDINGS COUNT: ${allFindings.length} claims, ${urlToSources.size} unique sources

Your job:
1. If the critic said shouldReRank=true, actually re-rank — swap in betterAlternative as #1.
2. Otherwise, keep the top pick but LOWER the confidence to match the critic's revisedConfidence.
3. Build the final shortlist of 3 candidates (never fewer) with full rubric scoring in the structured output.
4. Write the whyItWins and whenNotToPick for each candidate based on the findings.
5. Write the \`fullMarkdown\` field as a complete human-readable report following the template in the hexis-deep-research skill (TL;DR, Context, Shortlist tables, Adversarial findings, Cross-verification, Open questions, Next steps, References). This is what gets saved to persistent memory by the orchestrator.
6. In "adversarialFindings", summarize the critic's output — not what was NOT found, what WAS found.
7. In "crossVerification", count: cross-verified claims (≥2 unique source URLs making similar claims), unverified claims (1 source), contradictions (claims that directly oppose each other).
8. List 3-5 concrete next steps that could become task board entries.
9. Build a references array with every unique URL cited (id, url, title, accessed).

Output structured JSON matching FINAL_REPORT_SCHEMA. Do NOT call any tools — the orchestrator saves the report to memory automatically after you emit the JSON.`,
    cwd: repoPath,
    systemPrompt: `You are the research LEAD producing the final report. You enforce the Best Option Guarantee: 3+ alternatives, structured rubric, adversarial findings surfaced, every claim cited, confidence calibrated honestly. Honor the critic's findings — don't rubber-stamp the interim ranking.`,
    tools: RESEARCH_TOOLS,
    permissionMode: 'plan',
    schema: FINAL_REPORT_SCHEMA,
    ...leadProfile,
  }, task, broadcast, leadId + ':synth'));

  addUsage(finalResult);
  broadcast({ type: 'agent_complete', agentId: leadId + ':synth', tokensUsed: finalResult.tokens.output, summary: 'Final report ready' });

  const finalReport = finalResult.structured || {};

  // ─── Orchestrator-side save: persist report to memory directly. ───
  // Doing this from the orchestrator (not from the Lead's prompt) because
  // outputFormat: json_schema ends the conversation immediately after the
  // JSON is emitted — any "then call X" instruction in the prompt would
  // never execute. Saving here guarantees it happens.
  try {
    const slug = (finalReport.slug || plan.slug || 'research')
      .replace(/[^a-z0-9-_]/gi, '-').slice(0, 80).toLowerCase();
    const memoryDir = join(repoPath, '.hexis', 'memories', 'research');
    await mkdir(memoryDir, { recursive: true });
    const reportPath = join(memoryDir, `${slug}.md`);
    const markdown = finalReport.fullMarkdown
      || `# Research: ${slug}\n\n(synthesis failed to produce fullMarkdown)\n\n${JSON.stringify(finalReport, null, 2)}`;
    await writeFile(reportPath, markdown, 'utf8');
    broadcast({ type: 'agent_stream', text: `\n[saved research report → .hexis/memories/research/${slug}.md (${markdown.length} bytes)]\n` });
  } catch (saveErr) {
    broadcast({ type: 'agent_stream', text: `\n[⚠ failed to save research report: ${saveErr.message}]\n` });
  }

  broadcast({
    type: 'research_report_ready',
    slug: finalReport.slug || plan.slug,
    verdict: finalReport.verdict || {},
    shortlist: finalReport.shortlist || [],
    crossVerification: finalReport.crossVerification || {},
    openQuestions: finalReport.openQuestions || [],
    nextSteps: finalReport.nextSteps || [],
    referencesCount: (finalReport.references || []).length,
    fullMarkdown: finalReport.fullMarkdown || '',
  });

  if (task.aborted) return;

  // ────── PHASE 6: TASK EXTRACTION (optional) ──────
  if (createTasks && Array.isArray(finalReport.nextSteps) && finalReport.nextSteps.length > 0) {
    broadcast({ type: 'agent_stream', text: `\n[research phase 6/6: extracting ${finalReport.nextSteps.length} next-steps into task board entries]\n` });

    broadcast({
      type: 'research_tasks_ready',
      tasks: finalReport.nextSteps.map(ns => ({
        title: ns.title,
        description: `${ns.description}\n\n📎 From research: ${finalReport.slug}\nVerdict: ${finalReport.verdict?.recommendation || '—'} (confidence ${finalReport.verdict?.confidence || 0})`,
        priority: ns.priority || 'medium',
      })),
      researchSlug: finalReport.slug,
    });
  } else {
    broadcast({ type: 'agent_stream', text: `\n[research phase 6/6: skipped — createTasks=${createTasks}, nextSteps=${(finalReport.nextSteps || []).length}]\n` });
  }

  // ────── DONE ──────
  broadcast({
    type: 'tokens_update', total: totalTokens, cost: totalCost,
    cacheHits: { read: totalCacheRead, creation: totalCacheCreation },
  });
  broadcast({
    type: 'research_complete',
    slug: finalReport.slug || plan.slug,
    verdict: finalReport.verdict || {},
    tokensUsed: totalTokens,
    cost: totalCost,
  });
  broadcast({ type: 'task_complete', tokensUsed: totalTokens, cost: totalCost });
}
