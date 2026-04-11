/**
 * AIPanel — Premium Claude AI agent interface.
 *
 * Hero input, plan cards, agent badges, streaming output, review display.
 * Reads all state from agentStore. Creates tasks in taskStore on submit.
 */

import { useState, useRef, useEffect, useMemo } from 'react';
import { useAgentStore, AGENT_ROLES } from '../../stores/agentStore.js';
import { Icon } from '../common/Icon.jsx';
import { W } from '../../theme/window-tokens.js';

// ─── Phase definitions ───

const PHASES = [
  { key: 'planning',           label: 'Planning' },
  { key: 'executing',          label: 'Executing' },
  { key: 'testing',            label: 'Testing' },
  { key: 'reviewing',          label: 'Reviewing' },
];

function getPhaseIndex(status) {
  if (!status) return -1;
  if (status === 'planning') return 0;
  if (status === 'executing')  return 1;
  if (status === 'testing')    return 2;
  if (status === 'reviewing' || status === 'done') return 3;
  return -1;
}

// ─── Colors — proxy onto W theme so every key reads the live active theme ───

const C = new Proxy({}, {
  get(_, key) {
    switch (key) {
      case 'bg':       return W.bg0;
      case 'card':     return W.bg1;
      case 'accent':   return W.accent;
      case 'text':     return W.text;
      case 'dim':      return W.textDim;
      case 'muted':    return W.textGhost;
      case 'success':  return W.green;
      case 'error':    return W.red;
      case 'border':   return W.border;
      case 'borderHi': return W.borderHi;
      case 'inputBg':  return W.bg2;
      default:         return W[key];
    }
  },
});

// ─── Main component ───

