import { useRef, useEffect, useCallback } from 'react';
import { useGraphStore } from '../../hooks/useGraph.js';
import { getSectionColor } from '../utils/colors.js';

const MAP_W = 180;
const MAP_H = 130;
const PAD = 12;

export default function Minimap({ graphRef }) {
  const canvasRef = useRef();
  const nodes = useGraphStore(s => s.nodes);
  const selectedNode = useGraphStore(s => s.selectedNode);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = MAP_W * dpr;
    canvas.height = MAP_H * dpr;
    ctx.scale(dpr, dpr);

    let animId;

    const draw = () => {
      ctx.clearRect(0, 0, MAP_W, MAP_H);

      // Background
      ctx.fillStyle = 'rgba(10, 10, 15, 0.9)';
      ctx.beginPath();
      ctx.roundRect(0, 0, MAP_W, MAP_H, 8);
      ctx.fill();

      if (nodes.length === 0) {
        animId = requestAnimationFrame(draw);
        return;
      }

      // Compute bounds of all nodes
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const n of nodes) {
        if (!isFinite(n.x) || !isFinite(n.y)) continue;
        minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
        minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
      }
      if (!isFinite(minX)) {
        animId = requestAnimationFrame(draw);
        return;
      }

      const rangeX = maxX - minX || 1;
      const rangeY = maxY - minY || 1;
      const scaleX = (MAP_W - PAD * 2) / rangeX;
      const scaleY = (MAP_H - PAD * 2) / rangeY;
      const scale = Math.min(scaleX, scaleY);
      const offsetX = PAD + ((MAP_W - PAD * 2) - rangeX * scale) / 2;
      const offsetY = PAD + ((MAP_H - PAD * 2) - rangeY * scale) / 2;

      const toMapX = (gx) => (gx - minX) * scale + offsetX;
      const toMapY = (gy) => (gy - minY) * scale + offsetY;

      // Draw viewport rectangle
      const fg = graphRef?.current;
      if (fg && fg.screen2GraphCoords) {
        try {
          const tl = fg.screen2GraphCoords(0, 0);
          const br = fg.screen2GraphCoords(window.innerWidth, window.innerHeight);
          if (isFinite(tl.x) && isFinite(br.x)) {
            const vx = toMapX(tl.x);
            const vy = toMapY(tl.y);
            const vw = (br.x - tl.x) * scale;
            const vh = (br.y - tl.y) * scale;

            ctx.strokeStyle = 'rgba(99, 102, 241, 0.4)';
            ctx.lineWidth = 1;
            ctx.fillStyle = 'rgba(99, 102, 241, 0.05)';
            ctx.beginPath();
            ctx.rect(
              Math.max(0, vx), Math.max(0, vy),
              Math.min(MAP_W, vw), Math.min(MAP_H, vh)
            );
            ctx.fill();
            ctx.stroke();
          }
        } catch {}
      }

      // Draw nodes
      for (const n of nodes) {
        if (!isFinite(n.x) || !isFinite(n.y)) continue;
        const mx = toMapX(n.x);
        const my = toMapY(n.y);
        const color = getSectionColor(n.section);
        const isSelected = n.id === selectedNode;
        const r = isSelected ? 3.5 : n.connections >= 3 ? 2.5 : 1.8;

        ctx.beginPath();
        ctx.arc(mx, my, r, 0, Math.PI * 2);
        ctx.fillStyle = isSelected ? '#2C1810' : color;
        ctx.globalAlpha = isSelected ? 1 : n._isFiltered ? 0.1 : 0.7;
        ctx.fill();
        ctx.globalAlpha = 1;

        // Glow on selected
        if (isSelected) {
          ctx.beginPath();
          ctx.arc(mx, my, 6, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(99, 102, 241, 0.3)';
          ctx.fill();
        }
      }

      // Border
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(0.5, 0.5, MAP_W - 1, MAP_H - 1, 8);
      ctx.stroke();

      animId = requestAnimationFrame(draw);
    };

    animId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animId);
  }, [nodes, selectedNode, graphRef]);

  // Click to navigate
  const handleClick = useCallback((e) => {
    const fg = graphRef?.current;
    if (!fg || nodes.length === 0) return;

    const rect = canvasRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // Compute same bounds as in draw
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of nodes) {
      if (!isFinite(n.x) || !isFinite(n.y)) continue;
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    }
    if (!isFinite(minX)) return;

    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;
    const scaleX = (MAP_W - PAD * 2) / rangeX;
    const scaleY = (MAP_H - PAD * 2) / rangeY;
    const scale = Math.min(scaleX, scaleY);
    const offsetX = PAD + ((MAP_W - PAD * 2) - rangeX * scale) / 2;
    const offsetY = PAD + ((MAP_H - PAD * 2) - rangeY * scale) / 2;

    const gx = (mx - offsetX) / scale + minX;
    const gy = (my - offsetY) / scale + minY;

    fg.centerAt(gx, gy, 300);
  }, [graphRef, nodes]);

  return (
    <div
      className="absolute bottom-12 left-3 z-30"
      style={{ opacity: nodes.length > 0 ? 1 : 0, transition: 'opacity 300ms ease' }}
    >
      <canvas
        ref={canvasRef}
        style={{ width: MAP_W, height: MAP_H, borderRadius: 8, cursor: 'crosshair' }}
        onClick={handleClick}
      />
    </div>
  );
}
