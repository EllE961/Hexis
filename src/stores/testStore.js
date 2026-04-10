/**
 * Test Store — manages test runner state and results.
 * Detects and runs tests via the server, caches results per file.
 */

import { create } from 'zustand';

export const useTestStore = create((set, get) => ({
  // ─── State ───
  results: null,    // { passed, failed, total, tests: [{name, file, status, duration, error?}], framework, ranAt }
  running: false,
  error: null,

  // ─── Run tests ───
  runTests: async () => {
    set({ running: true, error: null });
    try {
      const res = await fetch('/api/tests/run', { method: 'POST' });
      const data = await res.json();
      if (data.error) {
        set({ running: false, error: data.error, results: null });
        return data;
      }
      set({ running: false, results: data, error: null });
      return data;
    } catch (err) {
      set({ running: false, error: err.message });
      return { error: err.message };
    }
  },

  // ─── Get cached results from server ───
  fetchLastResults: async () => {
    try {
      const res = await fetch('/api/tests/status');
      const data = await res.json();
      if (data && data.total != null) {
        set({ results: data });
      }
    } catch { /* ignore — no cached results */ }
  },

  // ─── Per-file test status ───
  getFileTestStatus: (filePath) => {
    const { results } = get();
    if (!results || !results.tests) return null;

    // Normalize path for comparison (strip leading ./ or /)
    const normalize = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');
    const normalized = normalize(filePath);

    const fileTests = results.tests.filter(t => {
      const testFile = normalize(t.file || '');
      return testFile === normalized || testFile.endsWith(normalized) || normalized.endsWith(testFile);
    });

    if (fileTests.length === 0) return null;

    const hasFail = fileTests.some(t => t.status === 'fail');
    return hasFail ? 'fail' : 'pass';
  },

  // ─── Clear results ───
  clearResults: () => set({ results: null, error: null }),
}));
