import chokidar from 'chokidar';

/**
 * Watch the repo for file changes and emit deltas.
 *
 * IMPORTANT: Chokidar v4 **dropped glob support entirely**. Passing
 * `'**\/*.js'` style patterns to `chokidar.watch()` in v4 treats them
 * as literal file paths and silently matches nothing — the watcher
 * goes dormant and the frontend never refreshes. The fix is to watch
 * the repo directory as a single path and filter at the event level
 * via the `ignored` function. We accept by extension whitelist so we
 * ignore huge build artifacts (images, binaries, node_modules) but
 * still catch every source file the agent might touch.
 *
 * @param {string} repoPath - Path to the repo root
 * @param {function} onDelta - Callback with { type, changes } delta events
 */
export function startWatcher(repoPath, onDelta) {
  let debounceTimer = null;
  let pendingChanges = [];

  // Normalize to forward slashes once; chokidar handles OS-native
  // paths internally but our string ops all assume forward slash.
  const rp = repoPath.replace(/\\/g, '/').replace(/\/$/, '');

  // Extensions we care about (source + config + docs).
  const WATCHED_EXTS = new Set([
    'js','jsx','ts','tsx','mjs','cjs',
    'py','pyw','rs','go','java','kt','rb','php','swift',
    'c','cpp','cc','h','hpp','cs','lua','dart',
    'html','htm','css','scss','sass','less','vue','svelte',
    'json','yaml','yml','toml','xml','md','mdx','sql','sh','bash',
  ]);

  // Directories that are ALWAYS ignored regardless of contents.
  const IGNORED_DIRS = new Set([
    'node_modules', '.git', '.claude', 'dist', 'build', 'target',
    'out', '.next', 'coverage', 'nebula', '.github', '.hexis',
    '.serena', '.vite', '.turbo', '.cache', '__pycache__',
  ]);

  // `ignored` as a function — chokidar v4 calls it for every path it
  // considers. Return `true` to skip. We reject:
  //   (a) anything inside one of the IGNORED_DIRS
  //   (b) files whose extension isn't in the whitelist
  //
  // CRITICAL: on the FIRST call, chokidar passes the root path with
  // no `stats` arg. The root has no file extension, so we must NOT
  // ignore extension-less paths blindly — otherwise chokidar refuses
  // to descend into the project and the watcher goes dormant. Rule:
  // extension-less path = either a directory or a dotless filename;
  // always keep, let chokidar walk in. Extension filtering only
  // applies when we KNOW the path is a file (has an extension OR
  // stats says so).
  const lastSegmentHasExt = (p) => {
    const last = p.slice(p.lastIndexOf('/') + 1);
    return last.includes('.');
  };

  const ignoredFn = (path, stats) => {
    const norm = path.replace(/\\/g, '/');
    // Filter by ignored directory segments anywhere in the path
    const segments = norm.split('/');
    for (const seg of segments) {
      if (IGNORED_DIRS.has(seg)) return true;
    }
    // If chokidar tells us it's a directory, always keep it
    if (stats?.isDirectory?.()) return false;
    // If the last path segment has no dot, treat as dir/dotless-file
    // and keep it — descending or letting chokidar decide
    if (!lastSegmentHasExt(norm)) return false;
    // File with extension — filter by whitelist
    const ext = norm.slice(norm.lastIndexOf('.') + 1).toLowerCase();
    return !WATCHED_EXTS.has(ext);
  };

  const watcher = chokidar.watch(rp, {
    ignored: ignoredFn,
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

  const toRel = (filePath) =>
    filePath.replace(/\\/g, '/').replace(rp, '').replace(/^\//, '');

  watcher.on('add',    (filePath) => queueChange({ action: 'add',    path: toRel(filePath) }));
  watcher.on('change', (filePath) => queueChange({ action: 'change', path: toRel(filePath) }));
  watcher.on('unlink', (filePath) => queueChange({ action: 'remove', path: toRel(filePath) }));

  watcher.on('error', (err) => {
    console.error('[watcher] error:', err?.message || err);
  });
  watcher.on('ready', () => {
    console.log(`[watcher] ready — watching ${rp}`);
  });

  return watcher;
}
