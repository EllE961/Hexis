import { useEffect, useState, useRef } from 'react';
import { useGraphStore } from '../../hooks/useGraph.js';
import { getNodeColor, getStatusColor } from '../utils/colors.js';

export default function HoverTooltip() {
  const hoveredId = useGraphStore(s => s.hoveredNode);
  const selectedId = useGraphStore(s => s.selectedNode);
  const nodes = useGraphStore(s => s.nodes);
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const timerRef = useRef(null);

  const node = hoveredId ? nodes.find(n => n.id === hoveredId) : null;

  // 200ms delay before showing
  useEffect(() => {
    if (node && !selectedId) {
      timerRef.current = setTimeout(() => setVisible(true), 200);
    } else {
      clearTimeout(timerRef.current);
      setVisible(false);
    }
    return () => clearTimeout(timerRef.current);
  }, [node, selectedId]);

  // Track mouse position
  useEffect(() => {
    const handler = (e) => setPos({ x: e.clientX + 16, y: e.clientY - 10 });
    window.addEventListener('mousemove', handler);
    return () => window.removeEventListener('mousemove', handler);
  }, []);

  if (!visible || !node) return null;

  const sectionColor = getNodeColor(node);
  const statusClr = getStatusColor(node.status);

  return (
    <div
      className="fixed z-50 pointer-events-none"
      style={{
        left: Math.min(pos.x, window.innerWidth - 280),
        top: Math.min(pos.y, window.innerHeight - 100),
        opacity: visible ? 1 : 0,
        transition: 'opacity 100ms cubic-bezier(0,0,0.2,1)',
      }}
    >
      <div
        className="rounded-lg px-4 py-3 min-w-[240px] max-w-[320px]"
        style={{
          background: 'rgba(26,26,36,0.95)',
          backdropFilter: 'blur(12px)',
          border: '1px solid rgba(180,140,60,0.08)',
          boxShadow: '0 4px 12px rgba(120,80,20,0.15), 0 1px 0 rgba(180,140,60,0.03) inset',
        }}
      >
        {/* Title */}
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[15px] font-medium" style={{ color: '#2C1810' }}>
            {node.title || node.label}
          </span>
        </div>

        {/* Meta line */}
        <div className="flex items-center gap-1.5 text-[13px]" style={{ color: '#8B8B9E' }}>
          <span style={{ color: sectionColor }}>{node.type}</span>
          <span>·</span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: statusClr }} />
            {node.status}
          </span>
          <span>·</span>
          <span>{node.section}</span>
        </div>

        {/* Bottom line */}
        <div className="flex items-center gap-2 mt-2 text-[12px]" style={{ color: '#555566' }}>
          {node.lastModified && (
            <span>Modified {new Date(node.lastModified).toLocaleDateString()}</span>
          )}
          {node.connections > 0 && (
            <>
              <span>·</span>
              <span>{node.connections} connections</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
