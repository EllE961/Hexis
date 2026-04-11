/**
 * MemoryPanel — shows .hexis/memories/learned.md so users can see
 * the "compounding quality" loop Hexis has built up on this project.
 *
 * Every Final Reviewer run appends 1-3 distilled rules to this file.
 * Every future Planner run reads it and prepends it to its system
 * prompt. The result is a project-specific convention memory that
 * gets smarter with use — but until now it was completely invisible
 * to the user.
 *
 * Polls the server every few seconds so new conventions appearing
 * after a completed task show up live.
 */

import { useEffect, useState, useCallback } from 'react';
import { W } from '../../theme/window-tokens.js';

// Shared state/helpers for inline editing a rule. Lives at module
// scope so LearnedRenderer and RuleItem can both see it without
// prop-drilling.
async function patchRule(oldText, newText) {
  const res = await fetch('/api/memory/learned', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldText, newText }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function deleteRule(text) {
  const res = await fetch('/api/memory/learned', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export default function MemoryPanel() {
  const [content, setContent] = useState('');
  const [freshness, setFreshness] = useState({});
  const [exists, setExists] = useState(true);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/memory/learned');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setContent(data.content || '');
      setFreshness(data.freshness || {});
      setExists(!!data.exists);
      setError(null);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    // Light poll — every 10 s while panel is open
    const id = setInterval(refresh, 10000);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      flex: 1,
      minHeight: 0,
      background: W.bg1,
      fontFamily: W.fontFamily,
    }}>
      {/* Header */}
      <div style={{
        padding: `${W.s2}px ${W.s3}px`,
        borderBottom: `1px solid ${W.border}`,
        display: 'flex',
        alignItems: 'center',
        gap: W.s2,
        flexShrink: 0,
      }}>
        <span style={{
          fontSize: W.fontSm,
          color: W.textMuted,
          fontWeight: W.fontWeightSemi,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
        }}>
          Learned Conventions
        </span>
        <span style={{ fontSize: W.fontSm, color: W.textDim, flex: 1 }}>
          .hexis/memories/learned.md
        </span>
        <button
          onClick={refresh}
          title="Refresh (auto-refreshes every 10 s)"
          style={{
            padding: `2px ${W.s2}px`,
            background: 'transparent',
            border: `1px solid ${W.border}`,
            borderRadius: W.radius1,
            color: W.textMuted,
            fontSize: W.fontSm,
            cursor: 'pointer',
          }}
        >
          ⟳
        </button>
      </div>

      {/* Body */}
      <div style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        padding: W.s3,
        fontSize: W.fontMd,
        color: W.text,
        lineHeight: 1.55,
      }}>
        {loading && <div style={{ color: W.textDim }}>Loading…</div>}
        {error && (
          <div style={{ color: W.red, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: W.fontSm }}>
            Error: {error}
          </div>
        )}
        {!loading && !error && !exists && (
          <EmptyState onSeeded={refresh} />
        )}
        {!loading && !error && exists && (
          <LearnedRenderer content={content} freshness={freshness} onRefresh={refresh} />
        )}
      </div>
    </div>
  );
}

