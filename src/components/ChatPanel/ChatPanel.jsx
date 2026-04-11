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
            <Message
              key={i}
              role={m.role}
              content={m.content}
              tokens={m.tokens}
              tokensIn={m.tokensIn}
              tokensOut={m.tokensOut}
              cachedRead={m.cachedRead}
              cost={m.cost}
              fileChanges={m.fileChanges}
              isHandoff={m.isHandoff}
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

        {/* Command hint — faint row showing slash-command options
            when the user starts typing `/`, or on empty input. Fades
            away once they're typing a real message. */}
        <SlashHint input={input} />
        {/* Auto-escalation hint — when the user's draft contains
            high-complexity keywords, gently suggest `/task` instead
            of a chat turn. Non-blocking: user can still hit Enter. */}
        <EscalationHint input={input} onUseTask={() => setInput('/task ' + input.trim())} />

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

function Message({ role, content, tokens, tokensIn, tokensOut, cachedRead, cost, streaming, fileChanges, priorUserMessage, isHandoff }) {
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
      {/* File-changes row — lists every file the agent edited this
          turn as a compact pill below the message bubble. Only for
          assistant messages that actually touched files. */}
      {!isUser && !streaming && fileChanges?.length > 0 && (
        <FileChangesRow files={fileChanges} />
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
    return <span style={{ whiteSpace: 'pre-wrap' }}>{block.value}</span>;
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
  { cmd: '/research', desc: 'deep research pipeline (plan → workers → critic → synth)' },
  { cmd: '/task',     desc: 'full agent pipeline with Critic review' },
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
