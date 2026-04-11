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
  const scrollRef = useRef(null);
  const textareaRef = useRef(null);

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

  const handleSubmit = (e) => {
    e?.preventDefault?.();
    if (!input.trim() || sending) return;
    const text = input;
    setInput('');
    sendMessage(text);
  };

  const handleKey = (e) => {
    // Enter sends, Shift+Enter adds newline
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div style={{
      display: 'flex',
      flex: 1,
      minHeight: 0,
      minWidth: 0,
      background: W.bg1,
      fontFamily: W.fontFamily,
    }}>
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
          {messages.map((m, i) => (
            <Message key={i} role={m.role} content={m.content} tokens={m.tokens} cost={m.cost} />
          ))}
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
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder={sending ? 'Sending…' : 'Ask anything about the project — Enter to send, Shift+Enter for newline'}
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

function Message({ role, content, tokens, cost, streaming }) {
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
          <span>{tokens.toLocaleString()} tok · ${cost?.toFixed(4) || '0.0000'}</span>
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
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontFamily: isUser ? W.fontFamily : W.fontFamily,
        minHeight: isEmptyStreaming ? 28 : undefined,
      }}>
        {content || (isEmptyStreaming ? <ThinkingDots /> : '')}
      </div>
    </div>
  );
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

function EmptyState() {
  return (
    <div style={{
      marginTop: '15%',
      textAlign: 'center',
      color: W.textMuted,
      fontSize: W.fontLg,
      padding: W.s4,
    }}>
      <div style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 56,
        height: 56,
        borderRadius: W.radius3,
        background: W.accentBg,
        border: `1px solid ${W.borderHi}`,
        color: W.accent,
        marginBottom: W.s3,
      }}>
        <Icon name="comment-discussion" size={W.iconXl} color="inherit" />
      </div>
      <div style={{ fontWeight: W.fontWeightSemi, color: W.text, marginBottom: W.s2, fontSize: W.fontXl }}>
        Chat with Hexis
      </div>
      <div style={{ fontSize: W.fontMd, lineHeight: 1.5, maxWidth: 420, margin: '0 auto' }}>
        Direct conversational agent with full tool access — memory, skills,
        file edits, tests, git. Same Claude you'd get in the CLI, wired into
        your repo. Type a message below and press <strong style={{ color: W.textDim }}>Enter</strong> to send.
      </div>
    </div>
  );
}
