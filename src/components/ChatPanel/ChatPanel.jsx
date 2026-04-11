/**
 * ChatPanel — "Claude Code directly, inside Hexis".
 *
 * Conversational agent: one chat = one long-lived SDK session that
 * accumulates context across turns. No pipeline, no ceremony — just a
 * single agent with full tool access, Hexis memory/skills, and per-turn
 * SDK session resume. Use this for 80% of day-to-day coding where you
 * want iteration + quick response instead of the full multi-agent review.
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import { useChatStore } from '../../stores/chatStore.js';
import { Icon } from '../common/Icon.jsx';
import { W } from '../../theme/window-tokens.js';

export default function ChatPanel() {
  const chats = useChatStore(s => s.chats);
  const activeId = useChatStore(s => s.activeId);
  const sendMessage = useChatStore(s => s.sendMessage);
  const cancelSend = useChatStore(s => s.cancelSend);
  const createChat = useChatStore(s => s.createChat);
  const selectChat = useChatStore(s => s.selectChat);
  const deleteChat = useChatStore(s => s.deleteChat);
  const clearMessages = useChatStore(s => s.clearMessages);
  const setModel = useChatStore(s => s.setModel);

  const [input, setInput] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMatch, setSearchMatch] = useState(0);
  const scrollRef = useRef(null);
  const textareaRef = useRef(null);
  const searchInputRef = useRef(null);

  // File-mention autocomplete state.
  // When the user types `@` followed by a partial path, we show a
  // popup of matching project files. Fetched lazily on first open
  // and cached for the session. Keyboard-navigable with ↑/↓/Enter.
  const [fileList, setFileList] = useState([]);
  const [mention, setMention] = useState(null); // { query, startIdx, activeIdx }
  useEffect(() => {
    if (fileList.length > 0) return;
    fetch('/api/graph')
      .then(r => r.json())
      .then(d => setFileList((d.nodes || []).map(n => n.id).filter(Boolean)))
      .catch(() => {});
  }, [fileList.length]);

  const chat = chats[activeId];
  const messages = chat?.messages || [];
  // Per-chat transient state — each chat has its own sending/streamBuffer/error
  // so background chats keep streaming while you view another.
  const sending = chat?.sending || false;
  const streamBuffer = chat?.streamBuffer || '';
  const error = chat?.error || null;

  const sortedChats = useMemo(
    () => Object.values(chats).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    [chats],
  );
  // Count of chats currently streaming (for the topbar badge)
  const activeChatCount = useMemo(
    () => Object.values(chats).filter(c => c.sending).length,
    [chats],
  );

  // Auto-scroll on new messages / streaming tokens
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length, streamBuffer, sending]);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 240) + 'px';
  }, [input]);

  // Autofocus the textarea on mount and whenever the active chat changes,
  // so "open Hexis → start typing" works without a mouse click. Guard
  // against stealing focus from modals, the editor, or another text input.
  // We poll for a moment because the panel may be behind another tab in
  // its dock zone — we only focus once the textarea becomes visible.
  useEffect(() => {
    const shouldFocus = () => {
      const active = document.activeElement;
      if (!active || active === document.body) return true;
      const tag = active.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false;
      if (active.closest?.('.cm-editor')) return false;
      if (active.closest?.('[role="dialog"]')) return false;
      return true;
    };
    if (!shouldFocus()) return;
    let cancelled = false;
    let tries = 0;
    const tick = () => {
      if (cancelled) return;
      const ta = textareaRef.current;
      if (ta && ta.offsetWidth > 0 && ta.offsetHeight > 0) {
        ta.focus();
        return;
      }
      if (tries++ < 20) setTimeout(tick, 50); // retry up to ~1 second
    };
    tick();
    return () => { cancelled = true; };
  }, [activeId]);

  // Listen for global `hexis:focus-chat` events (fired by Ctrl+/ from
  // anywhere in the app). Unconditionally focuses — unlike the mount
  // effect, the user explicitly asked for it.
  useEffect(() => {
    const onFocus = () => textareaRef.current?.focus();
    window.addEventListener('hexis:focus-chat', onFocus);
    return () => window.removeEventListener('hexis:focus-chat', onFocus);
  }, []);

  // Ctrl+F inside the chat panel → open search bar.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
        // Only if the focus is inside the chat panel
        const focused = document.activeElement;
        const inChat = focused?.closest?.('[data-hexis-chat-panel]');
        if (inChat) {
          e.preventDefault();
          setSearchOpen(true);
          setTimeout(() => searchInputRef.current?.focus(), 0);
        }
      }
      if (e.key === 'Escape' && searchOpen) {
        setSearchOpen(false);
        setSearchQuery('');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [searchOpen]);

  // Compute search matches from the messages list.
  const searchMatches = useMemo(() => {
    if (!searchOpen || !searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    return messages
      .map((m, i) => ({ i, m, hit: (m.content || '').toLowerCase().includes(q) }))
      .filter(x => x.hit);
  }, [searchOpen, searchQuery, messages]);

  const handleSubmit = (e) => {
    e?.preventDefault?.();
    if (!input.trim() || sending) return;
    const text = input;
    setInput('');
    // Reset history cursor so the next ↑ starts from the most recent
    historyIdxRef.current = -1;
    sendMessage(text);
  };

  // Terminal-style command history: ↑/↓ walk through previous user
  // messages in this chat. -1 = "not browsing history, input is the
  // user's live draft". 0 = most recent user message.
  const historyIdxRef = useRef(-1);
  const draftBeforeHistoryRef = useRef('');

  // Filter file list by mention query — simple substring match,
  // ranks prefix hits first, cap at 8 results.
  const mentionMatches = useMemo(() => {
    if (!mention) return [];
    const q = (mention.query || '').toLowerCase();
    if (!q) return fileList.slice(0, 8);
    const prefix = [];
    const sub = [];
    for (const path of fileList) {
      const p = path.toLowerCase();
      if (p.startsWith(q)) prefix.push(path);
      else if (p.includes(q)) sub.push(path);
      if (prefix.length >= 8) break;
    }
    return [...prefix, ...sub].slice(0, 8);
  }, [mention, fileList]);

  // Commit a selected mention: replace `@query` at startIdx with
  // `@filePath ` (trailing space so the user can keep typing).
  const commitMention = (path) => {
    if (!mention) return;
    const before = input.slice(0, mention.startIdx);
    const after = input.slice(mention.startIdx + 1 + (mention.query?.length || 0));
    const next = `${before}@${path} ${after}`;
    setInput(next);
    setMention(null);
    // Restore caret position
    setTimeout(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      const pos = (before + '@' + path + ' ').length;
      ta.selectionStart = ta.selectionEnd = pos;
      ta.focus();
    }, 0);
  };

  const handleKey = (e) => {
    // If the mention popup is open, ↑/↓/Enter/Tab/Escape belong to it first
    if (mention && mentionMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMention({ ...mention, activeIdx: (mention.activeIdx + 1) % mentionMatches.length });
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMention({
          ...mention,
          activeIdx: (mention.activeIdx - 1 + mentionMatches.length) % mentionMatches.length,
        });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        commitMention(mentionMatches[mention.activeIdx] || mentionMatches[0]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMention(null);
        return;
      }
    }

    // Enter sends, Shift+Enter adds newline
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
      return;
    }
    // ↑ / ↓ walk command history — only when the textarea caret is
    // at the very start/end (multi-line drafts still get free arrow
    // navigation).
    const ta = textareaRef.current;
    if (!ta) return;
    const userHistory = messages.filter(m => m.role === 'user').map(m => m.content);
    if (userHistory.length === 0) return;

    if (e.key === 'ArrowUp') {
      const atStart = ta.selectionStart === 0 && ta.selectionEnd === 0;
      const multilineCaretMid = input.includes('\n') && !atStart;
      if (multilineCaretMid) return;
      e.preventDefault();
      if (historyIdxRef.current === -1) {
        draftBeforeHistoryRef.current = input;
        historyIdxRef.current = 0;
      } else if (historyIdxRef.current < userHistory.length - 1) {
        historyIdxRef.current++;
      }
      const idx = userHistory.length - 1 - historyIdxRef.current;
      setInput(userHistory[idx]);
      return;
    }
    if (e.key === 'ArrowDown') {
      if (historyIdxRef.current === -1) return; // not in history mode
      const atEnd = ta.selectionStart === input.length && ta.selectionEnd === input.length;
      if (!atEnd && input.includes('\n')) return;
      e.preventDefault();
      if (historyIdxRef.current > 0) {
        historyIdxRef.current--;
        const idx = userHistory.length - 1 - historyIdxRef.current;
        setInput(userHistory[idx]);
      } else {
        historyIdxRef.current = -1;
        setInput(draftBeforeHistoryRef.current);
        draftBeforeHistoryRef.current = '';
      }
      return;
    }
    // Any other key exits history mode — we're back to live typing
    if (historyIdxRef.current !== -1 && e.key.length === 1) {
      historyIdxRef.current = -1;
      draftBeforeHistoryRef.current = '';
    }
  };

  return (
    <div
      data-hexis-chat-panel
      style={{
        display: 'flex',
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        background: W.bg1,
        fontFamily: W.fontFamily,
      }}
    >
      {/* ─── Sidebar: chat list ─── */}
      {sidebarOpen && (
        <div style={{
          width: 220,
          flexShrink: 0,
          borderRight: `1px solid ${W.border}`,
          display: 'flex',
          flexDirection: 'column',
          background: W.bg1,
        }}>
          <div style={{
            padding: `${W.s2}px ${W.s3}px`,
            borderBottom: `1px solid ${W.border}`,
            display: 'flex',
            alignItems: 'center',
            gap: W.s2,
          }}>
            <button
              onClick={() => createChat()}
              title="New chat"
              style={{
                flex: 1,
                padding: `${W.s2}px ${W.s3}px`,
                background: W.accentBg,
                border: `1px solid ${W.borderHi}`,
                borderRadius: W.radius1,
                color: W.accent,
                fontSize: W.fontMd,
                fontWeight: W.fontWeightSemi,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
              }}
            >
              <Icon name="add" size={W.iconSm} color="inherit" />
              New chat
            </button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {sortedChats.map(c => (
              <div
                key={c.id}
                onClick={() => selectChat(c.id)}
                style={{
                  padding: `${W.s2}px ${W.s3}px`,
                  cursor: 'pointer',
                  background: c.id === activeId ? W.bg3 : 'transparent',
                  borderLeft: c.id === activeId ? `2px solid ${W.accent}` : '2px solid transparent',
                  display: 'flex',
                  alignItems: 'center',
                  gap: W.s2,
                  fontSize: W.fontMd,
                }}
                onMouseEnter={e => { if (c.id !== activeId) e.currentTarget.style.background = W.bg2; }}
                onMouseLeave={e => { if (c.id !== activeId) e.currentTarget.style.background = 'transparent'; }}
              >
                <div style={{
                  flex: 1,
                  minWidth: 0,
                  color: c.id === activeId ? W.text : W.textDim,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  display: 'flex',
                  alignItems: 'center',
                  gap: W.s2,
                }}>
                  {/* Per-chat streaming indicator — shows even when this
                      chat is not the active one, so users know background
                      chats are still working. */}
                  {c.sending && (
                    <span
                      title="Streaming…"
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: W.accent,
                        flexShrink: 0,
                        animation: 'hexisPulse 1.4s ease-in-out infinite',
                      }}
                    />
                  )}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.title}
                  </span>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteChat(c.id); }}
                  title="Delete"
                  style={{
                    width: 20,
                    height: 20,
                    border: 'none',
                    background: 'transparent',
                    color: W.textMuted,
                    cursor: 'pointer',
                    borderRadius: W.radius1,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: 0.7,
                  }}
                  onMouseEnter={e => { e.currentTarget.style.color = W.red; e.currentTarget.style.background = W.redBg; e.currentTarget.style.opacity = 1; }}
                  onMouseLeave={e => { e.currentTarget.style.color = W.textMuted; e.currentTarget.style.background = 'transparent'; e.currentTarget.style.opacity = 0.7; }}
                >
                  <Icon name="close" size={W.iconSm} color="inherit" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── Main chat column ─── */}
      <div style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
      }}>
        {/* Topbar */}
        <div style={{
          flexShrink: 0,
          padding: `${W.s2}px ${W.s3}px`,
          background: W.bg2,
          borderBottom: `1px solid ${W.border}`,
          display: 'flex',
          alignItems: 'center',
          gap: W.s2,
        }}>
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            title="Toggle chat list"
            style={{
              width: 26,
              height: 26,
              border: `1px solid ${W.border}`,
              background: sidebarOpen ? W.bg3 : W.bg1,
              color: sidebarOpen ? W.accent : W.textDim,
              borderRadius: W.radius1,
              cursor: 'pointer',
              flexShrink: 0,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="list-unordered" size={W.iconSm} color="inherit" />
          </button>
          <button
            onClick={() => createChat()}
            title="New chat"
            style={{
              width: 26,
              height: 26,
              border: `1px solid ${W.border}`,
              background: W.bg1,
              color: W.textDim,
              borderRadius: W.radius1,
              cursor: 'pointer',
              flexShrink: 0,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            onMouseEnter={e => { e.currentTarget.style.color = W.accent; e.currentTarget.style.borderColor = W.borderHi; }}
            onMouseLeave={e => { e.currentTarget.style.color = W.textDim; e.currentTarget.style.borderColor = W.border; }}
          >
            <Icon name="add" size={W.iconSm} color="inherit" />
          </button>
          <div style={{
            flex: 1,
            minWidth: 0,
            fontSize: W.fontLg,
            fontWeight: W.fontWeightSemi,
            color: W.text,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {chat?.title || 'Chat'}
          </div>
          <select
            value={chat?.model || 'sonnet'}
            onChange={e => setModel(activeId, e.target.value)}
            title="Model"
            style={{
              background: W.bg1,
              border: `1px solid ${W.border}`,
              color: W.textDim,
              fontSize: W.fontSm,
              padding: `${W.s1}px ${W.s2}px`,
              borderRadius: W.radius1,
              cursor: 'pointer',
            }}
          >
            <option value="sonnet">Sonnet</option>
            <option value="opus">Opus</option>
          </select>
          <button
            onClick={() => clearMessages(activeId)}
            title="Clear messages (new session)"
            style={{
              width: 26,
              height: 26,
              background: W.bg1,
              border: `1px solid ${W.border}`,
              color: W.textDim,
              borderRadius: W.radius1,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
            onMouseEnter={e => { e.currentTarget.style.color = W.red; e.currentTarget.style.borderColor = W.red; }}
            onMouseLeave={e => { e.currentTarget.style.color = W.textDim; e.currentTarget.style.borderColor = W.border; }}
          >
            <Icon name="clear-all" size={W.iconSm} color="inherit" />
          </button>
        </div>

        {/* Search bar (Ctrl+F) */}
        {searchOpen && (
          <div style={{
            flexShrink: 0,
            padding: `${W.s2}px ${W.s3}px`,
            background: W.bg2,
            borderBottom: `1px solid ${W.border}`,
            display: 'flex',
            gap: W.s2,
            alignItems: 'center',
            fontSize: W.fontSm,
          }}>
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setSearchMatch(0); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && searchMatches.length > 0) {
                  e.preventDefault();
                  const next = (searchMatch + 1) % searchMatches.length;
                  setSearchMatch(next);
                  // Scroll to that message — find its DOM node by data attr
                  const idx = searchMatches[next].i;
                  const el = document.querySelector(`[data-msg-idx="${idx}"]`);
                  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setSearchOpen(false);
                  setSearchQuery('');
                }
              }}
              placeholder="Find in chat — Enter: next match · Esc: close"
              style={{
                flex: 1,
                padding: `${W.s1}px ${W.s2}px`,
                background: W.bg1,
                border: `1px solid ${W.border}`,
                borderRadius: W.radius1,
                color: W.text,
                fontSize: W.fontSm,
                fontFamily: W.fontFamily,
                outline: 'none',
              }}
            />
            <span style={{ color: W.textDim, whiteSpace: 'nowrap' }}>
              {searchQuery.trim()
                ? searchMatches.length > 0
                  ? `${searchMatch + 1}/${searchMatches.length}`
                  : '0/0'
                : ''}
            </span>
            <button
              onClick={() => { setSearchOpen(false); setSearchQuery(''); }}
              style={{
                padding: `${W.s1}px ${W.s2}px`,
                background: 'transparent',
                border: 'none',
                color: W.textDim,
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              ✕
            </button>
          </div>
        )}

        {/* Messages */}
        <div
          ref={scrollRef}
          style={{
            flex: 1,
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: `${W.s3}px ${W.s4}px`,
          }}
        >
          {messages.length === 0 && !sending && (
            <EmptyState />
          )}
          {messages.map((m, i) => {
            const q = searchOpen && searchQuery.trim() ? searchQuery.toLowerCase() : '';
            const matches = q ? (m.content || '').toLowerCase().includes(q) : true;
            return (
            <div
              key={i}
              data-msg-idx={i}
              style={{
                opacity: searchOpen && q ? (matches ? 1 : 0.3) : 1,
                transition: 'opacity 120ms',
              }}
            >
            <Message
              role={m.role}
              content={m.content}
              ts={m.ts}
              tokens={m.tokens}
              tokensIn={m.tokensIn}
              tokensOut={m.tokensOut}
              cachedRead={m.cachedRead}
              cost={m.cost}
              fileChanges={m.fileChanges}
              isHandoff={m.isHandoff}
              mentions={m.mentions}
              // The Deep review button re-submits the PRECEDING user
              // prompt through the full agent pipeline. Only show it
              // on non-handoff assistant messages where the previous
              // message was a user turn (so there's something to
              // escalate to).
              priorUserMessage={
                m.role === 'assistant' && !m.isHandoff && messages[i - 1]?.role === 'user'
                  ? messages[i - 1].content
                  : null
              }
            />
            </div>
            );
          })}
          {sending && (
            <Message
              role="assistant"
              content={streamBuffer || ''}
              streaming
            />
          )}
          {error && (
            <div style={{
              margin: `${W.s2}px 0`,
              padding: W.s3,
              background: W.redBg,
              border: `1px solid ${W.red}`,
              borderRadius: W.radius1,
              color: W.red,
              fontSize: W.fontMd,
            }}>
              Error: {error}
            </div>
          )}
        </div>

        {/* Command hint — faint row showing slash-command options
            when the user starts typing `/`, or on empty input. Fades
            away once they're typing a real message. */}
        <SlashHint input={input} />
        {/* Auto-escalation hint — when the user's draft contains
            high-complexity keywords, gently suggest `/task` instead
            of a chat turn. Non-blocking: user can still hit Enter. */}
        <EscalationHint input={input} onUseTask={() => setInput('/task ' + input.trim())} />
        {/* @file mention autocomplete popup */}
        {mention && mentionMatches.length > 0 && (
          <MentionPopup
            matches={mentionMatches}
            activeIdx={mention.activeIdx}
            onPick={commitMention}
            onHover={(i) => setMention((m) => m ? { ...m, activeIdx: i } : m)}
          />
        )}

        {/* Input */}
        <form
          onSubmit={handleSubmit}
          style={{
            flexShrink: 0,
            padding: W.s3,
            borderTop: `1px solid ${W.border}`,
            background: W.bg2,
          }}
        >
          <div style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: W.s2,
            background: W.bg1,
            border: `1px solid ${input.trim() ? W.borderHi : W.border}`,
            borderRadius: W.radius2,
            padding: `${W.s2}px ${W.s3}px`,
            transition: `border-color ${W.animFast}`,
          }}>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={e => {
                const v = e.target.value;
                setInput(v);
                // Detect `@query` at the caret position. If the char
                // before the caret is part of an `@word` token (no
                // whitespace), open the mention popup and filter by
                // the query.
                const caret = e.target.selectionStart ?? v.length;
                const upto = v.slice(0, caret);
                const m = /@([^\s@]*)$/.exec(upto);
                if (m) {
                  setMention({ query: m[1], startIdx: m.index, activeIdx: 0 });
                } else if (mention) {
                  setMention(null);
                }
              }}
              onKeyDown={handleKey}
              placeholder={sending ? 'Sending…' : 'Ask anything — @file to reference · Enter to send · Shift+Enter for newline · ↑/↓ recall history'}
              rows={1}
              disabled={sending}
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: W.text,
                fontSize: W.fontLg,
                fontFamily: W.fontFamily,
                lineHeight: '22px',
                resize: 'none',
                minHeight: '22px',
                maxHeight: '240px',
                caretColor: W.accent,
              }}
            />
            {sending ? (
              <button
                type="button"
                onClick={cancelSend}
                title="Stop (cancel this turn)"
                style={{
                  padding: `${W.s2}px ${W.s3}px`,
                  background: W.redBg,
                  border: `1px solid ${W.red}`,
                  borderRadius: W.radius1,
                  color: W.red,
                  fontSize: W.fontMd,
                  fontWeight: W.fontWeightSemi,
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  alignSelf: 'flex-end',
                }}
              >
                <Icon name="debug-stop" size={W.iconSm} color="inherit" />
                Stop
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
                title="Send (Enter)"
                style={{
                  padding: `${W.s2}px ${W.s3}px`,
                  background: input.trim() ? W.accent : 'transparent',
                  border: `1px solid ${input.trim() ? W.accent : W.border}`,
                  borderRadius: W.radius1,
                  color: input.trim() ? W.bg0 : W.textDim,
                  fontSize: W.fontMd,
                  fontWeight: W.fontWeightBold,
                  cursor: input.trim() ? 'pointer' : 'default',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  alignSelf: 'flex-end',
                }}
              >
                <Icon name="send" size={W.iconSm} color="inherit" />
                Send
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Message bubble ───

function Message({ role, content, ts, tokens, tokensIn, tokensOut, cachedRead, cost, streaming, fileChanges, priorUserMessage, isHandoff, mentions }) {
  const isUser = role === 'user';
  const isEmptyStreaming = streaming && !content;
  return (
    <div style={{
      margin: `${W.s3}px 0`,
      display: 'flex',
      flexDirection: 'column',
      alignItems: isUser ? 'flex-end' : 'flex-start',
    }}>
      <div style={{
        fontSize: W.fontSm,
        color: W.textMuted,
        marginBottom: W.s1,
        display: 'flex',
        alignItems: 'center',
        gap: W.s2,
      }}>
        <span style={{ textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: W.fontWeightSemi }}>
          {isUser ? 'You' : 'Assistant'}
        </span>
        {ts && !streaming && (
          <RelativeTime ts={ts} />
        )}
        {streaming && !isEmptyStreaming && (
          <span style={{ color: W.accent }}>
            ● streaming
          </span>
        )}
        {isEmptyStreaming && (
          <span style={{ color: W.accent, opacity: 0.8 }}>
            thinking…
          </span>
        )}
        {!streaming && tokens > 0 && (
          <CostFooter
            tokensIn={tokensIn}
            tokensOut={tokensOut}
            cachedRead={cachedRead}
            tokensTotal={tokens}
            cost={cost}
          />
        )}
      </div>
      <div style={{
        maxWidth: '85%',
        padding: `${W.s2}px ${W.s3}px`,
        background: isUser ? W.accentBg : W.bg2,
        border: `1px solid ${isUser ? W.accentSoft : W.border}`,
        borderRadius: W.radius2,
        color: W.text,
        fontSize: W.fontLg,
        lineHeight: 1.55,
        wordBreak: 'break-word',
        fontFamily: isUser ? W.fontFamily : W.fontFamily,
        minHeight: isEmptyStreaming ? 28 : undefined,
      }}>
        {isEmptyStreaming ? (
          <ThinkingDots />
        ) : isUser ? (
          // User messages are plain text, render as-is
          <span style={{ whiteSpace: 'pre-wrap' }}>{content}</span>
        ) : (
          // Assistant messages: split streaming text into text + tool-call
          // blocks. Tool markers like `[hexis tool: memory_view]`,
          // `[search: **/*.js]`, `[grep: foo]`, `$ npm test` become
          // compact pills instead of flat text, matching Claude Code's
          // inline tool-use rendering.
          <AssistantBlocks content={content} />
        )}
      </div>
      {/* Mentions row on user messages — shows which @file references
          got expanded + injected as context for the turn. */}
      {isUser && mentions?.length > 0 && (
        <div style={{
          marginTop: W.s1,
          display: 'flex',
          flexWrap: 'wrap',
          gap: W.s1,
          alignItems: 'center',
          maxWidth: '85%',
        }}>
          <span style={{ fontSize: W.fontSm, color: W.textMuted, marginRight: W.s2 }}>
            referenced
          </span>
          {mentions.map((f, i) => (
            <span key={i} style={{
              padding: `2px ${W.s2}px`,
              background: 'rgba(88, 166, 255, 0.08)',
              border: `1px solid rgba(88, 166, 255, 0.35)`,
              borderRadius: W.radius1,
              fontSize: W.fontSm,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              color: '#58a6ff',
            }}>
              @{f}
            </span>
          ))}
        </div>
      )}
      {/* File-changes row — lists every file the agent edited this
          turn as a compact pill below the message bubble. Only for
          assistant messages that actually touched files. */}
      {!isUser && !streaming && fileChanges?.length > 0 && (
        <FileChangesRow files={fileChanges} />
      )}
      {/* Message action bar: copy + regenerate on assistant messages,
          copy-only on user messages. Hover-revealed so the quiet
          mode stays clean. Skipped on streaming / handoff messages. */}
      {!streaming && !isHandoff && (isUser || priorUserMessage) && content && (
        <MessageActions
          isUser={isUser}
          content={content}
          priorUserMessage={priorUserMessage}
        />
      )}
      {/* Deep review escalation: re-run the user's prompt through the
          full Writer/Planner/Coder/Critic pipeline when the chat
          answer looks promising but you want the 3-persona review
          gate. Hidden on handoff / streaming / empty responses and
          on the first message (no prior user turn to escalate). */}
      {!isUser && !streaming && !isHandoff && priorUserMessage && (
        <DeepReviewButton prompt={priorUserMessage} />
      )}
    </div>
  );
}

function MessageActions({ isUser, content, priorUserMessage }) {
  const [copied, setCopied] = useState(false);
  const [starState, setStarState] = useState('idle'); // idle | input | saving | saved
  const [starText, setStarText] = useState('');
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };
  const handleRegenerate = async () => {
    if (!priorUserMessage) return;
    const { useChatStore } = await import('../../stores/chatStore.js');
    useChatStore.getState().sendMessage(priorUserMessage);
  };
  const openStar = () => {
    // Pre-fill with the first sentence of the message (up to 140 chars)
    const first = (content || '').split(/[.!?]\s/)[0].trim().slice(0, 140);
    setStarText(first);
    setStarState('input');
  };
  const submitStar = async () => {
    const rule = starText.trim();
    if (!rule) return;
    setStarState('saving');
    try {
      const res = await fetch('/api/memory/learned', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rule, source: 'chat' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStarState('saved');
      setTimeout(() => setStarState('idle'), 1800);
    } catch {
      setStarState('idle');
    }
  };

  if (starState === 'input' || starState === 'saving') {
    return (
      <div style={{
        marginTop: 2,
        display: 'flex',
        gap: W.s1,
        alignItems: 'center',
        maxWidth: '85%',
        flexWrap: 'wrap',
      }}>
        <input
          autoFocus
          value={starText}
          onChange={(e) => setStarText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); submitStar(); }
            if (e.key === 'Escape') { e.preventDefault(); setStarState('idle'); }
          }}
          placeholder="One-line rule to save to memory…"
          disabled={starState === 'saving'}
          style={{
            flex: 1,
            minWidth: 240,
            padding: `${W.s1}px ${W.s2}px`,
            background: W.bg1,
            border: `1px solid ${W.accent}`,
            borderRadius: W.radius1,
            color: W.text,
            fontSize: W.fontSm,
            fontFamily: W.fontFamily,
            outline: 'none',
          }}
        />
        <button
          onClick={submitStar}
          disabled={starState === 'saving'}
          style={{
            padding: `2px ${W.s2}px`,
            background: W.accentBg,
            border: `1px solid ${W.accent}`,
            borderRadius: W.radius1,
            color: W.accent,
            fontSize: 11,
            cursor: 'pointer',
            fontFamily: W.fontFamily,
          }}
        >
          {starState === 'saving' ? 'saving…' : 'save'}
        </button>
        <button
          onClick={() => setStarState('idle')}
          style={{
            padding: `2px ${W.s2}px`,
            background: 'transparent',
            border: `1px solid ${W.border}`,
            borderRadius: W.radius1,
            color: W.textDim,
            fontSize: 11,
            cursor: 'pointer',
            fontFamily: W.fontFamily,
          }}
        >
          cancel
        </button>
      </div>
    );
  }

  return (
    <div style={{
      marginTop: 2,
      display: 'flex',
      gap: W.s1,
      alignItems: 'center',
      opacity: starState === 'saved' ? 1 : 0.55,
      transition: `opacity ${W.animFast}`,
    }}
      onMouseEnter={(e) => { e.currentTarget.style.opacity = 1; }}
      onMouseLeave={(e) => { e.currentTarget.style.opacity = starState === 'saved' ? 1 : 0.55; }}
    >
      <button
        onClick={handleCopy}
        title={copied ? 'Copied!' : 'Copy message'}
        style={{
          padding: '2px 8px',
          background: 'transparent',
          border: `1px solid ${W.border}`,
          borderRadius: W.radius1,
          color: copied ? W.accent : W.textDim,
          fontSize: 11,
          cursor: 'pointer',
          fontFamily: W.fontFamily,
        }}
      >
        {copied ? '✓ copied' : 'copy'}
      </button>
      {!isUser && priorUserMessage && (
        <button
          onClick={handleRegenerate}
          title="Regenerate this response from the previous user message"
          style={{
            padding: '2px 8px',
            background: 'transparent',
            border: `1px solid ${W.border}`,
            borderRadius: W.radius1,
            color: W.textDim,
            fontSize: 11,
            cursor: 'pointer',
            fontFamily: W.fontFamily,
          }}
        >
          ↻ regenerate
        </button>
      )}
      {!isUser && (
        <button
          onClick={openStar}
          title="Save a rule from this message to project memory (learned.md)"
          style={{
            padding: '2px 8px',
            background: 'transparent',
            border: `1px solid ${starState === 'saved' ? W.accent : W.border}`,
            borderRadius: W.radius1,
            color: starState === 'saved' ? W.accent : W.textDim,
            fontSize: 11,
            cursor: 'pointer',
            fontFamily: W.fontFamily,
          }}
        >
          {starState === 'saved' ? '★ saved' : '★ memory'}
        </button>
      )}
    </div>
  );
}

function DeepReviewButton({ prompt }) {
  const [clicked, setClicked] = useState(false);
  const handleClick = async () => {
    if (clicked) return;
    setClicked(true);
    try {
      const { useAgentStore } = await import('../../stores/agentStore.js');
      await useAgentStore.getState().submitTask(prompt);
      // Also reveal the AI Agents panel so the user sees the pipeline
      const { usePanelStore } = await import('../../stores/panelStore.js');
      usePanelStore.getState().revealPanel('ai');
    } catch (err) {
      console.warn('[deep-review] failed:', err);
      setClicked(false);
    }
  };
  return (
    <button
      onClick={handleClick}
      disabled={clicked}
      style={{
        marginTop: W.s1,
        alignSelf: 'flex-start',
        padding: `${W.s1}px ${W.s2}px`,
        background: clicked ? W.bg2 : 'transparent',
        border: `1px solid ${W.border}`,
        borderRadius: W.radius1,
        color: clicked ? W.textDim : W.accent,
        fontSize: W.fontSm,
        fontFamily: W.fontFamily,
        cursor: clicked ? 'default' : 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: W.s1,
        transition: `all ${W.animFast}`,
      }}
      title="Re-run this prompt through the full Writer/Planner/Coder/Critic pipeline"
    >
      ⬡ {clicked ? 'Review running…' : 'Deep review'}
    </button>
  );
}

function FileChangesRow({ files }) {
  return (
    <div style={{
      marginTop: W.s1,
      display: 'flex',
      flexWrap: 'wrap',
      gap: W.s1,
      maxWidth: '85%',
      alignItems: 'center',
    }}>
      <span style={{
        fontSize: W.fontSm,
        color: W.textMuted,
        marginRight: W.s2,
      }}>
        edited
      </span>
      {files.map((f, i) => (
        <span key={i} style={{
          padding: `2px ${W.s2}px`,
          background: 'rgba(46, 160, 67, 0.08)',
          border: `1px solid rgba(46, 160, 67, 0.35)`,
          borderRadius: W.radius1,
          fontSize: W.fontSm,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          color: '#4ade80',
        }}>
          {f}
        </span>
      ))}
    </div>
  );
}

// ─── Cost / token footer ───

// Formats large numbers compactly (12345 → "12.3k", 999 → "999").
function fmtCount(n) {
  if (!n && n !== 0) return '0';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

function CostFooter({ tokensIn, tokensOut, cachedRead, tokensTotal, cost }) {
  // Fall back to the old single-sum display if the breakdown fields
  // aren't present (messages written before the per-turn breakdown landed).
  const hasBreakdown = tokensIn !== undefined || tokensOut !== undefined;
  if (!hasBreakdown) {
    return <span>{(tokensTotal || 0).toLocaleString()} tok · ${cost?.toFixed(4) || '0.0000'}</span>;
  }
  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
      <span>{fmtCount(tokensIn)}↑ / {fmtCount(tokensOut)}↓</span>
      {cachedRead > 0 && (
        <span style={{ color: W.textDim }}>· {fmtCount(cachedRead)} cached</span>
      )}
      <span>· ${cost?.toFixed(4) || '0.0000'}</span>
    </span>
  );
}

// ─── Assistant message block renderer ───

// Markers we recognise. Order matters: longer / more specific first.
// Each matcher returns { kind, name, arg } or null.
const TOOL_PATTERNS = [
  { re: /\n\[hexis tool:\s*([^\]]+)\]\n/, kind: 'tool', name: (m) => m[1].trim() },
  { re: /\n\[search:\s*([^\]]+)\]\n/,     kind: 'glob', name: () => 'Glob',         arg: (m) => m[1].trim() },
  { re: /\n\[grep:\s*([^\]]+)\]\n/,       kind: 'grep', name: () => 'Grep',         arg: (m) => m[1].trim() },
  { re: /\n\[intent:\s*([^\]]+)\]\n/,     kind: 'meta', name: () => 'intent',       arg: (m) => m[1].trim() },
  // Generic [...] bracketed status (research phases, scheduled, trivial_edit, etc)
  { re: /\n\[([^\]]{3,})\]\n/,            kind: 'meta', name: () => 'status',       arg: (m) => m[1].trim() },
  // Bash commands: `\n$ ...\n`
  { re: /\n\$ ([^\n]+)\n/,                kind: 'bash', name: () => 'Bash',         arg: (m) => m[1].trim() },
];

