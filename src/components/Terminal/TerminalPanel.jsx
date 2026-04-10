/**
 * TerminalPanel — Integrated terminal panel.
 *
 * Now a simple content component that fills its DockPanel parent.
 * Output area, input line, command execution, command history.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { W } from '../../theme/window-tokens.js';

// --- Theme — proxy onto active W theme ---
const COLORS = new Proxy({}, {
  get(_, key) {
    switch (key) {
      case 'bg':         return W.bg0;
      case 'border':     return W.border;
      case 'text':       return W.textDim;
      case 'textDim':    return W.textMuted;
      case 'prompt':     return W.green;
      case 'error':      return W.red;
      case 'stdout':     return W.text;
      case 'stdin':      return W.text;
      case 'scrollThumb':return W.border;
      default:           return W[key];
    }
  },
});

const MONO = W.fontMono;

export default function TerminalPanel() {
  const [history, setHistory] = useState([
    { type: 'system', text: '⬡ Hexis Terminal — Type a command and press Enter.' },
  ]);
  const [input, setInput] = useState('');
  const [cmdHistory, setCmdHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [running, setRunning] = useState(false);

  const outputRef = useRef(null);
  const inputRef = useRef(null);

  // Auto-scroll to bottom when history changes
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [history]);

  // Focus input on mount
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  const executeCommand = useCallback(async (command) => {
    const trimmed = command.trim();
    if (!trimmed) return;

    // Add command to display history
    setHistory(h => [...h, { type: 'stdin', text: `$ ${trimmed}` }]);

    // Add to command history (for up/down recall)
    setCmdHistory(prev => {
      const next = prev.filter(c => c !== trimmed);
      next.push(trimmed);
      return next;
    });
    setHistoryIndex(-1);
    setInput('');

    // Handle local "clear" command
    if (trimmed === 'clear' || trimmed === 'cls') {
      setHistory([{ type: 'system', text: '⬡ Hexis Terminal — Cleared.' }]);
      return;
    }

    setRunning(true);
    try {
      const res = await fetch('/api/terminal/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: trimmed }),
      });

      const data = await res.json();

      if (!res.ok) {
        setHistory(h => [...h, { type: 'error', text: data.error || `HTTP ${res.status}` }]);
        setRunning(false);
        return;
      }

      const lines = [];
      if (data.stdout?.trim()) {
        lines.push({ type: 'stdout', text: data.stdout.trimEnd() });
      }
      if (data.stderr?.trim()) {
        lines.push({ type: 'error', text: data.stderr.trimEnd() });
      }
      if (data.exitCode !== 0 && !data.stderr?.trim()) {
        lines.push({ type: 'error', text: `Process exited with code ${data.exitCode}` });
      }
      if (lines.length === 0) {
        // Command succeeded with no output
      }

      setHistory(h => [...h, ...lines]);
    } catch (err) {
      setHistory(h => [...h, { type: 'error', text: `Connection error: ${err.message}` }]);
    }
    setRunning(false);
  }, []);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !running) {
      e.preventDefault();
      executeCommand(input);
      return;
    }

    // Up arrow — previous command
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (cmdHistory.length === 0) return;
      const newIndex = historyIndex === -1
        ? cmdHistory.length - 1
        : Math.max(0, historyIndex - 1);
      setHistoryIndex(newIndex);
      setInput(cmdHistory[newIndex] || '');
      return;
    }

    // Down arrow — next command
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex === -1) return;
      const newIndex = historyIndex + 1;
      if (newIndex >= cmdHistory.length) {
        setHistoryIndex(-1);
        setInput('');
      } else {
        setHistoryIndex(newIndex);
        setInput(cmdHistory[newIndex] || '');
      }
      return;
    }
  }, [input, cmdHistory, historyIndex, running, executeCommand]);

  // Click anywhere in panel to focus input
  const handlePanelClick = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div
      className="flex-1 flex flex-col min-w-0 min-h-0"
      style={{ background: COLORS.bg, overflow: 'hidden' }}
    >
      {/* Output area */}
      <div
        ref={outputRef}
        className="flex-1 overflow-y-auto px-3 py-2"
        style={{
          fontFamily: MONO,
          fontSize: 13,
          lineHeight: '20px',
          cursor: 'text',
        }}
        onClick={handlePanelClick}
      >
        {history.map((entry, i) => (
          <div key={i} className="whitespace-pre-wrap break-all" style={{ color: lineColor(entry.type) }}>
            {entry.text}
          </div>
        ))}
      </div>

      {/* Input line */}
      <div
        className="flex items-center px-3 shrink-0"
        style={{
          height: 32,
          background: COLORS.bg,
          borderTop: `1px solid ${COLORS.border}`,
        }}
      >
        <span
          className="mr-2 select-none font-bold"
          style={{ color: COLORS.prompt, fontFamily: MONO, fontSize: 13 }}
        >
          $
        </span>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={running}
          placeholder={running ? 'Running...' : 'Enter command...'}
          spellCheck={false}
          autoComplete="off"
          className="flex-1 bg-transparent border-none outline-none"
          style={{
            color: COLORS.stdin,
            fontFamily: MONO,
            fontSize: 13,
            caretColor: COLORS.prompt,
            lineHeight: '20px',
          }}
        />
      </div>

      {/* Custom scrollbar styles */}
      <style>{`
        .terminal-scroll ::-webkit-scrollbar { width: 6px; }
        .terminal-scroll ::-webkit-scrollbar-track { background: transparent; }
        .terminal-scroll ::-webkit-scrollbar-thumb { background: ${COLORS.scrollThumb}; border-radius: 3px; }
        .terminal-scroll ::-webkit-scrollbar-thumb:hover { background: rgba(139, 148, 158, 0.35); }
      `}</style>
    </div>
  );
}

function lineColor(type) {
  switch (type) {
    case 'stdin':    return COLORS.stdin;
    case 'stdout':   return COLORS.stdout;
    case 'error':    return COLORS.error;
    case 'system':   return COLORS.textDim;
    default:         return COLORS.text;
  }
}