export default function AIPanel() {
  const submitToWriter = useAgentStore(s => s.submitToWriter);
  const submitResearchTask = useAgentStore(s => s.submitResearchTask);
  const cancelTask     = useAgentStore(s => s.cancelTask);
  const pauseTask      = useAgentStore(s => s.pauseTask);
  const activeTask     = useAgentStore(s => s.activeTask);
  const agents         = useAgentStore(s => s.agents);
  const streamOutput   = useAgentStore(s => s.streamOutput);
  const runs           = useAgentStore(s => s.runs);
  const focusRun       = useAgentStore(s => s.focusRun);

  const [input, setInput] = useState('');
  const [writerCount, setWriterCount] = useState(0);  // how many writers currently refining
  const outputRef = useRef(null);

  // Auto-scroll streaming output
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [streamOutput]);

  const isRunning = activeTask && !['done', 'error', 'cancelled'].includes(activeTask.status);
  const isDone = activeTask?.status === 'done';
  const isError = activeTask?.status === 'error';
  const isCancelled = activeTask?.status === 'cancelled';

  // All runs sorted: active first, then by start time descending
  const allRuns = useMemo(() => {
    const arr = Array.from(runs.values());
    arr.sort((a, b) => {
      const aActive = !['done', 'error', 'cancelled', 'paused'].includes(a.status) ? 1 : 0;
      const bActive = !['done', 'error', 'cancelled', 'paused'].includes(b.status) ? 1 : 0;
      if (aActive !== bActive) return bActive - aActive;
      return (b.startedAt || 0) - (a.startedAt || 0);
    });
    return arr;
  }, [runs]);

  const activeRunCount = allRuns.filter(r => !['done', 'error', 'cancelled', 'paused'].includes(r.status)).length;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!input.trim()) return;
    const prompt = input.trim();
    setInput('');
    // Fire-and-forget — multiple writers can run concurrently
    setWriterCount(c => c + 1);
    submitToWriter(prompt).finally(() => setWriterCount(c => Math.max(0, c - 1)));
  };

  // Deep Research entry point — Ctrl+click or the 🔬 button triggers the
  // "Best Option Guarantee" pipeline instead of the normal writer pipeline.
  // By default the research → task extraction step is OFF; hold Shift while
  // clicking the button to enable "research + create tasks from findings".
  const handleResearch = (e) => {
    e.preventDefault();
    if (!input.trim()) return;
    const query = input.trim();
    setInput('');
    const createTasks = e.shiftKey === true;
    submitResearchTask(query, { createTasks });
  };

  const phaseIndex = getPhaseIndex(activeTask?.status);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      flex: 1,
      minWidth: 0,
      minHeight: 0,
      background: C.bg,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    }}>

      {/* ─── Hero Input Area ─── */}
      <div style={{
        flexShrink: 0,
        padding: '20px 16px 16px',
        borderBottom: `1px solid ${C.border}`,
      }}>
        <form onSubmit={handleSubmit} style={{ margin: 0 }}>
          <div style={{
            background: C.inputBg,
            border: `1px solid ${input.trim() ? C.borderHi : C.border}`,
            borderRadius: 12,
            padding: '14px 16px',
            transition: 'border-color 0.2s ease',
          }}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                // Enter submits, Shift+Enter inserts a newline
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (input.trim()) handleSubmit(e);
                }
              }}
              placeholder="Describe a task — add as many as you like  (Shift+Enter for newline)"
              rows={1}
              style={{
                width: '100%',
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: C.text,
                fontSize: 15,
                fontWeight: 500,
                letterSpacing: '-0.01em',
                caretColor: C.accent,
                lineHeight: '22px',
                resize: 'none',
                fontFamily: 'inherit',
                minHeight: 22,
                // Auto-grow up to ~8 lines, then scroll
                maxHeight: 176,
                overflowY: 'auto',
              }}
              ref={(el) => {
                // Auto-resize to fit content each keystroke, bounded by maxHeight
                if (!el) return;
                el.style.height = 'auto';
                el.style.height = Math.min(el.scrollHeight, 176) + 'px';
              }}
            />
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: 10,
              gap: 8,
            }}>
              <div style={{ fontSize: 11, color: C.muted, display: 'flex', alignItems: 'center', gap: 10 }}>
                {writerCount > 0 && (
                  <span style={{ color: W.accent, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <Icon name="sparkle" size={W.iconSm} color="inherit" />
                    Refining {writerCount}…
                  </span>
                )}
                {activeRunCount > 0 && (
                  <span style={{ color: W.accent, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <Icon name="hubot" size={W.iconSm} color="inherit" />
                    {activeRunCount} bee swarm{activeRunCount !== 1 ? 's' : ''} active
                  </span>
                )}
                {!activeRunCount && writerCount === 0 && <span>Queue is idle</span>}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {activeRunCount > 0 && (
                  <button
                    type="button"
                    onClick={() => allRuns.forEach(r => !['done','error','cancelled','paused'].includes(r.status) && cancelTask(r.id))}
                    style={{
                      padding: '8px 16px',
                      borderRadius: 8,
                      border: `1px solid rgba(248, 81, 73, 0.3)`,
                      background: 'rgba(248, 81, 73, 0.1)',
                      color: C.error,
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Stop all
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleResearch}
                  disabled={!input.trim()}
                  title={input.trim()
                    ? 'Deep research with Best Option Guarantee (hold Shift to also create tasks from findings)'
                    : 'Enter a query first'}
                  style={{
                    padding: '8px 14px',
                    borderRadius: 8,
                    border: `1px solid ${input.trim() ? W.borderHi : W.border}`,
                    background: input.trim() ? W.bg2 : 'transparent',
                    color: input.trim() ? W.accent : C.muted,
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: input.trim() ? 'pointer' : 'default',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    transition: 'all 0.2s ease',
                  }}
                  onMouseEnter={e => {
                    if (input.trim()) e.currentTarget.style.background = W.bg3;
                  }}
                  onMouseLeave={e => {
                    if (input.trim()) e.currentTarget.style.background = W.bg2;
                  }}
                >
                  🔬 Research
                </button>
                <button
                  type="submit"
                  disabled={!input.trim()}
                  style={{
                    padding: '8px 22px',
                    borderRadius: 8,
                    border: 'none',
                    background: input.trim()
                      ? 'linear-gradient(135deg, #F0A030 0%, #E08820 100%)'
                      : 'rgba(240, 160, 48, 0.15)',
                    color: input.trim() ? '#0D1117' : C.muted,
                    fontSize: 13,
                    fontWeight: 700,
                    cursor: input.trim() ? 'pointer' : 'default',
                    transition: 'all 0.2s ease',
                    boxShadow: input.trim()
                      ? '0 2px 12px rgba(240, 160, 48, 0.25)' : 'none',
                  }}
                  onMouseEnter={e => {
                    if (input.trim()) {
                      e.currentTarget.style.boxShadow = '0 4px 20px rgba(240, 160, 48, 0.35)';
                      e.currentTarget.style.transform = 'translateY(-1px)';
                    }
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.boxShadow = input.trim()
                      ? '0 2px 12px rgba(240, 160, 48, 0.25)' : 'none';
                    e.currentTarget.style.transform = 'none';
                  }}
                >
                  Queue Task
                </button>
              </div>
            </div>
          </div>
        </form>
      </div>

      {/* ─── Scrollable body — multi-run list ─── */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        overflowX: 'hidden',
        padding: '8px 12px',
      }}>
        {allRuns.length === 0 ? (
          <IdleMessage />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {allRuns.map(run => (
              <RunCard
                key={run.id}
                run={run}
                isFocused={activeTask?.id === run.id}
                streamOutput={activeTask?.id === run.id ? streamOutput : ''}
                allAgents={agents}
                onFocus={() => focusRun(run.id)}
                onCancel={() => cancelTask(run.id)}
                onPause={() => pauseTask(run.id)}
              />
            ))}
          </div>
        )}
      </div>

      <style>{`
        @keyframes agentPulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(0.8); }
        }
        @keyframes phaseGlow {
          0%, 100% { box-shadow: 0 0 4px rgba(240, 160, 48, 0.3); }
          50% { box-shadow: 0 0 12px rgba(240, 160, 48, 0.6); }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes beeFloat {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-4px); }
        }
        @keyframes progressShimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
      `}</style>
    </div>
  );
}


// ─── Run Card — one per concurrent run ───

function RunCard({ run, isFocused, streamOutput, allAgents, onFocus, onCancel, onPause }) {
  const [expanded, setExpanded] = useState(isFocused);
  const isActive = !['done', 'error', 'cancelled', 'paused'].includes(run.status);
  const isDone = run.status === 'done';
  const isError = run.status === 'error';
  const isPaused = run.status === 'paused';
  const isInterrupted = run.status === 'interrupted';

  // Status color and label
  const statusColor = isDone ? W.green
    : isError ? W.red
    : isInterrupted ? W.red
    : isPaused ? W.accent
    : W.accent;
  const statusLabel = isDone ? 'done'
    : isError ? 'error'
    : isInterrupted ? 'interrupted'
    : isPaused ? 'paused'
    : run.status;

  // Filter agents to only those belonging to this run
  const runAgents = useMemo(
    () => allAgents.filter(a => a.runId === run.id),
    [allAgents, run.id]
  );

  // Cache ratio
  const cacheRead = run.cacheHits?.read || 0;
  const tokensPaid = run.tokensUsed || 0;
  const cacheRatio = cacheRead > 0 ? Math.round((cacheRead / (cacheRead + tokensPaid)) * 100) : 0;

  return (
    <div
      onClick={() => { if (!expanded) setExpanded(true); onFocus(); }}
      style={{
        background: isFocused ? 'rgba(240, 160, 48, 0.05)' : 'rgba(22, 27, 34, 0.6)',
        border: `1px solid ${isFocused ? 'rgba(240, 160, 48, 0.4)' : C.border}`,
        borderRadius: 10,
        overflow: 'hidden',
        animation: 'fadeIn 0.25s ease',
        cursor: 'pointer',
        transition: 'all 0.2s ease',
      }}
    >
      {/* Header — always visible */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 14px',
        borderBottom: expanded ? `1px solid ${C.border}` : 'none',
      }}>
        {/* Status pulse */}
        <span
          style={{
            width: 8, height: 8, borderRadius: '50%',
            background: statusColor,
            boxShadow: isActive ? `0 0 6px ${statusColor}` : 'none',
            animation: isActive ? 'agentPulse 1.5s infinite' : 'none',
            flexShrink: 0,
          }}
        />
        {/* Title (truncated prompt) */}
        <div style={{
          flex: 1, minWidth: 0,
          fontSize: 13, fontWeight: 600, color: C.text,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {run.prompt?.slice(0, 80)}{run.prompt?.length > 80 ? '…' : ''}
        </div>
        {/* Status badge */}
        <span style={{
          fontSize: 10, fontWeight: 600,
          color: statusColor,
          background: `${statusColor}15`,
          padding: '2px 8px',
          borderRadius: 4,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          flexShrink: 0,
        }}>{statusLabel}</span>
        {/* Expand toggle */}
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded(v => !v); }}
          style={{
            background: 'transparent', border: 'none',
            color: C.muted, fontSize: 11, cursor: 'pointer', padding: 2,
          }}
        >
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={W.iconSm} color="inherit" />
        </button>
      </div>

      {/* Expanded body */}
      {expanded && (
        <div style={{ padding: '10px 14px' }}>
          {/* Cost + cache + tokens */}
          <div style={{
            display: 'flex', gap: 12, fontSize: 11, color: C.muted,
            marginBottom: 10, fontFamily: '"JetBrains Mono", monospace',
          }}>
            {run.cost > 0 && <span>${run.cost.toFixed(3)}</span>}
            {run.tokensUsed > 0 && <span>{run.tokensUsed.toLocaleString()} tok</span>}
            {cacheRatio > 0 && <span style={{ color: W.green }}>{cacheRatio}% cached</span>}
            {run.linkedTaskId && <span style={{ color: W.blue }}>linked</span>}
          </div>

          {/* Agents */}
          {runAgents.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {runAgents.map(agent => {
                const role = AGENT_ROLES[agent.role] || AGENT_ROLES.coder;
                return (
                  <span key={agent.id} style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    fontSize: 11, fontWeight: 500,
                    padding: '3px 8px',
                    borderRadius: 4,
                    background: `${role.color}15`,
                    color: role.color,
                    border: `1px solid ${role.color}30`,
                  }}>
                    <span>{role.icon}</span>
                    {role.name}
                    {agent.status === 'reading' || agent.status === 'editing' ? (
                      <span style={{
                        width: 5, height: 5, borderRadius: '50%',
                        background: role.color,
                        animation: 'agentPulse 1.2s infinite',
                      }} />
                    ) : null}
                  </span>
                );
              })}
            </div>
          )}

          {/* Plan + subtasks */}
          {run.plan && (
            <div style={{
              fontSize: 12, color: C.dim,
              padding: '8px 10px', marginBottom: 10,
              background: 'rgba(13, 17, 23, 0.6)',
              borderRadius: 6,
              border: `1px solid ${C.border}`,
            }}>
              <div style={{ fontWeight: 600, color: C.text, marginBottom: 4, fontSize: 11 }}>Plan</div>
              {run.plan.slice(0, 200)}{run.plan.length > 200 ? '…' : ''}
              {run.subtasks?.length > 0 && (
                <div style={{ marginTop: 6, fontSize: 11 }}>
                  {run.subtasks.slice(0, 5).map(st => (
                    <div key={st.id} style={{ display: 'flex', alignItems: 'center', gap: 6, color: st.status === 'done' ? W.green : C.muted }}>
                      <Icon name={st.status === 'done' ? 'pass-filled' : 'circle-large-outline'} size={W.iconSm} color="inherit" />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{st.title}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Stream output (only for focused run) */}
          {isFocused && streamOutput && (
            <pre style={{
              margin: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 11, lineHeight: '17px',
              color: C.dim,
              background: 'rgba(13, 17, 23, 0.6)',
              border: `1px solid ${C.border}`,
              borderRadius: 6,
              padding: 10,
              maxHeight: 200,
              overflowY: 'auto',
              marginBottom: 10,
            }}>{streamOutput.slice(-2000)}</pre>
          )}

          {/* Review */}
          {run.review && (
            <div style={{
              fontSize: 12, color: C.dim,
              padding: '8px 10px', marginBottom: 10,
              background: run.review.approved ? 'rgba(63, 185, 80, 0.06)' : 'rgba(248, 81, 73, 0.06)',
              border: `1px solid ${run.review.approved ? 'rgba(63, 185, 80, 0.2)' : 'rgba(248, 81, 73, 0.2)'}`,
              borderRadius: 6,
            }}>
              <div style={{
                fontWeight: 600, fontSize: 11, marginBottom: 4,
                color: run.review.approved ? W.green : W.red,
                display: 'inline-flex', alignItems: 'center', gap: 4,
              }}>
                <Icon name={run.review.approved ? 'pass-filled' : 'error'} size={W.iconSm} color="inherit" />
                {run.review.approved ? 'Approved' : 'Issues'}{run.review.confidence != null ? ` · ${Math.round(run.review.confidence * 100)}% confidence` : ''}
              </div>
              {run.review.summary?.slice(0, 200)}
            </div>
          )}

          {/* Error */}
          {run.error && (
            <div style={{
              fontSize: 11, color: W.red,
              padding: '8px 10px', marginBottom: 10,
              background: 'rgba(248, 81, 73, 0.06)',
              border: '1px solid rgba(248, 81, 73, 0.2)',
              borderRadius: 6,
              fontFamily: '"JetBrains Mono", monospace',
            }}>{run.error.slice(0, 300)}</div>
          )}

          {/* Action buttons */}
          {isActive && (
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={(e) => { e.stopPropagation(); onPause(); }}
                style={{
                  fontSize: 11, padding: '5px 12px',
                  borderRadius: 5, border: `1px solid ${C.border}`,
                  background: 'transparent', color: C.dim, cursor: 'pointer',
                }}
              >⏸ Pause</button>
              <button
                onClick={(e) => { e.stopPropagation(); onCancel(); }}
                style={{
                  fontSize: 11, padding: '5px 12px',
                  borderRadius: 5, border: '1px solid rgba(248, 81, 73, 0.3)',
                  background: 'rgba(248, 81, 73, 0.1)', color: W.red, cursor: 'pointer',
                }}
              >Stop</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Idle Message ───

function IdleMessage() {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '40px 24px 32px',
      gap: 12,
      animation: 'fadeIn 0.4s ease',
    }}>
      <span style={{
        animation: 'beeFloat 3s ease-in-out infinite',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: W.accent,
      }}>
        <Icon name="hubot" size={W.iconXl} color="inherit" />
      </span>
      <span style={{
        fontSize: 14,
        fontWeight: 500,
        color: C.dim,
        textAlign: 'center',
        lineHeight: '20px',
      }}>
        The hive is idle. Describe a task above
        <br />
        and the bees will plan, build, test, and review it.
      </span>
    </div>
  );
}


// ─── Phase Tracker ───

function PhaseTracker({ phaseIndex, status }) {
  return (
    <div style={{
      flexShrink: 0,
      padding: '14px 16px',
      borderBottom: `1px solid ${C.border}`,
      animation: 'fadeIn 0.3s ease',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
      }}>
        {PHASES.map((phase, i) => {
          const isActive = i === phaseIndex;
          const isDone = i < phaseIndex;
          const isPending = i > phaseIndex;

          return (
            <div key={phase.key} style={{ display: 'flex', alignItems: 'center', flex: 1 }}>
              {/* Phase pill */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '5px 10px',
                borderRadius: 6,
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: '0.02em',
                background: isActive
                  ? 'rgba(240, 160, 48, 0.15)'
                  : isDone
                    ? 'rgba(63, 185, 80, 0.1)'
                    : 'rgba(139, 148, 158, 0.06)',
                color: isActive
                  ? C.accent
                  : isDone
                    ? C.success
                    : C.muted,
                border: isActive
                  ? `1px solid rgba(240, 160, 48, 0.3)`
                  : '1px solid transparent',
                animation: isActive ? 'phaseGlow 2s ease-in-out infinite' : 'none',
                whiteSpace: 'nowrap',
                transition: 'all 0.3s ease',
              }}>
                {isDone && <Icon name="check" size={W.iconSm} color="inherit" />}
                {isActive && (
                  <span style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: C.accent,
                    animation: 'agentPulse 1.5s ease-in-out infinite',
                    flexShrink: 0,
                  }} />
                )}
                {phase.label}
              </div>
              {/* Connector line */}
              {i < PHASES.length - 1 && (
                <div style={{
                  flex: 1,
                  height: 1,
                  margin: '0 4px',
                  background: isDone
                    ? 'rgba(63, 185, 80, 0.3)'
                    : C.border,
                  transition: 'background 0.3s ease',
                }} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}



// ─── Plan Display (post-approval) ───

function PlanDisplay({ plan, subtasks }) {
  if (!subtasks?.length) return null;

  return (
    <div style={{
      flexShrink: 0,
      padding: '12px 16px',
      animation: 'fadeIn 0.3s ease',
    }}>
      <div style={{
        background: C.card,
        borderRadius: 10,
        border: `1px solid ${C.border}`,
        overflow: 'hidden',
      }}>
        {/* Plan summary */}
        <div style={{
          padding: '12px 14px',
          borderBottom: `1px solid ${C.border}`,
        }}>
          <div style={{
            fontSize: 11,
            fontWeight: 700,
            color: C.dim,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            marginBottom: 6,
          }}>
            Plan
          </div>
          <div style={{
            fontSize: 13,
            color: C.dim,
            lineHeight: '19px',
          }}>
            {plan}
          </div>
        </div>

        {/* Subtask checklist */}
        <div style={{ padding: '6px 0' }}>
          {subtasks.map((st, i) => {
            const isDone = st.status === 'done';
            const isRunning = st.status === 'running' || st.status === 'executing';
            return (
              <div key={st.id} style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 14px',
              }}>
                <span style={{
                  color: isDone ? C.success : isRunning ? C.accent : C.muted,
                  width: W.icon,
                  height: W.icon,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  <Icon
                    name={isDone ? 'pass-filled' : isRunning ? 'loading' : 'circle-large-outline'}
                    size={W.icon}
                    color="inherit"
                    className={isRunning ? 'codicon-modifier-spin' : ''}
                  />
                </span>
                <span style={{
                  fontSize: 13,
                  color: isDone ? C.success : C.text,
                  fontWeight: isDone ? 400 : 500,
                  opacity: isDone ? 0.7 : 1,
                  flex: 1,
                }}>
                  {st.title}
                </span>
                {st.files?.length > 0 && (
                  <span style={{
                    fontSize: 11,
                    color: C.muted,
                    fontFamily: '"JetBrains Mono", monospace',
                  }}>
                    {st.files.length} file{st.files.length !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}


// ─── Agent Badges ───

function AgentBadges({ agents }) {
  return (
    <div style={{
      flexShrink: 0,
      padding: '10px 16px',
      animation: 'fadeIn 0.3s ease',
    }}>
      <div style={{
        fontSize: 11,
        fontWeight: 700,
        color: C.dim,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        marginBottom: 8,
      }}>
        Active Agents
      </div>
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
      }}>
        {agents.map(agent => {
          const role = AGENT_ROLES[agent.role] || AGENT_ROLES.coder;
          const isActive = agent.status === 'running' || agent.status === 'reading' || agent.status === 'editing';
          const isDone = agent.status === 'done';
          const isError = agent.status === 'error';

          return (
            <div key={agent.id} style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              padding: '6px 12px',
              borderRadius: 20,
              background: `${role.color}12`,
              border: `1px solid ${role.color}25`,
              transition: 'all 0.2s ease',
            }}>
              {/* Pulsing dot */}
              <span style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                flexShrink: 0,
                background: isDone ? C.success : isError ? C.error : role.color,
                animation: isActive ? 'agentPulse 1.5s ease-in-out infinite' : 'none',
                boxShadow: isActive ? `0 0 6px ${role.color}60` : 'none',
              }} />
              {/* Role name */}
              <span style={{
                fontSize: 12,
                fontWeight: 600,
                color: role.color,
                letterSpacing: '0.01em',
              }}>
                {role.name}
              </span>
              {/* Current file */}
              {agent.currentFile && (
                <span style={{
                  fontSize: 11,
                  color: C.muted,
                  fontFamily: '"JetBrains Mono", monospace',
                  maxWidth: 100,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {agent.currentFile.split('/').pop()}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}


// ─── Status Message (when no stream output) ───

function StatusMessage({ activeTask }) {
  if (activeTask.status === 'error') {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '14px 16px',
        background: 'rgba(248, 81, 73, 0.06)',
        borderRadius: 8,
        border: `1px solid rgba(248, 81, 73, 0.15)`,
      }}>
        <span style={{ fontSize: 15, flexShrink: 0, marginTop: 1 }}>{'!'}</span>
        <div>
          <div style={{
            fontSize: 13,
            fontWeight: 600,
            color: C.error,
            marginBottom: 4,
          }}>
            Error
          </div>
          <div style={{
            fontSize: 13,
            color: C.dim,
            lineHeight: '19px',
          }}>
            {activeTask.error}
          </div>
        </div>
      </div>
    );
  }

  if (activeTask.status === 'done') {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '14px 16px',
        background: 'rgba(63, 185, 80, 0.06)',
        borderRadius: 8,
        border: `1px solid rgba(63, 185, 80, 0.15)`,
        animation: 'fadeIn 0.4s ease',
      }}>
        <Icon name="pass-filled" size={W.iconMd} color={C.success} />
        <span style={{
          fontSize: 14,
          fontWeight: 600,
          color: C.success,
        }}>
          Task complete
        </span>
        {activeTask.tokensUsed > 0 && (
          <span style={{
            fontSize: 11,
            color: C.muted,
            marginLeft: 'auto',
          }}>
            {(activeTask.tokensUsed / 1000).toFixed(1)}k tokens
          </span>
        )}
      </div>
    );
  }

  if (activeTask.status === 'cancelled') {
    return (
      <div style={{
        fontSize: 13,
        color: C.muted,
        padding: '12px 0',
      }}>
        Task cancelled.
      </div>
    );
  }

  // Running states
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '12px 0',
    }}>
      <span style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: C.accent,
        animation: 'agentPulse 1.5s ease-in-out infinite',
        flexShrink: 0,
      }} />
      <span style={{
        fontSize: 13,
        color: C.dim,
      }}>
        Waiting for agent output...
      </span>
    </div>
  );
}


// ─── Review Display ───

function ReviewDisplay({ review }) {
  const approved = review.approved;
  const confidencePct = review.confidence != null ? Math.round(review.confidence * 100) : null;

  return (
    <div style={{
      flexShrink: 0,
      padding: '0 16px 16px',
      animation: 'fadeIn 0.4s ease',
    }}>
      <div style={{
        background: C.card,
        borderRadius: 10,
        border: `1px solid ${approved ? 'rgba(63, 185, 80, 0.2)' : 'rgba(248, 81, 73, 0.2)'}`,
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          padding: '12px 14px',
          borderBottom: `1px solid ${C.border}`,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}>
          <span style={{
            fontSize: 11,
            fontWeight: 700,
            color: C.dim,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}>
            Review
          </span>
          <span style={{
            fontSize: 12,
            fontWeight: 700,
            padding: '3px 10px',
            borderRadius: 4,
            background: approved ? 'rgba(63, 185, 80, 0.12)' : 'rgba(248, 81, 73, 0.12)',
            color: approved ? C.success : C.error,
          }}>
            {approved ? 'Approved' : 'Changes Requested'}
          </span>
        </div>

        {/* Confidence bar */}
        {confidencePct != null && (
          <div style={{ padding: '10px 14px 6px' }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 6,
            }}>
              <span style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>
                Confidence
              </span>
              <span style={{ fontSize: 12, color: C.text, fontWeight: 700 }}>
                {confidencePct}%
              </span>
            </div>
            <div style={{
              height: 4,
              borderRadius: 2,
              background: 'rgba(139, 148, 158, 0.1)',
              overflow: 'hidden',
            }}>
              <div style={{
                height: '100%',
                width: `${confidencePct}%`,
                borderRadius: 2,
                background: confidencePct >= 80
                  ? C.success
                  : confidencePct >= 50
                    ? C.accent
                    : C.error,
                transition: 'width 0.6s ease',
              }} />
            </div>
          </div>
        )}

        {/* Summary */}
        {review.summary && (
          <div style={{
            padding: '10px 14px',
            fontSize: 13,
            color: C.dim,
            lineHeight: '19px',
          }}>
            {review.summary}
          </div>
        )}

        {/* Issues list */}
        {review.issues?.length > 0 && (
          <div style={{
            padding: '6px 14px 12px',
            borderTop: `1px solid ${C.border}`,
          }}>
            <div style={{
              fontSize: 11,
              fontWeight: 700,
              color: C.muted,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              marginBottom: 8,
              paddingTop: 6,
            }}>
              Issues ({review.issues.length})
            </div>
            {review.issues.map((issue, i) => {
              const sevColor = issue.severity === 'critical' ? C.error
                : issue.severity === 'major' ? W.yellow
                : C.muted;
              return (
                <div key={i} style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  padding: '5px 0',
                }}>
                  <span style={{
                    color: sevColor,
                    marginTop: 2,
                    flexShrink: 0,
                    display: 'inline-flex',
                  }}>
                    <Icon
                      name={
                        issue.severity === 'critical' ? 'circle-filled'
                          : issue.severity === 'major' ? 'circle-large-filled'
                          : 'circle-large-outline'
                      }
                      size={W.iconSm}
                      color="inherit"
                    />
                  </span>
                  <div style={{ fontSize: 12, color: C.dim, lineHeight: '17px' }}>
                    {issue.file && (
                      <span style={{
                        fontFamily: '"JetBrains Mono", monospace',
                        fontSize: 11,
                        color: C.accent,
                        marginRight: 4,
                      }}>
                        {issue.file}:
                      </span>
                    )}
                    {issue.description}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
