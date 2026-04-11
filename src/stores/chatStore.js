/**
 * chatStore — conversational Hexis agent state.
 *
 * Mirrors a Claude Code CLI session: one chat = one long-lived SDK session
 * that accumulates context across turns. Each user message triggers a single
 * `runAgent` call via `/api/chat/message`, which passes `resume: sessionId`
 * so the agent remembers prior turns.
 *
 * MULTI-SESSION SAFE:
 *   - Each chat has its own messages, sessionId, sending flag, streamBuffer,
 *     and error. Background chats continue streaming while you view another.
 *   - Each chat spawns its own bee on the hex grid via the agentStore bridge
 *     (see onChatEvent → window event → agentStore.ensureChatRun).
 *
 * MEMORY:
 *   - Full access to memory_* MCP tools (view, search, append) via CODER_TOOLS
 *   - getRepoPreamble() automatically prepends AGENTS.md + CLAUDE.md +
 *     learned.md on every turn (handled by runAgent, not here)
 *
 * Persistence: messages + sessionId are persisted per-chat to localStorage.
 * Transient flags (sending, streamBuffer, error) are NOT persisted.
 */

import { create } from 'zustand';

// Per-project scoping: chats are keyed by the server's repo path so
// switching HEXIS_TARGET between projects doesn't leak chat history. The
// actual repo path is discovered async via /api/workspace (or the SSE
// `connected` event), so on first load we boot with the `:default` key
// and then migrate to the repo-specific key once it arrives.
const LEGACY_KEY = 'hexis-chats';
const DEFAULT_SCOPE = ':default';
const DEFAULT_CHAT_ID = 'chat-main';

function storageKey(scope) {
  return `hexis-chats${scope}`;
}

