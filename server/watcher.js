import chokidar from 'chokidar';
import { join } from 'path';
import { parseFrontmatter } from './parsers/frontmatter.js';
import { extractMarkdownLinks } from './parsers/markdown-links.js';
import { getFileMetrics } from './git-analyzer.js';

/**
 * Watch the repo for file changes and emit deltas.
 * @param {string} repoPath - Path to the repo root
 * @param {function} onDelta - Callback with { type, data } delta events
 */
export function startWatcher(repoPath, onDelta) {
  let debounceTimer = null;
  let pendingChanges = [];

  // Watch all common source file types so bees can fly to any file the agent touches
  const watchPatterns = [
    '**/*.{js,jsx,ts,tsx,mjs,cjs}',
    '**/*.{py,pyw,rs,go,java,kt,rb,php,swift,c,cpp,cc,h,hpp,cs,lua,dart}',
    '**/*.{html,htm,css,scss,sass,less,vue,svelte}',
    '**/*.{json,yaml,yml,toml,xml,md,mdx,sql,sh,bash}',
  ].map(p => join(repoPath, p));

  const watcher = chokidar.watch(watchPatterns, {
    ignored: [
      '**/node_modules/**',
      '**/.git/**',
      '**/.claude/**',
      '**/dist/**',
      '**/build/**',
      '**/target/**',
      '**/out/**',
      '**/.next/**',
      '**/coverage/**',
      '**/nebula/**',
      '**/.github/**',
    ],
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });

  function flushChanges() {
    if (!pendingChanges.length) return;
    const batch = [...pendingChanges];
    pendingChanges = [];
    onDelta({ type: 'batch', changes: batch });
  }

  function queueChange(change) {
    pendingChanges.push(change);
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flushChanges, 500);
  }

  watcher.on('add', async (filePath) => {
    const relPath = filePath.replace(repoPath, '').replace(/\\/g, '/').replace(/^\//, '');
    queueChange({ action: 'add', path: relPath });
  });

  watcher.on('change', async (filePath) => {
    const relPath = filePath.replace(repoPath, '').replace(/\\/g, '/').replace(/^\//, '');
    queueChange({ action: 'change', path: relPath });
  });

  watcher.on('unlink', (filePath) => {
    const relPath = filePath.replace(repoPath, '').replace(/\\/g, '/').replace(/^\//, '');
    queueChange({ action: 'remove', path: relPath });
  });

  return watcher;
}