function parseAssistantBlocks(text) {
  if (!text) return [];
  const blocks = [];
  let remaining = text;
  while (remaining.length > 0) {
    // Find the earliest match across all patterns
    let earliest = null;
    for (const p of TOOL_PATTERNS) {
      const m = p.re.exec(remaining);
      if (m && (earliest === null || m.index < earliest.index)) {
        earliest = { ...p, match: m, index: m.index, length: m[0].length };
      }
    }
    if (!earliest) {
      // No more tools — rest is text
      if (remaining.trim()) blocks.push({ kind: 'text', value: remaining });
      break;
    }
    // Leading text before the tool
    if (earliest.index > 0) {
      const pre = remaining.slice(0, earliest.index);
      if (pre.trim()) blocks.push({ kind: 'text', value: pre });
    }
    // Tool/block
    blocks.push({
      kind: earliest.kind,
      name: earliest.name(earliest.match),
      arg: earliest.arg ? earliest.arg(earliest.match) : '',
    });
    remaining = remaining.slice(earliest.index + earliest.length);
  }
  return blocks;
}

function AssistantBlocks({ content }) {
  const blocks = useMemo(() => parseAssistantBlocks(content), [content]);
  if (blocks.length === 0) {
    return <span style={{ whiteSpace: 'pre-wrap' }}>{content}</span>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: W.s1 }}>
      {blocks.map((b, i) => (
        <Block key={i} block={b} />
      ))}
    </div>
  );
}

