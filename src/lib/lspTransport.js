/**
 * LSP Transport — adapts the Tauri `lsp_*` commands + events to the
 * interface expected by `@codemirror/lsp-client`:
 *
 *   interface Transport {
 *     send(message: string): void
 *     subscribe(handler: (message: string) => void): void
 *     unsubscribe(handler: (message: string) => void): void
 *   }
 *
 * Each transport is bound to a single `serverId`. The Tauri side owns
 * the subprocess lifecycle; this adapter only ferries JSON strings in
 * both directions.
 */

const IS_TAURI = typeof window !== 'undefined' && window.__TAURI_INTERNALS__;

export async function createTauriLspTransport(serverId) {
  if (!IS_TAURI) {
    throw new Error('LSP transport requires Tauri (desktop build).');
  }
  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');

  const handlers = new Set();
  const unlistenFns = [];

  const messageEvent = `lsp://${serverId}/message`;
  const exitEvent = `lsp://${serverId}/exit`;
  const errorEvent = `lsp://${serverId}/error`;

  unlistenFns.push(
    await listen(messageEvent, (event) => {
      const payload = event.payload;
      if (typeof payload !== 'string') return;
      for (const h of handlers) {
        try { h(payload); } catch (err) { console.error('LSP handler error:', err); }
      }
    })
  );
  unlistenFns.push(
    await listen(exitEvent, (event) => {
      console.warn(`[LSP ${serverId}] exited:`, event.payload);
    })
  );
  unlistenFns.push(
    await listen(errorEvent, (event) => {
      console.error(`[LSP ${serverId}] transport error:`, event.payload);
    })
  );

  const transport = {
    send(message) {
      invoke('lsp_send', { serverId, message }).catch((err) => {
        console.error(`[LSP ${serverId}] send failed:`, err);
      });
    },
    subscribe(handler) {
      handlers.add(handler);
    },
    unsubscribe(handler) {
      handlers.delete(handler);
    },
    async dispose() {
      handlers.clear();
      for (const fn of unlistenFns) {
        try { fn(); } catch { /* ignore */ }
      }
      unlistenFns.length = 0;
      try {
        await invoke('lsp_stop', { serverId });
      } catch { /* already stopped */ }
    },
  };

  return transport;
}

/**
 * Spawn a language server sidecar and return a Transport ready to be
 * passed into `@codemirror/lsp-client`'s LSPClient constructor.
 *
 * Attempts `command` first; if not found on PATH, returns null so the
 * caller can gracefully fall back to Layer 1/2 features only.
 */
export async function startLspServer({ serverId, command, args = [], workspace }) {
  if (!IS_TAURI) return null;
  const { invoke } = await import('@tauri-apps/api/core');

  // Detect
  const detect = await invoke('lsp_detect', { serverName: command });
  if (!detect?.found) return null;

  // Start
  try {
    await invoke('lsp_start', {
      serverId,
      command: detect.path || command,
      args,
      workspace: workspace || null,
    });
  } catch (err) {
    console.error(`[LSP ${serverId}] start failed:`, err);
    return null;
  }

  const transport = await createTauriLspTransport(serverId);
  return transport;
}