// Simple djb2 hash → short hex, used to turn a long repo path into a
// compact localStorage suffix without dragging in a crypto dependency.
function hashPath(path) {
  let h = 5381;
  const s = String(path || '');
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

let currentScope = DEFAULT_SCOPE;

function loadChats(scope = currentScope) {
  try {
    // Prefer scoped key; fall back to legacy unscoped key ONLY on first
    // load (when migrating an old install). Don't cross-read between
    // different scopes — that's the leak we're fixing.
    const raw =
      localStorage.getItem(storageKey(scope)) ||
      (scope === DEFAULT_SCOPE ? localStorage.getItem(LEGACY_KEY) : null);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function saveChats(chats, activeId) {
  try {
    const slim = {};
    for (const [id, c] of Object.entries(chats)) {
      slim[id] = {
        id: c.id,
        title: c.title,
        createdAt: c.createdAt,
        sessionId: c.sessionId,
        model: c.model,
        lastContextFingerprint: c.lastContextFingerprint,
        messages: (c.messages || []).map(m => ({
          role: m.role,
          content: m.content,
          ts: m.ts,
          tokens: m.tokens,
          tokensIn: m.tokensIn,
          tokensOut: m.tokensOut,
          cachedRead: m.cachedRead,
          cachedNew: m.cachedNew,
          cost: m.cost,
          fileChanges: m.fileChanges,
          mentions: m.mentions,
          missingMentions: m.missingMentions,
          isHandoff: m.isHandoff,
          toolCalls: m.toolCalls,
          interrupted: m.interrupted,
        })),
      };
    }
    localStorage.setItem(storageKey(currentScope), JSON.stringify({ chats: slim, activeId }));
  } catch { /* ignore */ }
}

// Given a user-typed path that didn't exist, find the closest real
// file by (1) exact basename match, (2) case-insensitive basename
// match, (3) substring match on the full path. Returns null if
// nothing reasonable comes up. Used for "did you mean …?" hints on
// @file mentions that 404.
export function suggestClosestPath(missing, projectFiles) {
  if (!missing || !projectFiles?.length) return null;
  const base = missing.split('/').pop()?.toLowerCase() || '';
  if (!base) return null;
  // Exact basename
  for (const p of projectFiles) {
    const pBase = p.split('/').pop()?.toLowerCase() || '';
    if (pBase === base) return p;
  }
  // Same name without extension
  const baseNoExt = base.replace(/\.[^.]+$/, '');
  if (baseNoExt.length > 2) {
    for (const p of projectFiles) {
      const pBase = (p.split('/').pop() || '').toLowerCase();
      const pBaseNoExt = pBase.replace(/\.[^.]+$/, '');
      if (pBaseNoExt === baseNoExt) return p;
    }
  }
  // Substring on full path
  const lower = missing.toLowerCase();
  for (const p of projectFiles) {
    if (p.toLowerCase().includes(lower) || lower.includes(p.toLowerCase())) return p;
  }
  return null;
}

// Pull `@path/to/file.ext` tokens out of chat text. Respects fenced
// code blocks (don't expand @ inside ```…```). Returns deduped list
// in the order they appear in the text.
export function extractMentions(text) {
  if (!text) return [];
  // Strip fenced code blocks first so we don't expand e.g. `@media`
  // inside a CSS sample.
  const stripped = text.replace(/```[\s\S]*?```/g, '');
  // Match @ followed by path-like chars. Allows slashes, dots,
  // dashes, underscores, alphanumerics. Stops at whitespace or
  // punctuation that can't appear in a path.
  const re = /(?:^|[\s(])@([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)/g;
  const seen = new Set();
  const out = [];
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const p = m[1];
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

function newChat(id, title) {
  return {
    id,
    title: title || 'New chat',
    createdAt: Date.now(),
    sessionId: null,
    model: 'sonnet',
    messages: [],
    // transient (not persisted)
    sending: false,
    streamBuffer: '',
    error: null,
  };
}

function initChats() {
  const saved = loadChats();
  if (saved && saved.chats && Object.keys(saved.chats).length > 0) {
    const chats = {};
    for (const [id, c] of Object.entries(saved.chats)) {
      chats[id] = { ...c, sending: false, streamBuffer: '', error: null };
    }
    return { chats, activeId: saved.activeId || Object.keys(chats)[0] };
  }
  return {
    chats: { [DEFAULT_CHAT_ID]: newChat(DEFAULT_CHAT_ID, 'Main chat') },
    activeId: DEFAULT_CHAT_ID,
  };
}

const initial = initChats();

// ─── Helper: emit a DOM custom event so agentStore can pick it up ───
// (Avoids a direct circular import between the two stores.)
function emitChatBridge(detail) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('hexis:chat-event', { detail }));
  }
}

export const useChatStore = create((set, get) => ({
  chats: initial.chats,
  activeId: initial.activeId,
  scope: DEFAULT_SCOPE,

  // Called once at startup when the server reports the real repo path
  // (via the SSE `connected` event or /api/workspace). Rehydrates the
  // store from the project-scoped localStorage key instead of the
  // generic `:default` key, and starts writing to the scoped key so
  // future sessions for this project reuse their own history.
  setRepoScope: (repoPath) => {
    if (!repoPath) return;
    const nextScope = `:${hashPath(repoPath)}`;
    if (nextScope === get().scope) return;
    currentScope = nextScope;
    const saved = loadChats(nextScope);
    if (saved && saved.chats && Object.keys(saved.chats).length > 0) {
      const chats = {};
      for (const [id, c] of Object.entries(saved.chats)) {
        chats[id] = { ...c, sending: false, streamBuffer: '', error: null };
      }
      set({
        chats,
        activeId: saved.activeId || Object.keys(chats)[0],
        scope: nextScope,
      });
    } else {
      // First time seeing this project — start fresh, don't leak the
      // default-scope chats into the new project's storage.
      const id = DEFAULT_CHAT_ID;
      const chats = { [id]: newChat(id, 'Main chat') };
      set({ chats, activeId: id, scope: nextScope });
      saveChats(chats, id);
    }
  },

  // ─── Chat lifecycle ───

  createChat: (title = 'New chat') => {
    const id = `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    set(s => {
      const chats = { ...s.chats, [id]: newChat(id, title) };
      saveChats(chats, id);
      return { chats, activeId: id };
    });
    return id;
  },

  selectChat: (id) => set(s => {
    if (!s.chats[id]) return s;
    saveChats(s.chats, id);
    return { activeId: id };
  }),

  deleteChat: async (id) => {
    try {
      await fetch('/api/chat/dispose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: id }),
      }).catch(() => {});
    } catch {}
    set(s => {
      const chats = { ...s.chats };
      delete chats[id];
      let activeId = s.activeId;
      if (activeId === id) {
        const remaining = Object.keys(chats);
        if (remaining.length > 0) {
          activeId = remaining[remaining.length - 1];
        } else {
          chats[DEFAULT_CHAT_ID] = newChat(DEFAULT_CHAT_ID, 'Main chat');
          activeId = DEFAULT_CHAT_ID;
        }
      }
      saveChats(chats, activeId);
      return { chats, activeId };
    });
  },

  clearMessages: (id) => set(s => {
    const chats = { ...s.chats };
    if (!chats[id]) return s;
    chats[id] = { ...chats[id], messages: [], sessionId: null, streamBuffer: '', error: null };
    saveChats(chats, s.activeId);
    return { chats };
  }),

  setModel: (id, model) => set(s => {
    const chats = { ...s.chats };
    if (!chats[id]) return s;
    chats[id] = { ...chats[id], model };
    saveChats(chats, s.activeId);
    return { chats };
  }),

  renameChat: (id, title) => set(s => {
    const chats = { ...s.chats };
    if (!chats[id]) return s;
    chats[id] = { ...chats[id], title: title || 'Untitled' };
    saveChats(chats, s.activeId);
    return { chats };
  }),

  // ─── Send a message (uses CURRENT chat or a passed-in id) ───
  //
  // Safe for multiple concurrent calls — each chat has its own sending flag
  // and streamBuffer, so background chats keep working while you view another.
  //
  // Slash commands:
  //   /research <query>   — route to agentStore.submitResearchTask (6-phase
  //                         research pipeline). Use for "best way to…",
  //                         library comparisons, architecture vetting.
  //   /task <description> — route to agentStore.submitTask (full
  //                         Writer/Planner/Coder/Critic pipeline). Use when
  //                         you KNOW you want the review gate.
  //
  // Each command posts a synthetic user message to the chat so the
  // conversation history reflects what was asked, then an assistant
  // "kicked off" follow-up once the agent run completes.
  sendMessage: async (content, targetId = null) => {
    const text = (content || '').trim();
    if (!text) return;
    const s = get();
    const chatId = targetId || s.activeId;
    const chat = s.chats[chatId];
    if (!chat || chat.sending) return;

    // ─── Session commands — pure client-side, no agent ───
    // These don't go through the HTTP chat flow at all; they mutate
    // chat state or open a help message locally. Claude-Code parity.
    if (/^\/clear(?:\s|$)/i.test(text)) {
      get().clearMessages(chatId);
      return;
    }
    if (/^\/help(?:\s|$)/i.test(text)) {
      const helpText = [
        '## Chat commands',
        '',
        '- `/research <query>` — deep 6-phase research pipeline',
        '- `/task <description>` — full Writer → Planner → Coder → Critic pipeline',
        '- `/clear` — wipe this chat\'s messages and session',
        '- `/model sonnet` or `/model opus` — switch model for this chat',
        '- `/help` — show this message',
        '',
        '## Keyboard shortcuts',
        '',
        '- **Ctrl+/** — focus chat input from anywhere',
        '- **Esc** — panic button, return to chat prompt',
        '- **Ctrl+E** — toggle editor panel',
        '- **Ctrl+K** — command palette',
        '- **↑ / ↓** — recall previous chat messages',
        '- **@** — reference a project file',
        '- **Enter** — send · **Shift+Enter** — newline',
      ].join('\n');
      set(state => {
        const chats = { ...state.chats };
        const c = chats[chatId];
        if (!c) return state;
        chats[chatId] = {
          ...c,
          messages: [
            ...c.messages,
            { role: 'user', content: text, ts: Date.now() },
            { role: 'assistant', content: helpText, ts: Date.now(), isHandoff: true },
          ],
        };
        saveChats(chats, state.activeId);
        return { chats };
      });
      return;
    }
    if (/^\/mem\s+consolidate(?:\s|$)/i.test(text)) {
      // Run the Haiku consolidator over learned.md. Shows the before→after
      // counts and a preview of the new file as a chat reply.
      set(state => {
        const chats = { ...state.chats };
        const c = chats[chatId];
        if (!c) return state;
        chats[chatId] = {
          ...c,
          messages: [...c.messages, { role: 'user', content: text, ts: Date.now() }],
          sending: true,
          streamBuffer: '',
          error: null,
        };
        saveChats(chats, state.activeId);
        return { chats };
      });
      try {
        const res = await fetch('/api/memory/consolidate', { method: 'POST' });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
        const reply =
          `**Memory consolidated** — ${data.before} → ${data.after} rules.\n\n` +
          `Backup saved to \`${data.backup}\`.\n\n` +
          `---\n\n${data.preview}\n\n---\n\nYou can view the full updated file in the Memory panel.`;
        set(state => {
          const chats = { ...state.chats };
          const c = chats[chatId];
          if (!c) return state;
          chats[chatId] = {
            ...c,
            messages: [...c.messages, { role: 'assistant', content: reply, ts: Date.now(), isHandoff: true }],
            sending: false,
            streamBuffer: '',
          };
          saveChats(chats, state.activeId);
          return { chats };
        });
      } catch (err) {
        set(state => {
          const chats = { ...state.chats };
          const c = chats[chatId];
          if (!c) return state;
          chats[chatId] = {
            ...c,
            sending: false,
            error: err.message || String(err),
          };
          saveChats(chats, state.activeId);
          return { chats };
        });
      }
      return;
    }

    const memSearchMatch = /^\/mem\s+search\s+([\s\S]+)$/i.exec(text);
    if (memSearchMatch) {
      const q = memSearchMatch[1].trim();
      if (!q) return;
      try {
        const res = await fetch(`/api/memory/search?q=${encodeURIComponent(q)}&limit=10`);
        const data = await res.json();
        const results = data.results || [];
        const reply = results.length === 0
          ? `No memory rules match **"${q}"**. Try a broader query or star some messages with the ★ button to seed memory.`
          : `Top ${results.length} memory ${results.length === 1 ? 'rule' : 'rules'} for **"${q}"**:\n\n${results.map(r => `- ${r.rule}`).join('\n')}`;
        set(state => {
          const chats = { ...state.chats };
          const c = chats[chatId];
          if (!c) return state;
          chats[chatId] = {
            ...c,
            messages: [
              ...c.messages,
              { role: 'user', content: text, ts: Date.now() },
              { role: 'assistant', content: reply, ts: Date.now(), isHandoff: true },
            ],
          };
          saveChats(chats, state.activeId);
          return { chats };
        });
      } catch (err) {
        set(state => {
          const chats = { ...state.chats };
          const c = chats[chatId];
          if (!c) return state;
          chats[chatId] = { ...c, error: err.message || String(err) };
          return { chats };
        });
      }
      return;
    }

    if (/^\/compact(?:\s|$)/i.test(text)) {
      // Summarize all but the most recent 2 turns (4 messages) into
      // a single "earlier conversation" block, then reset the session
      // so the next turn starts fresh. Keeps context, frees tokens.
      const allMessages = chat.messages || [];
      const keepFromIdx = Math.max(0, allMessages.length - 4);
      const toSummarize = allMessages.slice(0, keepFromIdx).filter(m => !m.isHandoff);
      const keptTail = allMessages.slice(keepFromIdx);

      if (toSummarize.length < 2) {
        // Nothing meaningful to compact
        set(state => {
          const chats = { ...state.chats };
          const c = chats[chatId];
          if (!c) return state;
          chats[chatId] = {
            ...c,
            messages: [
              ...c.messages,
              { role: 'user', content: text, ts: Date.now() },
              {
                role: 'assistant',
                content: 'Nothing to compact yet — need at least 2 earlier turns. Keep chatting and try `/compact` again when the history grows.',
                ts: Date.now(),
                isHandoff: true,
              },
            ],
          };
          saveChats(chats, state.activeId);
          return { chats };
        });
        return;
      }

      // Mark sending so the UI shows a progress indicator
      set(state => {
        const chats = { ...state.chats };
        const c = chats[chatId];
        if (!c) return state;
        chats[chatId] = {
          ...c,
          messages: [...c.messages, { role: 'user', content: text, ts: Date.now() }],
          sending: true,
          streamBuffer: '',
          error: null,
        };
        saveChats(chats, state.activeId);
        return { chats };
      });

      try {
        const res = await fetch('/api/chat/compact', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            turns: toSummarize.map(m => ({ role: m.role, content: m.content })),
          }),
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);

        // Replace the older messages with a single summary entry +
        // reset sessionId so the next real turn starts fresh from
        // the summary (not from the old full transcript).
        set(state => {
          const chats = { ...state.chats };
          const c = chats[chatId];
          if (!c) return state;
          const summaryMsg = {
            role: 'assistant',
            content: `**Earlier conversation (compacted, ${toSummarize.length} turns):**\n\n${data.summary}`,
            ts: Date.now(),
            isHandoff: true,
          };
          chats[chatId] = {
            ...c,
            sessionId: null,
            messages: [
              summaryMsg,
              ...keptTail,
              {
                role: 'assistant',
                content: `Compacted ${toSummarize.length} earlier turns into a summary. Session reset — next turn starts with a fresh cache.`,
                ts: Date.now(),
                isHandoff: true,
              },
            ],
            sending: false,
            streamBuffer: '',
            error: null,
          };
          saveChats(chats, state.activeId);
          return { chats };
        });
      } catch (err) {
        set(state => {
          const chats = { ...state.chats };
          const c = chats[chatId];
          if (!c) return state;
          chats[chatId] = { ...c, sending: false, error: err.message || String(err) };
          saveChats(chats, state.activeId);
          return { chats };
        });
      }
      return;
    }

    const modelMatch = /^\/model\s+(sonnet|opus)\b/i.exec(text);
    if (modelMatch) {
      const newModel = modelMatch[1].toLowerCase();
      get().setModel(chatId, newModel);
      set(state => {
        const chats = { ...state.chats };
        const c = chats[chatId];
        if (!c) return state;
        chats[chatId] = {
          ...c,
          messages: [
            ...c.messages,
            { role: 'user', content: text, ts: Date.now() },
            {
              role: 'assistant',
              content: `Model switched to **${newModel}** for this chat. Future turns will use ${newModel === 'opus' ? 'Opus (with adaptive thinking)' : 'Sonnet'}.`,
              ts: Date.now(),
              isHandoff: true,
            },
          ],
        };
        saveChats(chats, state.activeId);
        return { chats };
      });
      return;
    }

    // Slash-command detection (must come BEFORE the chat turn flow so
    // we don't use up a chat session ID on commands that aren't chat).
    const slashMatch = /^\/(research|task)\s+([\s\S]+)$/i.exec(text);
    if (slashMatch) {
      const verb = slashMatch[1].toLowerCase();
      const body = slashMatch[2].trim();
      if (!body) return;

      // Record the user message in the chat log so history is complete.
      const userMsg = { role: 'user', content: text, ts: Date.now() };
      set(state => {
        const chats = { ...state.chats };
        const c = chats[chatId];
        if (!c) return state;
        chats[chatId] = { ...c, messages: [...c.messages, userMsg] };
        saveChats(chats, state.activeId);
        return { chats };
      });

      // Dynamic import avoids a circular dep if someone ever wires
      // agentStore to import chatStore.
      const { useAgentStore } = await import('./agentStore.js');
      const agent = useAgentStore.getState();

      try {
        if (verb === 'research') {
          await agent.submitResearchTask(body, { createTasks: false });
        } else {
          await agent.submitTask(body);
        }

        // Drop a system-ish message so the chat shows the hand-off.
        const note = verb === 'research'
          ? `Started deep research → "${body.slice(0, 80)}${body.length > 80 ? '…' : ''}" — watch the AI Agents panel for phase-by-phase progress.`
          : `Queued full agent task → "${body.slice(0, 80)}${body.length > 80 ? '…' : ''}" — Writer/Planner/Coder/Critic pipeline running in the AI Agents panel.`;
        set(state => {
          const chats = { ...state.chats };
          const c = chats[chatId];
          if (!c) return state;
          chats[chatId] = {
            ...c,
            messages: [...c.messages, {
              role: 'assistant',
              content: note,
              ts: Date.now(),
              isHandoff: true,
            }],
          };
          saveChats(chats, state.activeId);
          return { chats };
        });
      } catch (err) {
        set(state => {
          const chats = { ...state.chats };
          const c = chats[chatId];
          if (!c) return state;
          chats[chatId] = { ...c, error: err.message || String(err) };
          return { chats };
        });
      }
      return;
    }

    // Auto-inject editor + git context as a compact header block.
    //
    // **Smart diffing**: We compute a `contextFingerprint` of the
    // current editor+git state (just the tuple of relevant fields).
    // If it matches `chat.lastContextFingerprint`, we skip
    // re-injection — the agent already has this context from a
    // prior turn in this session. Saves ~50-150 tokens per
    // steady-state turn where nothing changed.
    //
    // Memory rules re-inject every turn because the "relevant"
    // set depends on the specific prompt.
    let contextHeader = '';
    const contextParts = [];
    let nextContextFingerprint = chat.lastContextFingerprint || null;
    try {
      const { useEditorStore } = await import('./editorStore.js');
      const { useGitStore } = await import('./gitStore.js');
      const editor = useEditorStore.getState();
      const git = useGitStore.getState();
      const activeFile = editor.activeTab || null;
      const changed = [
        ...(git.staged || []),
        ...(git.modified || []),
        ...(git.untracked || []),
      ].slice(0, 5);
      // Fingerprint: ignore order changes, just care about set membership
      const fp = JSON.stringify({
        a: activeFile,
        c: [...changed].sort(),
      });
      // Inject the header when:
      //   - it's the first turn of a session (no prior fingerprint), OR
      //   - the fingerprint changed (user opened a different file,
      //     git status changed, etc)
      const shouldInject = !chat.sessionId || fp !== chat.lastContextFingerprint;
      if (shouldInject) {
        if (activeFile) {
          contextParts.push(`**Currently viewing**: \`${activeFile}\``);
        }
        if (changed.length > 0) {
          contextParts.push(`**Recently changed** (uncommitted): ${changed.map(f => `\`${f}\``).join(', ')}`);
        }
        nextContextFingerprint = fp;
      }
    } catch {}
    // Memory rules — auto-inject the top 3 for the current prompt.
    // Only fires if the user's message has >= 2 meaningful words.
    // Passes the list of "current focus files" (editor active tab +
    // extracted @mentions) as a `files` filter so scoped rules get
    // boosted when their glob matches one of those paths.
    try {
      const meaningful = text.trim().split(/\s+/).filter(w => w.length > 3).length;
      if (meaningful >= 2) {
        const focusFiles = [];
        try {
          const { useEditorStore } = await import('./editorStore.js');
          const active = useEditorStore.getState().activeTab;
          if (active) focusFiles.push(active);
        } catch {}
        // @mentions already extracted earlier in this function —
        // re-extract here so we can use them for rule scoping.
        for (const p of extractMentions(text)) focusFiles.push(p);
        const params = new URLSearchParams({
          q: text.slice(0, 200),
          limit: '3',
        });
        if (focusFiles.length > 0) params.set('files', focusFiles.join(','));
        const res = await fetch(`/api/memory/search?${params.toString()}`);
        if (res.ok) {
          const data = await res.json();
          const rules = (data.results || []).map(r => {
            const scopeNote = r.scopes?.length > 0
              ? ` _(scope: ${r.scopes.join(', ')})_`
              : '';
            return `- ${r.rule}${scopeNote}`;
          });
          if (rules.length > 0) {
            contextParts.push(
              `**Project conventions (from learned.md, matched to your prompt):**\n${rules.join('\n')}`,
            );
          }
        }
      }
    } catch {}
    if (contextParts.length > 0) {
      contextHeader =
        `[session context — don't re-fetch, these are injected automatically]\n` +
        contextParts.join('\n\n') + '\n\n---\n\n';
    }

    // Detect @file mentions and expand them to real content.
    // Walk the raw text for `@path/to/file.ext` tokens, fetch each
    // file's content from the server, and prepend the resolved
    // bodies as a context block. This saves the agent a Read()
    // tool round-trip and makes @ references actually useful.
    //
    // Rules:
    //   - Max 6 mentions per turn (don't blow out the context)
    //   - Each file truncated to 400 lines / 32 KB (whichever smaller)
    //   - Files not found silently skipped
    //   - The original text is still sent; context block just
    //     prepends it. The user still sees their message verbatim
    //     in the chat log.
    const mentionedPaths = extractMentions(text);
    let augmentedPrompt = contextHeader + text;
    const resolvedMentions = [];
    const missingMentions = [];
    if (mentionedPaths.length > 0) {
      const toFetch = mentionedPaths.slice(0, 6);
      // Fetch in parallel; a 404 means the file doesn't exist —
      // we record it as a "missing" mention so the UI can flag
      // it with a "did you mean …?" suggestion.
      const results = await Promise.all(
        toFetch.map(p =>
          fetch(`/api/file?path=${encodeURIComponent(p)}`)
            .then(async r => ({ ok: r.ok, status: r.status, path: p, data: r.ok ? await r.json() : null }))
            .catch(() => ({ ok: false, status: 0, path: p, data: null }))
        )
      );
      const blocks = [];

      // Load the project file list once (for "did you mean" suggestions
      // on missing paths). Fallback to [] if the fetch fails.
      let projectFiles = [];
      if (results.some(r => !r.ok)) {
        try {
          const g = await fetch('/api/graph').then(r => r.ok ? r.json() : null);
          projectFiles = (g?.nodes || []).map(n => n.id).filter(Boolean);
        } catch {}
      }

      for (const r of results) {
        if (r.ok && r.data?.content) {
          let body = r.data.content;
          const lines = body.split('\n');
          if (lines.length > 400) {
            body = lines.slice(0, 400).join('\n') +
                   `\n\n[… ${lines.length - 400} more lines truncated]`;
          }
          if (body.length > 32_768) {
            body = body.slice(0, 32_768) + '\n\n[… truncated at 32 KB]';
          }
          blocks.push(`### @${r.data.path}\n\`\`\`\n${body}\n\`\`\``);
          resolvedMentions.push(r.data.path);
        } else {
          // Missing file — find the closest match in the project
          // by simple substring / basename match
          const suggestion = suggestClosestPath(r.path, projectFiles);
          missingMentions.push({ path: r.path, suggestion });
        }
      }

      if (blocks.length > 0) {
        augmentedPrompt =
          contextHeader +
          `The user is referencing these files. Their contents are included inline — do NOT re-read them unless you need to see changes made during this turn.\n\n` +
          blocks.join('\n\n') +
          `\n\n---\n\n${text}`;
      }
    }

    // Push user message + mark chat as sending. The user sees their
    // original message (with `@` syntax preserved); the augmented
    // prompt is only sent to the agent.
    const userMsg = {
      role: 'user',
      content: text,
      ts: Date.now(),
      mentions: resolvedMentions,
      missingMentions,
    };
    set(state => {
      const chats = { ...state.chats };
      chats[chatId] = {
        ...chat,
        messages: [...chat.messages, userMsg],
        sending: true,
        streamBuffer: '',
        error: null,
        // Record the fingerprint so the next turn can skip
        // re-injecting unchanged editor+git state.
        lastContextFingerprint: nextContextFingerprint,
      };
      saveChats(chats, state.activeId);
      return { chats };
    });

    // Notify agentStore bridge so a bee can spawn on the hex grid
    emitChatBridge({
      type: 'chat_started',
      chatId,
      model: chat.model || 'sonnet',
    });

    try {
      const res = await fetch('/api/chat/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId,
          // Send the augmented prompt (with @file expansions) to the
          // agent, not the bare text. The user still sees their
          // original text in the chat history — augmentedPrompt is
          // purely a server-side context injection.
          message: augmentedPrompt,
          sessionId: chat.sessionId || null,
          model: chat.model || 'sonnet',
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);

      set(state => {
        const chats = { ...state.chats };
        const c = chats[chatId];
        if (!c) return state;
        const assistantMsg = {
          role: 'assistant',
          content: data.text || c.streamBuffer || '',
          ts: Date.now(),
          tokens: data.tokens || 0,
          tokensIn: data.tokensIn || 0,
          tokensOut: data.tokensOut || 0,
          cachedRead: data.cachedRead || 0,
          cachedNew: data.cachedNew || 0,
          cost: data.cost || 0,
          fileChanges: data.fileChanges || [],
          toolCalls: data.toolCalls || [],
        };
        // Auto-title from first user message while title is still default
        const title = (c.title === 'Main chat' || c.title === 'New chat') && c.messages.length <= 2
          ? text.slice(0, 40) + (text.length > 40 ? '…' : '')
          : c.title;
        chats[chatId] = {
          ...c,
          sessionId: data.sessionId || c.sessionId,
          messages: [...c.messages, assistantMsg],
          sending: false,
          streamBuffer: '',
          error: null,
          title,
        };
        saveChats(chats, state.activeId);
        return { chats };
      });

      emitChatBridge({ type: 'chat_finished', chatId });
    } catch (err) {
      set(state => {
        const chats = { ...state.chats };
        const c = chats[chatId];
        if (!c) return state;
        chats[chatId] = { ...c, sending: false, error: err.message || String(err) };
        return { chats };
      });
      emitChatBridge({ type: 'chat_finished', chatId, error: true });
    }
  },

  cancelSend: async (targetId = null) => {
    const s = get();
    const chatId = targetId || s.activeId;
    try {
      await fetch('/api/chat/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId }),
      });
    } catch {}
    // Preserve the partial response as a finished assistant message
    // so the user can read it AND the next `continue` turn can
    // resume from that context. We append the partial streamBuffer
    // as an `interrupted: true` message so the UI can style it
    // differently.
    set(state => {
      const chats = { ...state.chats };
      const c = chats[chatId];
      if (!c) return state;
      const partial = c.streamBuffer || '';
      const messages = [...c.messages];
      if (partial.trim()) {
        messages.push({
          role: 'assistant',
          content: partial,
          ts: Date.now(),
          interrupted: true,
        });
      }
      chats[chatId] = {
        ...c,
        sending: false,
        streamBuffer: '',
        messages,
      };
      saveChats(chats, state.activeId);
      return { chats };
    });
    emitChatBridge({ type: 'chat_finished', chatId, cancelled: true });
  },

  // ─── SSE event handler — routes stream tokens to the correct chat ───
  //
  // Called from App.jsx's SSE listener with every agent event. Filters
  // by chatId so each chat accumulates its OWN streamBuffer — background
  // chats keep rendering live even when another chat is visible.
  onChatEvent: (event) => {
    const { type, chatId } = event;
    if (!chatId) return;

    if (type === 'agent_stream' && typeof event.text === 'string') {
      set(state => {
        const chats = { ...state.chats };
        const c = chats[chatId];
        if (!c || !c.sending) return state;
        chats[chatId] = { ...c, streamBuffer: c.streamBuffer + event.text };
        return { chats };
      });
    } else if (type === 'chat_turn_failed') {
      set(state => {
        const chats = { ...state.chats };
        const c = chats[chatId];
        if (!c) return state;
        chats[chatId] = { ...c, sending: false, error: event.error || 'turn failed' };
        return { chats };
      });
    }
  },
}));