function Block({ block }) {
  if (block.kind === 'text') {
    return <Markdown text={block.value} />;
  }
  // Tool / bash / search / grep / meta — render as a compact pill
  const isMeta = block.kind === 'meta';
  const label = block.name;
  const arg = block.arg;
  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: W.s2,
      padding: `${W.s1}px ${W.s2}px`,
      background: isMeta ? 'rgba(200,200,200,0.04)' : W.accentBg,
      border: `1px solid ${isMeta ? W.border : W.accentSoft}`,
      borderRadius: W.radius1,
      fontSize: W.fontSm,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      color: isMeta ? W.textMuted : W.text,
      alignSelf: 'flex-start',
      maxWidth: '100%',
    }}>
      <span style={{
        color: isMeta ? W.textDim : W.accent,
        fontWeight: W.fontWeightSemi,
      }}>
        {label}
      </span>
      {arg && (
        <span style={{
          opacity: 0.9,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          maxWidth: 520,
        }}>
          {arg}
        </span>
      )}
    </div>
  );
}

// Slash command hint row. Renders above the input to advertise the
// escalation routes without shouting — fades in when the user types
// `/`, and always shows empty-state on an empty input.
const SLASH_HINTS = [
  { cmd: '/research', desc: 'deep 6-phase research pipeline' },
  { cmd: '/task',     desc: 'full agent pipeline with Critic review' },
  { cmd: '/compact',  desc: 'summarize older turns to free context' },
  { cmd: '/clear',    desc: 'wipe this chat and start fresh' },
  { cmd: '/model',    desc: 'switch model (sonnet | opus)' },
  { cmd: '/help',     desc: 'show all commands and shortcuts' },
];

