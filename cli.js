#!/usr/bin/env node

/**
 * Hexis CLI — point at any directory to visualize it as a honeycomb grid.
 *
 * Usage:
 *   hexis [path]              Open Hexis on a directory (default: current dir)
 *   hexis /path/to/project    Open Hexis on a specific project
 *
 * Options:
 *   --port 3001               Server port (default: 3001)
 */

import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const args = process.argv.slice(2);
let targetPath = process.cwd();
let port = '3001';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    port = args[i + 1];
    i++;
  } else if (!args[i].startsWith('--')) {
    targetPath = resolve(args[i]);
  }
}

process.env.HEXIS_TARGET = targetPath;
process.env.HEXIS_PORT = port;

const __dirname = dirname(fileURLToPath(import.meta.url));

console.log(`\n  ⬡ Hexis — Honeycomb Editor`);
console.log(`  ⬡ Target: ${targetPath}`);
console.log(`  ⬡ Port: ${port}\n`);

// Start server
await import('./server/index.js');
