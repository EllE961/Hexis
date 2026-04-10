/**
 * Symbol Index Store — workspace-wide symbol cache.
 *
 * Populated lazily: every file that's opened in the editor contributes
 * its symbols to the index (via Lezer extraction). Additionally, we
 * can background-scan the whole project on first run via ripgrep +
 * a lightweight regex fallback for files we haven't parsed yet.
 *
 * The index supports fuzzy search by symbol name across all files,
 * powering the Cmd+T workspace symbol picker in the command palette.
 *
 * Shape:
 *   entries: Map<filePath, { mtime, symbols: [{ kind, name, line, col }] }>
 *   flatIndex: cached flat list for fast search (rebuilt on entries change)
 */

import { create } from 'zustand';

const MAX_SEARCH_RESULTS = 100;

export const useSymbolIndexStore = create((set, get) => ({
  entries: new Map(),
  flatIndex: [],
  lastBuiltAt: 0,

  /**
   * Upsert symbols for a file. Called when a file is opened or edited.
   * Symbols should come from ./components/editor/symbols.js buildOutline().
   */
  upsert: (filePath, outline) => {
    if (!filePath) return;
    const symbols = flattenOutline(outline, filePath);
    set((s) => {
      const entries = new Map(s.entries);
      entries.set(filePath, { updatedAt: Date.now(), symbols });
      const flat = buildFlat(entries);
      return { entries, flatIndex: flat, lastBuiltAt: Date.now() };
    });
  },

  /** Remove all symbols for a file (e.g. file deleted). */
  remove: (filePath) => {
    set((s) => {
      if (!s.entries.has(filePath)) return s;
      const entries = new Map(s.entries);
      entries.delete(filePath);
      const flat = buildFlat(entries);
      return { entries, flatIndex: flat, lastBuiltAt: Date.now() };
    });
  },

  /** Search the index by fuzzy name match. */
  search: (query, limit = MAX_SEARCH_RESULTS) => {
    const q = (query || '').trim().toLowerCase();
    if (!q) return [];
    const flat = get().flatIndex;
    const matches = [];
    for (const item of flat) {
      const nameLower = item.name.toLowerCase();
      if (nameLower === q) {
        matches.push({ ...item, score: 1000 });
      } else if (nameLower.startsWith(q)) {
        matches.push({ ...item, score: 800 - (nameLower.length - q.length) });
      } else if (nameLower.includes(q)) {
        matches.push({ ...item, score: 500 - (nameLower.length - q.length) });
      } else if (fuzzyMatch(q, nameLower)) {
        matches.push({ ...item, score: 200 - (nameLower.length - q.length) });
      }
    }
    matches.sort((a, b) => b.score - a.score);
    return matches.slice(0, limit);
  },

  clear: () => set({ entries: new Map(), flatIndex: [], lastBuiltAt: 0 }),
}));

function flattenOutline(items, filePath, parentPath = '') {
  const out = [];
  for (const item of items || []) {
    const containerPath = parentPath ? `${parentPath}.${item.name}` : item.name;
    out.push({
      path: filePath,
      kind: item.kind,
      name: item.name,
      from: item.nameFrom,
      to: item.nameTo,
      container: parentPath || null,
    });
    if (item.children && item.children.length > 0) {
      out.push(...flattenOutline(item.children, filePath, containerPath));
    }
  }
  return out;
}

function buildFlat(entries) {
  const flat = [];
  for (const [, entry] of entries) {
    flat.push(...entry.symbols);
  }
  return flat;
}

function fuzzyMatch(needle, haystack) {
  let j = 0;
  for (let i = 0; i < haystack.length && j < needle.length; i++) {
    if (haystack[i] === needle[j]) j++;
  }
  return j === needle.length;
}
