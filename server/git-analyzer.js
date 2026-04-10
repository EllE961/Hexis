import simpleGit from 'simple-git';
import { mkdir } from 'fs/promises';
import { dirname, resolve } from 'path';

let git;
let repoRoot;

export function initGit(repoPath) {
  git = simpleGit(repoPath);
  repoRoot = repoPath;
}

export function getGit() { return git; }

// ─── Read Operations (existing) ───

export async function getCurrentBranch() {
  try {
    const status = await git.status();
    return status.current;
  } catch {
    return 'main';
  }
}

export async function getBranches() {
  try {
    const result = await git.branchLocal();
    return result.all.map(name => ({
      name,
      current: name === result.current,
    }));
  } catch {
    return [];
  }
}

export async function getCommitHistory(maxCount = 200) {
  try {
    const log = await git.log({ maxCount, '--all': null });
    return log.all.map(commit => ({
      hash: commit.hash,
      shortHash: commit.hash.slice(0, 7),
      message: commit.message,
      author: commit.author_name,
      email: commit.author_email,
      date: commit.date,
      refs: commit.refs,
    }));
  } catch {
    return [];
  }
}

export async function getFileMetrics(filePath) {
  try {
    const log = await git.log({ file: filePath, maxCount: 100 });
    if (!log.all.length) return { lastModified: null, changeCount: 0, contributors: [], age: 0 };
    const contributors = [...new Set(log.all.map(c => c.author_name))];
    const lastModified = log.latest?.date || null;
    const oldest = log.all[log.all.length - 1]?.date;
    const age = oldest ? Math.floor((Date.now() - new Date(oldest).getTime()) / 86400000) : 0;
    return { lastModified, changeCount: log.total, contributors, age };
  } catch {
    return { lastModified: null, changeCount: 0, contributors: [], age: 0 };
  }
}

export async function getBranchDiff(branchA = 'HEAD', branchB = 'main') {
  try {
    const diff = await git.diffSummary([branchB, branchA]);
    return diff.files.map(f => ({
      file: f.file,
      insertions: f.insertions,
      deletions: f.deletions,
      binary: f.binary,
      status: f.insertions > 0 && f.deletions > 0 ? 'modified' : f.insertions > 0 ? 'added' : 'deleted',
    }));
  } catch {
    return [];
  }
}

export async function getFileDiff(filePath, branchA = 'HEAD', branchB = 'main') {
  try {
    return await git.diff([branchB, branchA, '--', filePath]);
  } catch {
    return '';
  }
}

/** Get working directory diff for a single file (uncommitted changes) */
export async function getWorkingDiff(filePath) {
  try {
    return await git.diff(['--', filePath]);
  } catch {
    return '';
  }
}

// ─── Git Status ───

export async function getStatus() {
  try {
    const status = await git.status();
    // Filter to only relevant files (skip node_modules, nebula build, etc.)
    const IGNORE = ['node_modules/', 'nebula/node_modules/', 'nebula/dist/', '.claude/'];
    const filter = (files) => (files || []).filter(f =>
      !IGNORE.some(ig => f.startsWith(ig)) && !f.startsWith('.')
    );
    return {
      current: status.current,
      staged: filter(status.staged),
      modified: filter(status.modified),
      not_added: filter(status.not_added),
      deleted: filter(status.deleted),
      created: filter(status.created),
      conflicted: filter(status.conflicted),
      ahead: status.ahead,
      behind: status.behind,
      tracking: status.tracking,
    };
  } catch (err) {
    return { error: err.message };
  }
}

// ─── Write Operations ───