function EmptyState({ onSeeded }) {
  const [seedState, setSeedState] = useState('idle'); // idle | seeding | error
  const [seedErr, setSeedErr] = useState(null);
  const seed = async () => {
    setSeedState('seeding');
    setSeedErr(null);
    try {
      const res = await fetch('/api/memory/seed', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      setSeedState('idle');
      await onSeeded?.();
    } catch (err) {
      setSeedState('error');
      setSeedErr(err.message || String(err));
    }
  };
  return (
    <div style={{ color: W.textDim, lineHeight: 1.6 }}>
      <div style={{ fontSize: W.fontLg, color: W.textMuted, marginBottom: W.s2 }}>
        No learned conventions yet
      </div>
      <div style={{ fontSize: W.fontMd, marginBottom: W.s3 }}>
        Every time the full agent pipeline runs a review, the Final Reviewer
        appends 1–3 distilled rules to <code style={{
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          color: W.accent,
        }}>.hexis/memories/learned.md</code>. Those rules get
        prepended to every future Planner run — that's the compounding
        quality loop.
      </div>
      <div style={{ marginBottom: W.s3 }}>
        <button
          onClick={seed}
          disabled={seedState === 'seeding'}
          style={{
            padding: `${W.s2}px ${W.s3}px`,
            background: W.accentBg,
            border: `1px solid ${W.accent}`,
            borderRadius: W.radius1,
            color: W.accent,
            fontSize: W.fontMd,
            fontFamily: W.fontFamily,
            fontWeight: W.fontWeightSemi,
            cursor: 'pointer',
          }}
        >
          {seedState === 'seeding' ? 'Seeding…' : 'Seed from CLAUDE.md / AGENTS.md'}
        </button>
        {seedErr && (
          <div style={{ marginTop: W.s1, fontSize: W.fontSm, color: W.red }}>
            {seedErr}
          </div>
        )}
      </div>
      <div style={{ fontSize: W.fontSm, color: W.textDim }}>
        You can also run <b>/task</b> or the <b>Deep review</b> button in chat
        to seed this file from a Critic review.
      </div>
    </div>
  );
}

// Very lightweight markdown-ish renderer. Doesn't pull in a full MD lib
// for this one panel — we parse the three things `learned.md` actually
// uses: `##` h2 headings, `-` bullets, and inline `code` backticks.
function LearnedRenderer({ content, freshness = {}, onRefresh }) {
  const lines = content.split(/\r?\n/);
  const blocks = [];
  let buf = [];
  const flushParagraph = () => {
    if (buf.length) {
      blocks.push({ kind: 'p', text: buf.join(' ') });
      buf = [];
    }
  };
  for (const line of lines) {
    if (/^#{1,3}\s/.test(line)) {
      flushParagraph();
      const depth = line.match(/^#+/)[0].length;
      blocks.push({ kind: 'h', depth, text: line.replace(/^#+\s*/, '') });
    } else if (/^\s*[-*]\s/.test(line)) {
      flushParagraph();
      blocks.push({ kind: 'li', text: line.replace(/^\s*[-*]\s*/, '') });
    } else if (line.trim() === '') {
      flushParagraph();
    } else {
      buf.push(line);
    }
  }
  flushParagraph();

  return (
    <div>
      {blocks.map((b, i) => {
        if (b.kind === 'h') {
          const size = b.depth === 1 ? W.fontXl : b.depth === 2 ? W.fontLg : W.fontMd;
          return (
            <div key={i} style={{
              fontSize: size,
              fontWeight: W.fontWeightSemi,
              color: b.depth === 1 ? W.accent : W.text,
              marginTop: i === 0 ? 0 : W.s3,
              marginBottom: W.s2,
            }}>
              {renderInline(b.text)}
            </div>
          );
        }
        if (b.kind === 'li') {
          return (
            <RuleItem
              key={i}
              text={b.text}
              freshness={freshness[b.text]}
              onChanged={onRefresh}
            />
          );
        }
        return (
          <p key={i} style={{ margin: `${W.s2}px 0`, color: W.textMuted }}>
            {renderInline(b.text)}
          </p>
        );
      })}
    </div>
  );
}

// Individual rule with hover-revealed edit + delete actions.
// Click edit → becomes a textarea inline, Enter saves, Esc cancels.
// Click delete → confirmation prompt then DELETE request.
function RuleItem({ text, freshness, onChanged }) {
  const [mode, setMode] = useState('view'); // view | edit | saving
  const [draft, setDraft] = useState(text);
  const [hover, setHover] = useState(false);
  // Freshness: 1 = applied today, 0 = never or >30d ago.
  // Fresh rules render at full opacity; stale ones fade toward 0.45.
  // Undefined freshness (no metadata yet) renders at 0.7 to distinguish
  // from "active".
  const fresh = freshness ?? 0.7;
  const rowOpacity = 0.45 + fresh * 0.55;

  const save = async () => {
    const next = draft.trim();
    if (!next || next === text) {
      setMode('view');
      return;
    }
    setMode('saving');
    try {
      await patchRule(text, next);
      await onChanged?.();
      setMode('view');
    } catch {
      setMode('edit');
    }
  };

  const remove = async () => {
    if (!confirm('Delete this rule?')) return;
    try {
      await deleteRule(text);
      await onChanged?.();
    } catch { /* ignore */ }
  };

  if (mode === 'edit' || mode === 'saving') {
    return (
      <div style={{
        display: 'flex',
        gap: W.s2,
        marginBottom: W.s2,
        alignItems: 'flex-start',
        padding: W.s2,
        background: W.bg2,
        border: `1px solid ${W.accent}`,
        borderRadius: W.radius1,
      }}>
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
            if (e.key === 'Escape') { e.preventDefault(); setDraft(text); setMode('view'); }
          }}
          rows={2}
          disabled={mode === 'saving'}
          style={{
            flex: 1,
            background: W.bg1,
            border: `1px solid ${W.border}`,
            borderRadius: W.radius1,
            color: W.text,
            fontSize: W.fontMd,
            fontFamily: W.fontFamily,
            padding: `${W.s1}px ${W.s2}px`,
            outline: 'none',
            resize: 'vertical',
          }}
        />
        <button
          onClick={save}
          disabled={mode === 'saving'}
          style={{
            padding: `${W.s1}px ${W.s2}px`,
            background: W.accentBg,
            border: `1px solid ${W.accent}`,
            borderRadius: W.radius1,
            color: W.accent,
            fontSize: W.fontSm,
            cursor: 'pointer',
          }}
        >
          {mode === 'saving' ? 'saving…' : 'save'}
        </button>
        <button
          onClick={() => { setDraft(text); setMode('view'); }}
          style={{
            padding: `${W.s1}px ${W.s2}px`,
            background: 'transparent',
            border: `1px solid ${W.border}`,
            borderRadius: W.radius1,
            color: W.textDim,
            fontSize: W.fontSm,
            cursor: 'pointer',
          }}
        >
          cancel
        </button>
      </div>
    );
  }

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={
        freshness === undefined
          ? 'No usage data yet'
          : freshness > 0.8
            ? 'Applied recently'
            : freshness > 0.2
              ? `Applied ~${Math.round((1 - freshness) * 30)}d ago`
              : 'Stale — not applied in 30+ days'
      }
      style={{
        display: 'flex',
        gap: W.s2,
        marginBottom: W.s1,
        alignItems: 'flex-start',
        padding: `${W.s1}px ${W.s1}px`,
        borderRadius: W.radius1,
        background: hover ? 'rgba(255, 255, 255, 0.02)' : 'transparent',
        opacity: hover ? 1 : rowOpacity,
        transition: 'opacity 120ms',
      }}
    >
      <span style={{
        color: fresh > 0.5 ? W.accent : W.textDim,
        flexShrink: 0,
      }}>•</span>
      <span style={{ flex: 1 }}>{renderInline(text)}</span>
      {hover && (
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          <button
            onClick={() => setMode('edit')}
            title="Edit rule"
            style={{
              padding: '1px 6px',
              background: 'transparent',
              border: `1px solid ${W.border}`,
              borderRadius: 3,
              color: W.textDim,
              fontSize: 10,
              cursor: 'pointer',
            }}
          >
            edit
          </button>
          <button
            onClick={remove}
            title="Delete rule"
            style={{
              padding: '1px 6px',
              background: 'transparent',
              border: `1px solid ${W.border}`,
              borderRadius: 3,
              color: W.textDim,
              fontSize: 10,
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = W.red; e.currentTarget.style.borderColor = W.red; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = W.textDim; e.currentTarget.style.borderColor = W.border; }}
          >
            delete
          </button>
        </div>
      )}
    </div>
  );
}

// Split on `backticks` and render inline code spans distinctly.
function renderInline(text) {
  if (!text) return null;
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((p, i) => {
    if (p.startsWith('`') && p.endsWith('`')) {
      return (
        <code key={i} style={{
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: '0.92em',
          padding: '1px 4px',
          background: 'rgba(240, 160, 48, 0.08)',
          border: `1px solid rgba(240, 160, 48, 0.25)`,
          borderRadius: 3,
          color: W.accent,
        }}>
          {p.slice(1, -1)}
        </code>
      );
    }
    return <span key={i}>{p}</span>;
  });
}
