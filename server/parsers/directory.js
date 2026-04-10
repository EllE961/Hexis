import { readdir, stat } from 'fs/promises';
import { join, relative } from 'path';

const IGNORE_DIRS = new Set([
  '.git', '.claude', 'node_modules', 'nebula', '.github', 'scripts',
  'dist', 'build', 'target', 'out', '.next', '.nuxt', '.cache',
  'coverage', '.vscode', '.idea',
]);

// Binary / generated / junk files we DON'T want in the hex grid.
// Everything else — including extensionless files like LICENSE,
// Makefile, Dockerfile, README, and files the user just created —
// gets shown. This matches how VS Code's explorer behaves.
const BINARY_EXTS = new Set([
  // Executables / libraries
  'exe', 'dll', 'so', 'dylib', 'a', 'lib', 'bin', 'app', 'deb', 'rpm', 'msi',
  // Archives
  'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'jar', 'war',
  // Images
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'tiff', 'svg-binary',
  // Audio / video
  'mp3', 'mp4', 'wav', 'flac', 'ogg', 'avi', 'mov', 'mkv', 'webm', 'm4a',
  // Fonts
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // Documents (binary)
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  // Object / compiled
  'o', 'obj', 'pyc', 'class', 'wasm',
  // OS junk
  'ds_store',
]);

// Hidden files we explicitly DO want to show (dotfiles are normally skipped)
const KEEP_DOTFILES = new Set([
  '.env', '.gitignore', '.gitattributes', '.editorconfig',
  '.prettierrc', '.eslintrc', '.npmrc', '.nvmrc', '.python-version',
  '.dockerignore', '.babelrc',
]);

function isShownFile(name) {
  // Hidden dotfiles — hide by default, with an allow-list for well-known ones
  if (name.startsWith('.')) {
    return KEEP_DOTFILES.has(name);
  }
  // Check extension blacklist
  const idx = name.lastIndexOf('.');
  if (idx < 0) return true; // no extension — LICENSE, Makefile, test — SHOW
  const ext = name.slice(idx + 1).toLowerCase();
  return !BINARY_EXTS.has(ext);
}

/**
 * Recursively scan a directory and return file entries.
 * Each entry: { path (relative), name, directory, isDirectory }
 */
export async function scanDirectory(rootPath, currentPath = rootPath) {
  const entries = [];
  const items = await readdir(currentPath, { withFileTypes: true });

  for (const item of items) {
    const fullPath = join(currentPath, item.name);
    const relPath = relative(rootPath, fullPath).replace(/\\/g, '/');

    if (item.isDirectory()) {
      if (IGNORE_DIRS.has(item.name) || item.name.startsWith('.')) continue;
      entries.push({ path: relPath, name: item.name, directory: relative(rootPath, currentPath).replace(/\\/g, '/') || '.', isDirectory: true });
      const children = await scanDirectory(rootPath, fullPath);
      entries.push(...children);
    } else if (isShownFile(item.name)) {
      entries.push({ path: relPath, name: item.name, directory: relative(rootPath, currentPath).replace(/\\/g, '/') || '.', isDirectory: false });
    }
  }
  return entries;
}
