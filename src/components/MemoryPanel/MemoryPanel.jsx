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

export default function MemoryPanel() {
  const [content, setContent] = useState('');
  const [exists, setExists] = useState(true);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/memory/learned');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setContent(data.content || '');
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
          <EmptyState />
        )}
        {!loading && !error && exists && (
          <LearnedRenderer content={content} />
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div style={{ color: W.textDim, lineHeight: 1.6 }}>
      <div style={{ fontSize: W.fontLg, color: W.textMuted, marginBottom: W.s2 }}>
        No learned conventions yet
      </div>
      <div style={{ fontSize: W.fontMd }}>
        Every time the full agent pipeline runs a review, the Final Reviewer
        appends 1–3 distilled rules to <code style={{
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          color: W.accent,
        }}>.hexis/memories/learned.md</code>. Those rules get
        prepended to every future Planner run — that's the compounding
        quality loop.
        <br /><br />
        Run a task through <b>/task</b> or the <b>Deep review</b> button to
        seed this file.
      </div>
    </div>
  );
}

// Very lightweight markdown-ish renderer. Doesn't pull in a full MD lib
// for this one panel — we parse the three things `learned.md` actually
// uses: `##` h2 headings, `-` bullets, and inline `code` backticks.
function LearnedRenderer({ content }) {
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
            <div key={i} style={{
              display: 'flex',
              gap: W.s2,
              marginBottom: W.s1,
              alignItems: 'flex-start',
            }}>
              <span style={{ color: W.accent, flexShrink: 0 }}>•</span>
              <span style={{ flex: 1 }}>{renderInline(b.text)}</span>
            </div>
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
