/**
 * LSP Store — per-language LSPClient instance cache.
 *
 * Each language in the LSP_CONFIGS map can be "activated" once per
 * workspace. We spawn the server lazily on first file of that language,
 * then reuse the LSPClient + Transport for every subsequent open.
 *
 * Languages without a detected server binary degrade gracefully — the
 * editor still gets Layer 1 (Lezer) features, just no type-accurate
 * definitions/hover/diagnostics.
 *
 * Server binaries are detected on the system PATH via the
 * `lsp_detect` Tauri command. When we ship bundled sidecars via
 * Tauri externalBin, we'll check those too — for now, require
 * system install (standard dev-environment assumption).
 */

import { create } from 'zustand';
import { startLspServer } from '../lib/lspTransport.js';

const IS_TAURI = typeof window !== 'undefined' && window.__TAURI_INTERNALS__;

// Map language extension → LSP server config.
// languageId follows the LSP 3.17 specification:
//   https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocumentItem
export const LSP_CONFIGS = {
  rust: {
    id: 'rust-analyzer',
    command: 'rust-analyzer',
    args: [],
    languageId: 'rust',
    extensions: ['rs'],
  },
  typescript: {
    id: 'typescript-language-server',
    command: 'typescript-language-server',
    args: ['--stdio'],
    languageId: 'typescript',
    extensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'],
  },
  python: {
    id: 'pyright',
    command: 'pyright-langserver',
    args: ['--stdio'],
    languageId: 'python',
    extensions: ['py', 'pyi'],
  },
  go: {
    id: 'gopls',
    command: 'gopls',
    args: [],
    languageId: 'go',
    extensions: ['go'],
  },
};

/** Find a config by file extension. */
export function lspConfigForExt(ext) {
  if (!ext) return null;
  const lowered = ext.toLowerCase();
  for (const cfg of Object.values(LSP_CONFIGS)) {
    if (cfg.extensions.includes(lowered)) return cfg;
  }
  return null;
}

export const useLspStore = create((set, get) => ({
  // Map<serverId, { client, transport, status: 'starting'|'ready'|'failed'|'not-installed', workspace }>
  servers: new Map(),

  /**
   * Ensure a language server is running for the given config + workspace.
   * Returns a promise that resolves to the existing or newly-created
   * LSPClient, or null if the server binary isn't installed.
   *
   * Dynamically imports @codemirror/lsp-client so the bundle isn't paid
   * for until the user opens a supported file.
   */
  ensureServer: async (config, workspace) => {
    if (!IS_TAURI || !config) return null;
    const key = `${config.id}::${workspace || 'global'}`;
    const existing = get().servers.get(key);
    if (existing?.client) return existing.client;
    if (existing?.status === 'starting') {
      // Already in flight — wait for it
      return existing.promise;
    }

    // Mark as starting so concurrent callers share the same promise
    const promise = (async () => {
      try {
        const transport = await startLspServer({
          serverId: key,
          command: config.command,
          args: config.args,
          workspace,
        });
        if (!transport) {
          set((s) => {
            const next = new Map(s.servers);
            next.set(key, { status: 'not-installed', transport: null, client: null });
            return { servers: next };
          });
          return null;
        }

        const { LSPClient } = await import('@codemirror/lsp-client');

        const client = new LSPClient({
          rootUri: workspace ? pathToUri(workspace) : null,
          workspaceFolders: workspace
            ? [{ uri: pathToUri(workspace), name: workspace.split(/[\\/]/).pop() || 'workspace' }]
            : null,
        }).connect(transport);

        // Wait for initialization handshake — the client does this itself,
        // but we can race it against a short timeout to avoid hanging the UI.
        try {
          await Promise.race([
            client.initializing,
            new Promise((_, rej) => setTimeout(() => rej(new Error('LSP init timeout')), 15000)),
          ]);
        } catch (err) {
          console.warn(`[LSP ${key}] init failed or slow:`, err);
        }

        set((s) => {
          const next = new Map(s.servers);
          next.set(key, { status: 'ready', transport, client });
          return { servers: next };
        });
        return client;
      } catch (err) {
        console.error(`[LSP ${key}] start error:`, err);
        set((s) => {
          const next = new Map(s.servers);
          next.set(key, { status: 'failed', transport: null, client: null, error: err?.message });
          return { servers: next };
        });
        return null;
      }
    })();

    set((s) => {
      const next = new Map(s.servers);
      next.set(key, { status: 'starting', promise, transport: null, client: null });
      return { servers: next };
    });

    return promise;
  },

  /** Look up status for a server (used by status-bar indicator). */
  statusFor: (config, workspace) => {
    if (!config) return 'none';
    const key = `${config.id}::${workspace || 'global'}`;
    return get().servers.get(key)?.status || 'idle';
  },

  /** Teardown all servers. Called on workspace close. */
  shutdownAll: async () => {
    const entries = [...get().servers.values()];
    for (const entry of entries) {
      if (entry.transport) {
        try { await entry.transport.dispose?.(); } catch { /* ignore */ }
      }
    }
    set({ servers: new Map() });
  },
}));

/** Build a file:// URI from an absolute path. */
function pathToUri(path) {
  // Normalize Windows backslashes to forward slashes
  let p = String(path).replace(/\\/g, '/');
  // Ensure leading slash (file:///C:/... on Windows, file:///usr/... on POSIX)
  if (!p.startsWith('/')) p = '/' + p;
  return `file://${p}`;
}
