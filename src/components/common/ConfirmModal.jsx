import { W } from '../../theme/window-tokens.js';
import { AlertTriangle } from 'lucide-react';

export default function ConfirmModal({ title, message, confirmLabel = 'Confirm', danger = false, onConfirm, onCancel }) {
  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center"
      style={{ background: 'rgba(0, 0, 0, 0.6)', backdropFilter: 'blur(6px)' }}
      onClick={onCancel}
    >
      <div
        className="w-full max-w-[400px] rounded-xl overflow-hidden"
        style={{
          background: W.bg1,
          border: `1px solid ${W.border}`,
          boxShadow: W.shadow3,
        }}
        onClick={e => e.stopPropagation()}
      >
        <div className="px-6 py-5">
          <div className="flex items-start gap-3">
            {danger && (
              <div className="mt-0.5 p-2 rounded-lg" style={{ background: W.redBg }}>
                <AlertTriangle size={18} style={{ color: W.red }} />
              </div>
            )}
            <div>
              <h3 className="text-[16px] font-semibold" style={{ color: W.text }}>{title}</h3>
              <p className="text-[14px] mt-2 leading-relaxed" style={{ color: W.textDim }}>{message}</p>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3 px-6 py-4" style={{ borderTop: `1px solid ${W.border}` }}>
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-[13px] font-medium transition-fast"
            style={{ background: W.bg3, color: W.textDim }}
            onMouseEnter={e => e.currentTarget.style.background = W.bg4}
            onMouseLeave={e => e.currentTarget.style.background = W.bg3}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 rounded-lg text-[13px] font-medium transition-fast"
            style={{
              background: danger ? W.red : W.accent,
              color: W.bg0,
            }}
            onMouseEnter={e => e.currentTarget.style.opacity = '0.85'}
            onMouseLeave={e => e.currentTarget.style.opacity = '1'}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