function SlashHint({ input }) {
  const show = !input || input.trim().startsWith('/');
  if (!show) return null;
  const typed = (input || '').trim();
  const filtered = typed
    ? SLASH_HINTS.filter(h => h.cmd.startsWith(typed.split(/\s/)[0].toLowerCase()))
    : SLASH_HINTS;
  if (filtered.length === 0) return null;
  return (
    <div style={{
      flexShrink: 0,
      padding: `${W.s1}px ${W.s3}px`,
      borderTop: `1px solid ${W.border}`,
      background: W.bg1,
      display: 'flex',
      gap: W.s3,
      flexWrap: 'wrap',
      fontSize: W.fontSm,
      color: W.textMuted,
    }}>
      {filtered.map(h => (
        <span key={h.cmd} style={{ display: 'inline-flex', gap: W.s1, alignItems: 'center' }}>
          <span style={{
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            color: W.accent,
            fontWeight: W.fontWeightSemi,
          }}>
            {h.cmd}
          </span>
          <span style={{ opacity: 0.75 }}>{h.desc}</span>
        </span>
      ))}
    </div>
  );
}

// Keywords that suggest the user is asking for a big, multi-file or
// safety-critical change. When these appear in the draft, we gently
// suggest /task (full pipeline) instead of a plain chat turn. Scanned
// with word boundaries so we don't false-positive on substrings.
const ESCALATION_KEYWORDS = [
  'refactor', 'audit', 'security', 'migrate', 'migration',
  'review', 'all files', 'across the codebase', 'entire',
  'redesign', 'rewrite', 'architect',
];
const ESCALATION_RE = new RegExp(
  '\\b(' + ESCALATION_KEYWORDS.map(k => k.replace(/\s+/g, '\\s+')).join('|') + ')\\b',
  'i',
);

