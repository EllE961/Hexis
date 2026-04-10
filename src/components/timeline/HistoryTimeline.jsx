/**
 * HistoryTimeline — horizontal commit history bar.
 * Sits above the status bar. Shows commit dots on a timeline,
 * HEAD highlighted, branch labels at fork points, tooltips on hover.
 * Click a commit to inspect changed files; drag to "time travel".
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { W } from '../../theme/window-tokens.js';

// ─── Theme — proxy onto active W theme ───
const T = new Proxy({}, {
  get(_, key) {
    switch (key) {
      case 'bg':      return W.bg1;
      case 'amber':   return W.accent;
      case 'text':    return W.text;
      case 'dim':     return W.textMuted;
      case 'border':  return W.border;
      case 'glow':    return W.borderHi;
      case 'surface': return W.bg2;
      default:        return W[key];
    }
  },
});

// ─── Helpers ───

function relativeDate(iso) {
  if (!iso) return '';
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = Math.max(0, now - then);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function shortHash(hash) {
  return hash ? hash.slice(0, 7) : '';
}

function truncate(str, max = 48) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '...' : str;
}

// ─── Local data hook ───

function useCommits(visible) {
  const [commits, setCommits] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetch_ = useCallback(async () => {
    if (!visible) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/commits?limit=50');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // Expect array or { commits: [] }
      setCommits(Array.isArray(data) ? data : data.commits || []);
    } catch (err) {
      setError(err.message);
      setCommits([]);
    } finally {
      setLoading(false);
    }
  }, [visible]);

  useEffect(() => { fetch_(); }, [fetch_]);

  return { commits, loading, error, refresh: fetch_ };
}

// ─── Component ───

export default function HistoryTimeline({ onSelectCommit }) {
  const [visible, setVisible] = useState(false);
  const { commits, loading, error } = useCommits(visible);

  const [selectedHash, setSelectedHash] = useState(null);
  const [hoveredIdx, setHoveredIdx] = useState(null);
  const [dragging, setDragging] = useState(false);

  const scrollRef = useRef(null);
  const trackRef = useRef(null);

  // HEAD is the first commit in the list (most recent)
  const headHash = commits[0]?.hash || null;

  // Extract branch labels — commits that have refs / branch names
  const branchPoints = useMemo(() => {
    const map = new Map();
    commits.forEach((c, i) => {
      // refs may be array or comma-separated string
      const refs = Array.isArray(c.refs) ? c.refs : (typeof c.refs === 'string' && c.refs ? c.refs.split(',') : []);
      if (refs.length > 0) {
        refs.forEach(ref => {
          const label = String(ref).replace('HEAD -> ', '').replace('origin/', '').trim();
          if (label && !map.has(label)) map.set(label, i);
        });
      }
      // Also check branch field some APIs expose
      if (c.branch && !map.has(c.branch)) map.set(c.branch, i);
    });
    return map;
  }, [commits]);

  // Click handler
  const handleSelect = useCallback((hash) => {
    setSelectedHash(prev => prev === hash ? null : hash);
    onSelectCommit?.(hash);
  }, [onSelectCommit]);

  // Drag "time travel" — mousemove on the track resolves to nearest commit
  const resolveCommitFromX = useCallback((clientX) => {
    if (!trackRef.current || commits.length === 0) return;
    const rect = trackRef.current.getBoundingClientRect();
    const x = clientX - rect.left;
    const pct = Math.max(0, Math.min(1, x / rect.width));
    const idx = Math.round(pct * (commits.length - 1));
    const commit = commits[idx];
    if (commit) {
      setHoveredIdx(idx);
      setSelectedHash(commit.hash);
      onSelectCommit?.(commit.hash);
    }
  }, [commits, onSelectCommit]);

  const onTrackMouseDown = useCallback((e) => {
    setDragging(true);
    resolveCommitFromX(e.clientX);
  }, [resolveCommitFromX]);

  const onTrackMouseMove = useCallback((e) => {
    if (dragging) resolveCommitFromX(e.clientX);
  }, [dragging, resolveCommitFromX]);

  const onTrackMouseUp = useCallback(() => {
    setDragging(false);
  }, []);

  // Attach window-level mouse up so drag ends even outside the track
  useEffect(() => {
    if (!dragging) return;
    const up = () => setDragging(false);
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, [dragging]);

  // ─── Toggle button (always rendered) ───
  const toggleBtn = (
    <button
      className="absolute left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3 py-1 rounded-t-md text-[11px] font-medium z-[41] select-none"
      style={{
        bottom: visible ? 92 : 32,
        background: T.surface,
        color: visible ? T.amber : T.dim,
        border: `1px solid ${T.border}`,
        borderBottom: 'none',
        transition: 'bottom 0.25s ease, color 0.15s ease',
      }}
      onClick={() => setVisible(v => !v)}
      title={visible ? 'Hide timeline' : 'Show commit timeline'}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <circle cx="2" cy="6" r="1.5" fill="currentColor" />
        <circle cx="6" cy="6" r="1.5" fill="currentColor" />
        <circle cx="10" cy="6" r="1.5" fill="currentColor" />
        <line x1="3.5" y1="6" x2="4.5" y2="6" stroke="currentColor" strokeWidth="0.8" />
        <line x1="7.5" y1="6" x2="8.5" y2="6" stroke="currentColor" strokeWidth="0.8" />
      </svg>
      <span>{visible ? 'Hide Timeline' : 'Timeline'}</span>
      <span style={{ fontSize: 9, opacity: 0.5 }}>{visible ? '▼' : '▲'}</span>
    </button>
  );

  // ─── Timeline bar ───
  if (!visible) return toggleBtn;

  const dotSpacing = 28;
  const trackWidth = Math.max(commits.length * dotSpacing, 200);

  return (
    <>
      {toggleBtn}
      <div
        className="absolute left-0 right-0 z-40 select-none"
        style={{
          bottom: 32, // above status bar (h-8 = 32px)
          height: 60,
          background: T.bg,
          borderTop: `1px solid ${T.border}`,
          borderBottom: `1px solid ${T.border}`,
          transition: 'opacity 0.2s ease',
        }}
      >
        {/* Loading / error states */}
        {loading && commits.length === 0 && (
          <div className="flex items-center justify-center h-full text-[11px]" style={{ color: T.dim }}>
            Loading commits...
          </div>
        )}
        {error && (
          <div className="flex items-center justify-center h-full text-[11px]" style={{ color: W.red }}>
            {error}
          </div>
        )}

        {/* Scrollable track */}
        {commits.length > 0 && (
          <div
            ref={scrollRef}
            className="h-full overflow-x-auto overflow-y-hidden"
            style={{ scrollbarWidth: 'thin', scrollbarColor: `${T.dim} transparent` }}
          >
            <div
              ref={trackRef}
              className="relative h-full"
              style={{ width: trackWidth, minWidth: '100%' }}
              onMouseDown={onTrackMouseDown}
              onMouseMove={onTrackMouseMove}
              onMouseUp={onTrackMouseUp}
            >
              {/* Connecting line */}
              <div
                className="absolute"
                style={{
                  top: 30,
                  left: dotSpacing / 2,
                  right: dotSpacing / 2,
                  height: 1,
                  background: `linear-gradient(90deg, ${T.amber}40, ${T.dim}30)`,
                }}
              />

              {/* Branch labels */}
              {Array.from(branchPoints.entries()).map(([label, idx]) => (
                <div
                  key={label}
                  className="absolute text-[9px] font-semibold whitespace-nowrap pointer-events-none"
                  style={{
                    left: idx * dotSpacing + dotSpacing / 2,
                    top: 4,
                    transform: 'translateX(-50%)',
                    color: T.amber,
                    background: `${T.bg}CC`,
                    padding: '1px 5px',
                    borderRadius: 3,
                    border: `1px solid ${T.amber}30`,
                  }}
                >
                  {label}
                </div>
              ))}

              {/* Commit dots */}
              {commits.map((commit, i) => {
                const isHead = commit.hash === headHash;
                const isSelected = commit.hash === selectedHash;
                const isHovered = hoveredIdx === i;
                const size = isHead ? 12 : 8;

                return (
                  <div
                    key={commit.hash}
                    className="absolute flex flex-col items-center"
                    style={{
                      left: i * dotSpacing + dotSpacing / 2 - size / 2,
                      top: 30 - size / 2,
                      cursor: 'pointer',
                    }}
                    onClick={(e) => { e.stopPropagation(); handleSelect(commit.hash); }}
                    onMouseEnter={() => setHoveredIdx(i)}
                    onMouseLeave={() => { if (!dragging) setHoveredIdx(null); }}
                  >
                    {/* Dot */}
                    <div
                      style={{
                        width: size,
                        height: size,
                        borderRadius: '50%',
                        background: isSelected ? T.amber : isHead ? T.amber : T.dim,
                        border: isSelected
                          ? `2px solid ${T.text}`
                          : isHead
                            ? `2px solid ${T.amber}`
                            : `1.5px solid ${T.dim}`,
                        boxShadow: isHead
                          ? `0 0 8px ${T.glow}, 0 0 16px ${T.glow}`
                          : isSelected
                            ? `0 0 6px ${T.glow}`
                            : 'none',
                        transition: 'all 0.15s ease',
                        transform: isHovered ? 'scale(1.4)' : 'scale(1)',
                      }}
                    />

                    {/* Tooltip */}
                    {isHovered && (
                      <div
                        className="absolute pointer-events-none whitespace-nowrap"
                        style={{
                          bottom: 'calc(100% + 24px)',
                          left: '50%',
                          transform: 'translateX(-50%)',
                          background: T.surface,
                          border: `1px solid ${T.border}`,
                          borderRadius: 6,
                          padding: '6px 10px',
                          boxShadow: '0 4px 16px rgba(0, 0, 0, 0.6)',
                          zIndex: 60,
                        }}
                      >
                        <div className="text-[11px] font-mono font-semibold" style={{ color: T.amber }}>
                          {shortHash(commit.hash)}
                          {isHead && (
                            <span
                              className="ml-1.5 text-[9px] font-sans px-1.5 py-0.5 rounded"
                              style={{ background: `${T.amber}25`, color: T.amber }}
                            >
                              HEAD
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] mt-0.5" style={{ color: T.text }}>
                          {truncate(commit.message)}
                        </div>
                        <div className="flex items-center gap-2 mt-1 text-[10px]" style={{ color: T.dim }}>
                          <span>{commit.author_name || commit.author || ''}</span>
                          <span>{relativeDate(commit.date)}</span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
