import { readFile, writeFile } from 'fs/promises';
import { join, dirname, relative, resolve } from 'path';
import { scanDirectory } from './parsers/directory.js';

/**
 * After moving a file, scan all .md files and update any markdown links
 * that pointed to the old path so they point to the new path.
 *
 * @param {string} repoPath — absolute path to the repo root
 * @param {string} oldRelPath — old file path relative to repo (e.g. "research/backlog.md")
 * @param {string} newRelPath — new file path relative to repo (e.g. "engine/guides/backlog.md")
 * @param {object} git — simple-git instance for staging updated files
 * @returns {string[]} — list of files that had links updated
 */
export async function updateMarkdownLinks(repoPath, oldRelPath, newRelPath, git) {
  const entries = await scanDirectory(repoPath);
  const mdFiles = entries.filter(e => !e.isDirectory && e.path !== newRelPath);
  const updatedFiles = [];

  for (const file of mdFiles) {
    const fullPath = join(repoPath, file.path);
    let content;
    try {
      content = await readFile(fullPath, 'utf-8');
    } catch {
      continue;
    }

    // Find code block regions to skip
    const codeRegions = [];
    const codeBlockRegex = /```[\s\S]*?```/g;
    let match;
    while ((match = codeBlockRegex.exec(content)) !== null) {
      codeRegions.push({ start: match.index, end: match.index + match[0].length });
    }

    function isInCodeBlock(pos) {
      return codeRegions.some(r => pos >= r.start && pos < r.end);
    }

    // Find and replace markdown links
    const linkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;
    let newContent = content;
    let changed = false;
    const replacements = [];

    while ((match = linkRegex.exec(content)) !== null) {
      if (isInCodeBlock(match.index)) continue;

      const linkText = match[1];
      const linkTarget = match[2];

      // Split off any #anchor
      const hashIdx = linkTarget.indexOf('#');
      const pathPart = hashIdx >= 0 ? linkTarget.slice(0, hashIdx) : linkTarget;
      const anchor = hashIdx >= 0 ? linkTarget.slice(hashIdx) : '';

      // Skip external links and non-md links
      if (pathPart.startsWith('http') || pathPart.startsWith('//')) continue;
      if (!pathPart.endsWith('.md') && !pathPart.includes('.md#')) continue;

      // Resolve the link target relative to the linking file's directory
      const fileDir = dirname(file.path);
      const resolvedTarget = resolve(repoPath, fileDir, pathPart)
        .replace(/\\/g, '/')
        .replace(repoPath.replace(/\\/g, '/') + '/', '');

      // Check if this link points to the old file path
      if (resolvedTarget === oldRelPath) {
        // Compute new relative path from the linking file to the new location
        const newRelative = relative(fileDir || '.', newRelPath).replace(/\\/g, '/');
        const newLink = `[${linkText}](${newRelative}${anchor})`;
        replacements.push({ from: match[0], to: newLink });
        changed = true;
      }
    }

    if (changed) {
      // Apply replacements (reverse order to preserve positions)
      for (const rep of replacements) {
        newContent = newContent.replace(rep.from, rep.to);
      }
      await writeFile(fullPath, newContent, 'utf-8');
      updatedFiles.push(file.path);

      // Stage the updated file
      if (git) {
        try { await git.add(file.path); } catch {}
      }
    }
  }

  return updatedFiles;
}