function EscalationHint({ input, onUseTask }) {
  const draft = (input || '').trim();
  // Don't show for empty, slash commands, or very short prompts
  if (draft.length < 20) return null;
  if (draft.startsWith('/')) return null;
  const hit = ESCALATION_RE.exec(draft);
  if (!hit) return null;
  return (
    <div style={{
      flexShrink: 0,
      padding: `${W.s2}px ${W.s3}px`,
      borderTop: `1px solid ${W.border}`,
      background: W.accentBg,
      display: 'flex',
      alignItems: 'center',
      gap: W.s3,
      fontSize: W.fontSm,
      color: W.text,
    }}>
      <span style={{ color: W.accent, fontWeight: W.fontWeightSemi }}>⬡</span>
      <span style={{ flex: 1 }}>
        Detected <b>&ldquo;{hit[1]}&rdquo;</b> — looks like a multi-file task.
        Consider the full pipeline (Writer → Planner → Coder → 3 Critics).
      </span>
      <button
        type="button"
        onClick={onUseTask}
        style={{
          padding: `${W.s1}px ${W.s2}px`,
          background: W.accentBg,
          border: `1px solid ${W.accent}`,
          borderRadius: W.radius1,
          color: W.accent,
          fontSize: W.fontSm,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          cursor: 'pointer',
        }}
        title="Prepend /task to route through the full pipeline"
      >
        use /task
      </button>
    </div>
  );
}

