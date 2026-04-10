/**
 * WelcomeScreen — empty-state shown when no workspace is loaded.
 *
 * Lists recently-opened workspaces and exposes the "Open folder…"
 * action that pops the native file picker on Tauri (or instructs the
 * user how to launch from CLI on web/dev mode).
 */

import { useWorkspaceStore } from '../stores/workspaceStore.js';
import { W } from '../theme/window-tokens.js';
import { FolderOpen, Clock, X } from 'lucide-react';

const IS_TAURI = typeof window !== 'undefined' && window.__TAURI_INTERNALS__;

export default function WelcomeScreen({ onOpen }) {
  const recent = useWorkspaceStore(s => s.recent);
  const pickFolder = useWorkspaceStore(s => s.pickFolder);
  const setWorkspace = useWorkspaceStore(s => s.setWorkspace);
  const forget = useWorkspaceStore(s => s.forget);

  const handleOpen = async () => {
    const path = await pickFolder();
    if (path) {
      setWorkspace(path);
      onOpen?.(path);
    }
  };

  const handleRecentClick = (path) => {
    setWorkspace(path);
    onOpen?.(path);
  };

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: W.bg0,
        color: W.text,
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
    >
      <div style={{ width: 520, maxWidth: '92vw' }}>
        {/* Logo + title */}
        <div style={{ textAlign: 'center', marginBottom: W.s5 }}>
          <div
            style={{
              fontSize: 48,
              color: W.accent,
              lineHeight: 1,
              marginBottom: W.s3,
              filter: 'drop-shadow(0 4px 12px rgba(240, 160, 48, 0.3))',
            }}
          >
            ⬡
          </div>
          <div
            style={{
              fontSize: 28,
              fontWeight: 700,
              letterSpacing: '-0.02em',
              color: W.text,
              marginBottom: 4,
            }}
          >
            Hexis
          </div>
          <div style={{ fontSize: W.fontMd, color: W.textMuted }}>
            Honeycomb hex-grid AI-native IDE
          </div>
        </div>

        {/* Open folder card */}
        {IS_TAURI ? (
          <button
            onClick={handleOpen}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: W.s3,
              width: '100%',
              padding: `${W.s4}px ${W.s4}px`,
              background: W.bg1,
              border: `1px solid ${W.borderHi}`,
              borderRadius: W.radius2,
              color: W.text,
              cursor: 'pointer',
              textAlign: 'left',
              transition: `background ${W.animFast}, border-color ${W.animFast}`,
              marginBottom: W.s4,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = W.bg2;
              e.currentTarget.style.borderColor = W.accent;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = W.bg1;
              e.currentTarget.style.borderColor = W.borderHi;
            }}
          >
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: W.radius1,
                background: W.accentBg,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: W.accent,
                flexShrink: 0,
              }}
            >
              <FolderOpen size={18} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: W.fontLg, fontWeight: W.fontWeightSemi, marginBottom: 2 }}>
                Open folder…
              </div>
              <div style={{ fontSize: W.fontSm, color: W.textMuted }}>
                Pick any directory on your machine
              </div>
            </div>
          </button>
        ) : (
          <div
            style={{
              padding: W.s4,
              background: W.bg1,
              border: `1px solid ${W.border}`,
              borderRadius: W.radius2,
              marginBottom: W.s4,
            }}
          >
            <div style={{ fontSize: W.fontLg, fontWeight: W.fontWeightSemi, marginBottom: W.s2 }}>
              Web mode
            </div>
            <div style={{ fontSize: W.fontSm, color: W.textMuted, marginBottom: W.s3, lineHeight: 1.5 }}>
              In dev/web mode, Hexis follows the directory you pass to the CLI:
            </div>
            <pre
              style={{
                background: W.bg0,
                padding: W.s3,
                borderRadius: W.radius1,
                fontFamily: '"JetBrains Mono", monospace',
                fontSize: 12,
                color: W.accent,
                overflow: 'auto',
                margin: 0,
              }}
            >
{`# Run from inside any project
cd /path/to/your/project
hexis .

# Or pass a path explicitly
hexis /path/to/another/project

# Pick a different port
hexis . --port 4000`}
            </pre>
          </div>
        )}

        {/* Recent workspaces */}
        {recent.length > 0 && (
          <div>
            <div
              style={{
                fontSize: W.fontXs,
                color: W.textMuted,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                marginBottom: W.s2,
                display: 'flex',
                alignItems: 'center',
                gap: W.s2,
              }}
            >
              <Clock size={11} /> Recent workspaces
            </div>
            <div
              style={{
                background: W.bg1,
                border: `1px solid ${W.border}`,
                borderRadius: W.radius2,
                overflow: 'hidden',
              }}
            >
              {recent.map((path) => {
                const name = path.split(/[\\/]/).filter(Boolean).pop() || path;
                return (
                  <div
                    key={path}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: W.s2,
                      padding: `${W.s2}px ${W.s3}px`,
                      borderBottom: `1px solid ${W.borderSubtle}`,
                      cursor: IS_TAURI ? 'pointer' : 'default',
                    }}
                    onMouseEnter={(e) => {
                      if (IS_TAURI) e.currentTarget.style.background = W.bg2;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent';
                    }}
                  >
                    <div
                      style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}
                      onClick={() => IS_TAURI && handleRecentClick(path)}
                    >
                      <div
                        style={{
                          fontSize: W.fontMd,
                          color: W.text,
                          fontWeight: W.fontWeightMed,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {name}
                      </div>
                      <div
                        style={{
                          fontSize: W.fontSm,
                          color: W.textMuted,
                          fontFamily: '"JetBrains Mono", monospace',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {path}
                      </div>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); forget(path); }}
                      title="Remove from recents"
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: W.textGhost,
                        cursor: 'pointer',
                        padding: 4,
                        display: 'flex',
                      }}
                    >
                      <X size={11} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Footer hint */}
        <div
          style={{
            textAlign: 'center',
            marginTop: W.s5,
            fontSize: W.fontSm,
            color: W.textGhost,
          }}
        >
          {IS_TAURI
            ? 'You can also launch with: hexis-app /path/to/repo'
            : 'Hexis web is locked to the directory passed to its server'}
        </div>
      </div>
    </div>
  );
}