export async function stageFiles(files) {
  try {
    await git.add(files);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

export async function unstageFiles(files) {
  try {
    await git.reset(['HEAD', '--', ...files]);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

export async function commitChanges(message) {
  try {
    const result = await git.commit(message);
    return { ok: true, hash: result.commit, summary: result.summary };
  } catch (err) {
    return { error: err.message };
  }
}

export async function pushChanges(remote = 'origin', branch) {
  try {
    const currentBranch = branch || (await git.status()).current;
    await git.push(remote, currentBranch);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

export async function pullChanges(remote = 'origin', branch) {
  try {
    const currentBranch = branch || (await git.status()).current;
    const result = await git.pull(remote, currentBranch);
    return { ok: true, summary: result.summary };
  } catch (err) {
    return { error: err.message };
  }
}

export async function createBranch(name, from) {
  try {
    if (from) {
      await git.checkoutBranch(name, from);
    } else {
      await git.checkoutLocalBranch(name);
    }
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

export async function checkoutBranch(branch) {
  try {
    await git.checkout(branch);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

export async function mergeBranch(branch) {
  try {
    const result = await git.merge([branch]);
    return { ok: true, result: result.result };
  } catch (err) {
    return { error: err.message };
  }
}

export async function deleteBranch(name) {
  try {
    await git.deleteLocalBranch(name);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

export async function moveFile(fromPath, toPath) {
  const destDir = dirname(resolve(repoRoot, toPath));
  try {
    // Ensure destination directory exists
    await mkdir(destDir, { recursive: true });
    await git.mv(fromPath, toPath);
    return { ok: true };
  } catch (err) {
    // Fallback: untracked files can't be git-mv'd. Use plain fs.rename.
    // Returns { ok: true, fallback: true } so callers can skip the
    // expensive markdown link update scan (untracked files can't have
    // inbound refs by definition).
    const msg = err?.message || '';
    if (/not under version control/i.test(msg) || /did not match any file/i.test(msg)) {
      try {
        const { rename } = await import('fs/promises');
        const fromFull = resolve(repoRoot, fromPath);
        const toFull = resolve(repoRoot, toPath);
        await rename(fromFull, toFull);
        return { ok: true, fallback: true };
      } catch (e2) {
        return { error: e2.message || String(e2) };
      }
    }
    return { error: msg };
  }
}

// ─── Stash Operations ───

export async function stashList() {
  try {
    const result = await git.stashList();
    return (result.all || []).map((entry, index) => ({
      index,
      hash: entry.hash,
      date: entry.date,
      message: entry.message,
      author: entry.author_name,
    }));
  } catch {
    return [];
  }
}

export async function stashPush(message) {
  try {
    const args = ['stash', 'push'];
    if (message) args.push('-m', message);
    await git.raw(args);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

export async function stashPop(index = 0) {
  try {
    await git.raw(['stash', 'pop', `stash@{${index}}`]);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

export async function stashDrop(index = 0) {
  try {
    await git.raw(['stash', 'drop', `stash@{${index}}`]);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

// ─── Blame ───

export async function getBlame(filePath) {
  try {
    const raw = await git.raw(['blame', '--porcelain', filePath]);
    const lines = raw.split('\n');
    const result = [];
    let current = {};

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Header line: hash origLine finalLine [numLines]
      const headerMatch = line.match(/^([0-9a-f]{40})\s+(\d+)\s+(\d+)/);
      if (headerMatch) {
        current = { hash: headerMatch[1], line: parseInt(headerMatch[3], 10) };
        continue;
      }
      if (line.startsWith('author ')) {
        current.author = line.slice(7);
      } else if (line.startsWith('author-time ')) {
        current.date = new Date(parseInt(line.slice(12), 10) * 1000).toISOString();
      } else if (line.startsWith('\t')) {
        current.content = line.slice(1);
        result.push({ ...current });
      }
    }
    return result;
  } catch (err) {
    return { error: err.message };
  }
}

// ─── Commit Detail ───

export async function getCommitDetail(hash) {
  try {
    const show = await git.show([hash]);
    // Parse the output: first lines are metadata, then diff
    const lines = show.split('\n');
    let author = '', date = '', message = '', diffStart = -1;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('Author:')) author = lines[i].slice(7).trim();
      else if (lines[i].startsWith('Date:')) date = lines[i].slice(5).trim();
      else if (lines[i].startsWith('diff --git') && diffStart === -1) {
        diffStart = i;
        break;
      }
    }

    // Message is between the Date line and the diff
    const dateIdx = lines.findIndex(l => l.startsWith('Date:'));
    if (dateIdx !== -1 && diffStart !== -1) {
      message = lines.slice(dateIdx + 1, diffStart).map(l => l.trim()).filter(Boolean).join('\n');
    } else if (dateIdx !== -1) {
      message = lines.slice(dateIdx + 1).map(l => l.trim()).filter(Boolean).join('\n');
    }

    const diff = diffStart !== -1 ? lines.slice(diffStart).join('\n') : '';

    return { hash, author, date, message, diff };
  } catch (err) {
    return { error: err.message };
  }
}

// ─── Amend, Revert, Reset ───

export async function amendCommit(message) {
  try {
    const result = await git.commit(message, { '--amend': null });
    return { ok: true, hash: result.commit, summary: result.summary };
  } catch (err) {
    return { error: err.message };
  }
}

export async function revertCommit(hash) {
  try {
    await git.revert(hash, { '--no-edit': null });
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

export async function resetTo(hash, mode = '--mixed') {
  try {
    // Validate mode
    const validModes = ['--soft', '--mixed', '--hard'];
    if (!validModes.includes(mode)) {
      return { error: `Invalid reset mode: ${mode}. Use --soft, --mixed, or --hard.` };
    }
    await git.reset([mode, hash]);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

// ─── Fetch ───

export async function fetchRemote() {
  try {
    await git.fetch('origin');
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}
