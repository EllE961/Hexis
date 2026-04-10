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

const STORAGE_KEY = 'hexis-chats';
const DEFAULT_CHAT_ID = 'chat-main';

function loadChats() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
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
        messages: (c.messages || []).map(m => ({
          role: m.role,
          content: m.content,
          ts: m.ts,
          tokens: m.tokens,
          cost: m.cost,
        })),
      };
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ chats: slim, activeId }));
  } catch { /* ignore */ }
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
  sendMessage: async (content, targetId = null) => {
    const text = (content || '').trim();
    if (!text) return;
    const s = get();
    const chatId = targetId || s.activeId;
    const chat = s.chats[chatId];
    if (!chat || chat.sending) return;

    // Push user message + mark chat as sending
    const userMsg = { role: 'user', content: text, ts: Date.now() };
    set(state => {
      const chats = { ...state.chats };
      chats[chatId] = {
        ...chat,
        messages: [...chat.messages, userMsg],
        sending: true,
        streamBuffer: '',
        error: null,
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
          message: text,
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
          cost: data.cost || 0,
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
    set(state => {
      const chats = { ...state.chats };
      if (chats[chatId]) {
        chats[chatId] = { ...chats[chatId], sending: false };
      }
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