// @file mention autocomplete popup. Appears above the textarea when
// the user types `@` followed by a partial path. Keyboard: ↑/↓ to
// navigate, Enter/Tab to commit, Esc to dismiss.
function MentionPopup({ matches, activeIdx, onPick, onHover }) {
  return (
    <div style={{
      flexShrink: 0,
      borderTop: `1px solid ${W.border}`,
      background: W.bg2,
      maxHeight: 220,
      overflowY: 'auto',
      fontSize: W.fontSm,
    }}>
      <div style={{
        padding: `${W.s1}px ${W.s3}px`,
        color: W.textDim,
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
      }}>
        File reference · ↑↓ Enter · Esc
      </div>
      {matches.map((path, i) => {
        const isActive = i === activeIdx;
        const parts = path.split('/');
        const name = parts[parts.length - 1];
        const dir = parts.slice(0, -1).join('/');
        return (
          <div
            key={path}
            onMouseEnter={() => onHover?.(i)}
            onMouseDown={(e) => { e.preventDefault(); onPick(path); }}
            style={{
              padding: `${W.s1}px ${W.s3}px`,
              cursor: 'pointer',
              background: isActive ? W.accentBg : 'transparent',
              borderLeft: `2px solid ${isActive ? W.accent : 'transparent'}`,
              display: 'flex',
              gap: W.s2,
              alignItems: 'baseline',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            }}
          >
            <span style={{ color: isActive ? W.accent : W.text, fontWeight: isActive ? W.fontWeightSemi : 400 }}>
              {name}
            </span>
            {dir && (
              <span style={{ color: W.textDim, fontSize: 11 }}>
                {dir}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Relative-time badge — "just now", "3m ago", "2h ago", "yesterday".
// Re-renders once a minute while mounted so old messages age
// without needing a parent state push.
function RelativeTime({ ts }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick(x => x + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  const abs = new Date(ts);
  return (
    <span
      style={{ color: W.textDim, fontSize: 11 }}
      title={abs.toLocaleString()}
    >
      {formatRelative(ts)}
    </span>
  );
}

function formatRelative(ts) {
  if (!ts) return '';
  const now = Date.now();
  const diff = Math.max(0, now - ts);
  if (diff < 45_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  if (diff < 172_800_000) return 'yesterday';
  const days = Math.round(diff / 86_400_000);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

// Animated three-dot pulse, rendered while the agent is working but
// hasn't produced any tokens yet. Kills the "did it work?" dead gap.
function ThinkingDots() {
  const dotStyle = (delay) => ({
    display: 'inline-block',
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: W.accent,
    margin: '0 2px',
    animation: `hexis-thinking-pulse 1.1s ${delay}s ease-in-out infinite`,
  });
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', opacity: 0.85, verticalAlign: 'middle' }}>
      <style>{`
        @keyframes hexis-thinking-pulse {
          0%, 80%, 100% { transform: scale(0.7); opacity: 0.4; }
          40%           { transform: scale(1.0); opacity: 1.0; }
        }
      `}</style>
      <span style={dotStyle(0)} />
      <span style={dotStyle(0.15)} />
      <span style={dotStyle(0.3)} />
    </span>
  );
}

// ─── Empty state ───

// ─── Markdown renderer ───
//
// Intentionally lightweight — handles the Markdown features the
// Claude chat model actually emits: fenced code blocks, headings,
// bullets, numbered lists, bold, italic, inline code, and plain
// paragraphs. No link rendering (rare in code-assistant output)
// and no tables (also rare). Keeps the bundle small and the
// streaming render cheap.
//
// Fenced code blocks render with a language label and a copy
// button. Inline code renders as a tinted monospace span. Text
// paragraphs preserve `pre-wrap` so the agent's manual line
// breaks survive.
function Markdown({ text }) {
  const nodes = useMemo(() => parseMarkdown(text || ''), [text]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {nodes.map((n, i) => renderNode(n, i))}
    </div>
  );
}

// Parse into a flat list of block nodes:
//   { kind: 'code', lang, body }
//   { kind: 'h', depth, text }
//   { kind: 'li', ordered, text }
//   { kind: 'p', text }
function parseMarkdown(src) {
  const nodes = [];
  const lines = src.split(/\r?\n/);
  let i = 0;
  let buf = [];
  const flushPara = () => {
    if (buf.length) {
      const joined = buf.join('\n');
      if (joined.trim()) nodes.push({ kind: 'p', text: joined });
      buf = [];
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    // Fenced code block
    const fence = /^```\s*([a-zA-Z0-9_+.-]*)\s*$/.exec(line);
    if (fence) {
      flushPara();
      const lang = fence[1] || '';
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      // skip closing ```
      if (i < lines.length) i++;
      nodes.push({ kind: 'code', lang, body: body.join('\n') });
      continue;
    }
    // Heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      nodes.push({ kind: 'h', depth: h[1].length, text: h[2] });
      i++;
      continue;
    }
    // Bulleted list item
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    if (ul) {
      flushPara();
      nodes.push({ kind: 'li', ordered: false, text: ul[1] });
      i++;
      continue;
    }
    // Numbered list item
    const ol = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    if (ol) {
      flushPara();
      nodes.push({ kind: 'li', ordered: true, num: ol[1], text: ol[2] });
      i++;
      continue;
    }
    // Blank line ends a paragraph
    if (line.trim() === '') {
      flushPara();
      i++;
      continue;
    }
    // Otherwise append to current paragraph buffer
    buf.push(line);
    i++;
  }
  flushPara();
  return nodes;
}

function renderNode(n, key) {
  if (n.kind === 'code') {
    return <CodeBlock key={key} lang={n.lang} body={n.body} />;
  }
  if (n.kind === 'h') {
    const size = n.depth === 1 ? 20 : n.depth === 2 ? 17 : n.depth === 3 ? 15 : 14;
    return (
      <div key={key} style={{
        fontSize: size,
        fontWeight: W.fontWeightSemi,
        color: n.depth <= 2 ? W.text : W.textMuted,
        marginTop: key === 0 ? 0 : 10,
        marginBottom: 4,
      }}>
        {renderInlineMd(n.text)}
      </div>
    );
  }
  if (n.kind === 'li') {
    return (
      <div key={key} style={{
        display: 'flex',
        gap: W.s2,
        alignItems: 'flex-start',
        paddingLeft: W.s2,
      }}>
        <span style={{
          color: W.accent,
          flexShrink: 0,
          fontFamily: n.ordered ? W.fontFamily : 'inherit',
          minWidth: n.ordered ? 18 : 8,
        }}>
          {n.ordered ? `${n.num}.` : '•'}
        </span>
        <span style={{ flex: 1, whiteSpace: 'pre-wrap' }}>{renderInlineMd(n.text)}</span>
      </div>
    );
  }
  // Paragraph
  return (
    <div key={key} style={{ whiteSpace: 'pre-wrap' }}>
      {renderInlineMd(n.text)}
    </div>
  );
}

// Inline markdown: `code`, **bold**, *italic*. Tokenized via a
// single regex walk so we don't pay N-pass splitting per render.
function renderInlineMd(text) {
  if (!text) return null;
  // Pattern order: `code` > **bold** > *italic*
  const parts = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*)/g;
  let lastIdx = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIdx) parts.push({ kind: 'text', value: text.slice(lastIdx, m.index) });
    const tok = m[0];
    if (tok.startsWith('`')) {
      parts.push({ kind: 'code', value: tok.slice(1, -1) });
    } else if (tok.startsWith('**')) {
      parts.push({ kind: 'bold', value: tok.slice(2, -2) });
    } else if (tok.startsWith('*')) {
      parts.push({ kind: 'em', value: tok.slice(1, -1) });
    }
    lastIdx = m.index + tok.length;
  }
  if (lastIdx < text.length) parts.push({ kind: 'text', value: text.slice(lastIdx) });
  return parts.map((p, i) => {
    if (p.kind === 'code') {
      return (
        <code key={i} style={{
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: '0.92em',
          padding: '1px 5px',
          background: 'rgba(240, 160, 48, 0.10)',
          border: `1px solid rgba(240, 160, 48, 0.25)`,
          borderRadius: 3,
          color: W.accent,
        }}>
          {p.value}
        </code>
      );
    }
    if (p.kind === 'bold') return <strong key={i}>{p.value}</strong>;
    if (p.kind === 'em') return <em key={i}>{p.value}</em>;
    return <span key={i}>{p.value}</span>;
  });
}

// Fenced code block with language label + copy button. Mimics
// Claude Code / claude.ai: rounded dark block, header row, code.
function CodeBlock({ lang, body }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };
  return (
    <div style={{
      margin: '6px 0',
      borderRadius: 6,
      background: 'rgba(0, 0, 0, 0.35)',
      border: `1px solid ${W.border}`,
      overflow: 'hidden',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12.5,
    }}>
      <div style={{
        padding: '4px 10px',
        background: 'rgba(255, 255, 255, 0.03)',
        borderBottom: `1px solid ${W.border}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontSize: 11,
        color: W.textDim,
      }}>
        <span style={{
          textTransform: 'lowercase',
          letterSpacing: '0.02em',
          fontFamily: W.fontFamily,
        }}>
          {lang || 'code'}
        </span>
        <button
          onClick={handleCopy}
          style={{
            background: 'transparent',
            border: 'none',
            color: copied ? W.accent : W.textDim,
            fontSize: 11,
            cursor: 'pointer',
            padding: '2px 6px',
            borderRadius: 3,
            fontFamily: W.fontFamily,
          }}
        >
          {copied ? '✓ copied' : 'copy'}
        </button>
      </div>
      <pre style={{
        margin: 0,
        padding: 10,
        overflowX: 'auto',
        color: W.text,
        whiteSpace: 'pre',
        lineHeight: 1.5,
      }}>
        {body}
      </pre>
    </div>
  );
}

function EmptyState() {
  // Starter prompt suggestions — tiny buttons under the hero that
  // pre-fill the textarea. Helps a fresh user get to "something
  // useful happens" in one click instead of typing from scratch.
  const suggestions = [
    'what does this codebase do?',
    'show me the main entry point',
    'list the TODOs in src/',
  ];
  const fill = (text) => {
    // Fire a keyboard-ish event the textarea will pick up. Simpler:
    // find the textarea and set its value.
    const ta = document.querySelector('textarea[placeholder*="Ask anything"]');
    if (!ta) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
  };

  return (
    <div style={{
      marginTop: '12%',
      textAlign: 'center',
      color: W.textMuted,
      fontSize: W.fontLg,
      padding: W.s4,
    }}>
      <div style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 72,
        height: 72,
        borderRadius: W.radius3,
        background: W.accentBg,
        border: `1px solid ${W.borderHi}`,
        color: W.accent,
        marginBottom: W.s3,
        boxShadow: `0 0 40px rgba(240, 160, 48, 0.15)`,
      }}>
        <Icon name="comment-discussion" size={W.iconXl} color="inherit" />
      </div>
      <div style={{
        fontWeight: W.fontWeightSemi,
        color: W.text,
        marginBottom: W.s2,
        fontSize: W.fontXxl || 22,
      }}>
        Chat with Hexis
      </div>
      <div style={{
        fontSize: W.fontMd,
        lineHeight: 1.55,
        maxWidth: 460,
        margin: '0 auto',
        marginBottom: W.s4,
      }}>
        Claude Code directly, inside your IDE. Memory, skills, file edits,
        tests, git — with a one-click escalation to the full multi-agent
        review pipeline when quality matters. Press{' '}
        <kbd style={{
          padding: '1px 6px',
          border: `1px solid ${W.border}`,
          borderRadius: 3,
          fontSize: 11,
          fontFamily: 'ui-monospace, Menlo, monospace',
          color: W.textDim,
        }}>Ctrl</kbd>
        {' + '}
        <kbd style={{
          padding: '1px 6px',
          border: `1px solid ${W.border}`,
          borderRadius: 3,
          fontSize: 11,
          fontFamily: 'ui-monospace, Menlo, monospace',
          color: W.textDim,
        }}>/</kbd>
        {' anywhere in Hexis to jump back here.'}
      </div>
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: W.s2,
        maxWidth: 420,
        margin: '0 auto',
      }}>
        {suggestions.map((s, i) => (
          <button
            key={i}
            onClick={() => fill(s)}
            style={{
              padding: `${W.s2}px ${W.s3}px`,
              background: W.bg2,
              border: `1px solid ${W.border}`,
              borderRadius: W.radius1,
              color: W.text,
              fontSize: W.fontMd,
              fontFamily: W.fontFamily,
              cursor: 'pointer',
              textAlign: 'left',
              transition: `all ${W.animFast}`,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = W.accent; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = W.border; }}
          >
            <span style={{ color: W.accent, marginRight: W.s2 }}>→</span>
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
