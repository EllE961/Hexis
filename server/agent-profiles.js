/**
 * Agent profiles — per-role model + effort configuration.
 *
 * Each role gets the right model for its job:
 *   - Writer:            Haiku   — fast prompt refinement, no deep reasoning
 *   - Classifier:        Haiku   — intent detection (routes read-only vs edit)
 *   - Planner:           Opus    — adaptive thinking, deep code exploration
 *   - Coder:             Sonnet  — code generation with full tools
 *   - Persona reviewer:  Sonnet  — narrow-focus specialists (correctness/security/style)
 *   - Final reviewer:    Opus    — adaptive thinking, merges persona findings
 *
 * Note on budgets:
 *   Hexis runs on a Claude subscription (OAuth), not per-token billing, so
 *   `maxBudgetUsd` is intentionally omitted. Runaway protection is via
 *   `maxTurns` + stuck-loop detection in the orchestrator. Do NOT re-add
 *   budget fields — the SDK treats them as hard caps and has been known
 *   to terminate legit Opus planner runs mid-exploration.
 *
 * Note on fallback:
 *   Opus roles use `fallbackModel: 'sonnet'` — if Opus is overloaded, the
 *   SDK retries with Sonnet automatically.
 *
 * Note on thinking:
 *   Opus 4.6 uses `thinking: { type: 'adaptive' }` (model decides depth).
 *   This is Opus 4.6's default but we set it explicitly for clarity.
 */

export const PROFILES = {
  writer: {
    model: 'haiku',
    effort: 'low',
    maxTurns: 12,
  },
  classifier: {
    model: 'haiku',
    effort: 'low',
    maxTurns: 3,
  },
  planner: {
    model: 'opus',
    effort: 'high',
    maxTurns: 40,
    thinking: { type: 'adaptive' },
    fallbackModel: 'sonnet',
  },
  coder: {
    model: 'sonnet',
    effort: 'high',
    maxTurns: 80,
  },
  persona_reviewer: {
    model: 'sonnet',
    effort: 'medium',
    maxTurns: 20,
  },
  final_reviewer: {
    model: 'opus',
    effort: 'high',
    maxTurns: 25,
    thinking: { type: 'adaptive' },
    fallbackModel: 'sonnet',
  },
  analyst: {
    model: 'sonnet',
    effort: 'medium',
    maxTurns: 15,
  },

  // ─── Chat mode ───
  // Direct conversational agent — no pipeline, just `runAgent` with resume.
  // Same models / tools / hooks as the Coder, but driven turn-by-turn from
  // the Chat panel instead of a one-shot task. This is the "Claude Code
  // directly, inside Hexis" mode.
  //
  // NOTE on fallbackModel: the Claude Agent SDK throws
  // "Fallback model cannot be the same as the main model" if both fields
  // match. Sonnet has no sensible fallback (Haiku is a major step down
  // in capability) — so we leave fallbackModel OFF. If Sonnet is
  // overloaded the SDK will surface an overload error and the user can
  // retry, same as VS Code's native Claude Code flow.
  chat: {
    model: 'sonnet',
    effort: 'high',
    maxTurns: 40,                   // enough for a single turn's tool chain
    // Skip the per-turn Serena MCP subprocess spawn (~2-5 s cold start).
    // Chat is a conversational loop — users expect Claude-Code-CLI-grade
    // latency, and Glob/Grep/Read cover the 80% case for Q&A and small
    // edits. Agent tasks still get Serena via their own profiles.
    lightweight: true,
  },
  chat_opus: {
    model: 'opus',
    effort: 'high',
    maxTurns: 40,
    thinking: { type: 'adaptive' },
    fallbackModel: 'sonnet',
    lightweight: true,              // same reason as `chat` above
  },

  // ─── Deep Research pipeline roles ───
  // Tuned from a real 14-minute end-to-end test that produced a 100-line
  // report with 14 citations and 5 adversarial findings. Target: 8 minutes.
  //
  // Lead — plans + ranks + synthesizes. Opus with adaptive thinking because
  // the comparison rubric and final verdict need real reasoning.
  researcher_lead: {
    model: 'opus',
    effort: 'high',
    maxTurns: 22,                 // was 35 — plan/rank/synth each use ~8-12 turns
    thinking: { type: 'adaptive' },
    fallbackModel: 'sonnet',
  },
  // Parallel research workers — each takes 1-2 sub-questions and gathers
  // multi-source findings. Bottleneck of the pipeline, so cap aggressively.
  researcher_worker: {
    model: 'sonnet',
    effort: 'medium',
    maxTurns: 12,                 // was 20 — 12 turns ≈ 8-10 tool calls, plenty for 2 sub-Qs
  },
  // Adversarial critic — tries to prove the #1 recommendation wrong.
  // Focused task: look up maintenance, look up issues, decide.
  researcher_critic: {
    model: 'sonnet',
    effort: 'high',
    maxTurns: 10,                 // was 15 — critic is bounded by ~3-5 tool calls
  },
  // Task extractor — reads the final report and spawns task-board entries
  // for any actionable "next steps" the user opted in to.
  researcher_taskifier: {
    model: 'sonnet',
    effort: 'low',
    maxTurns: 6,
  },
};

/** Get a profile by role, with optional overrides. */
export function getProfile(role, overrides = {}) {
  const base = PROFILES[role];
  if (!base) throw new Error(`Unknown agent role: ${role}`);
  return { ...base, ...overrides };
}
