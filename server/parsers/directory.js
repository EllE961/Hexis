import { readdir, stat } from 'fs/promises';
import { join, relative } from 'path';

const IGNORE_DIRS = new Set([
  '.git', '.claude', 'node_modules', 'nebula', '.github', 'scripts',
  'dist', 'build', 'target', 'out', '.next', '.nuxt', '.cache',
  'coverage', '.vscode', '.idea',
]);

// Source file extensions the agent can read/write
const SOURCE_EXTS = new Set([
  // JS/TS
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
  // Python
  'py', 'pyw',
  // Rust
  'rs',
  // Go
  'go',
  // C/C++
  'c', 'cpp', 'cc', 'h', 'hpp', 'hxx',
  // Java / JVM
  'java', 'kt', 'scala', 'groovy',
  // C#
  'cs',
  // Other languages
  'rb', 'php', 'swift', 'lua', 'dart',
  // Shell
  'sh', 'bash', 'zsh', 'fish',
  // Web
  'html', 'htm', 'css', 'scss', 'sass', 'less',
  'vue', 'svelte',
  // Data / config
  'json', 'yaml', 'yml', 'toml', 'xml', 'ini', 'env',
  // Docs
  'md', 'mdx', 'rst', 'txt',
  // SQL
  'sql',
]);

function isSourceFile(name) {
  const idx = name.lastIndexOf('.');
  if (idx < 0) return false;
  const ext = name.slice(idx + 1).toLowerCase();
  return SOURCE_EXTS.has(ext);
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
    } else if (isSourceFile(item.name)) {
      entries.push({ path: relPath, name: item.name, directory: relative(rootPath, currentPath).replace(/\\/g, '/') || '.', isDirectory: false });
    }
  }
  return entries;
}
