/**
 * Search Store — workspace search state.
 *
 * Holds the last query, flags, results, and running state. Hits the
 * Tauri command `search_workspace` in desktop mode, or the Express
 * POST /api/search endpoint in web dev mode.
 */

import { create } from 'zustand';

const IS_TAURI = typeof window !== 'undefined' && window.__TAURI_INTERNALS__;

export const useSearchStore = create((set, get) => ({
  query: '',
  regex: false,
  caseSensitive: false,
  glob: '',
  results: [],
  running: false,
  error: null,
  truncated: false,

  setQuery: (q) => set({ query: q }),
  setRegex: (v) => set({ regex: !!v }),
  setCaseSensitive: (v) => set({ caseSensitive: !!v }),
  setGlob: (g) => set({ glob: g || '' }),

  clear: () => set({ results: [], error: null, truncated: false }),

  /** Count matches per file path — for the hex grid glow overlay. */
  matchCountByPath: () => {
    const counts = new Map();
    for (const r of get().results) {
      counts.set(r.path, (counts.get(r.path) || 0) + 1);
    }
    return counts;
  },

  /**
   * Run the current query against the workspace. Debounce callers at
   * the UI level; this kicks off immediately.
   */
  run: async () => {
    const s = get();
    const pattern = s.query.trim();
    if (!pattern) {
      set({ results: [], error: null, running: false, truncated: false });
      return;
    }
    set({ running: true, error: null });

    try {
      let data;
      if (IS_TAURI) {
        const { invoke } = await import('@tauri-apps/api/core');
        data = await invoke('search_workspace', {
          pattern,
          regex: s.regex,
          caseSensitive: s.caseSensitive,
          glob: s.glob || null,
          max: 500,
        });
      } else {
        const res = await fetch('/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pattern,
            regex: s.regex,
            caseSensitive: s.caseSensitive,
            glob: s.glob || null,
            max: 500,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `HTTP ${res.status}`);
        }
        data = await res.json();
      }

      set({
        results: data.results || [],
        truncated: !!data.truncated,
        running: false,
      });
    } catch (err) {
      set({ error: err.message || String(err), running: false, results: [] });
    }
  },
}));
