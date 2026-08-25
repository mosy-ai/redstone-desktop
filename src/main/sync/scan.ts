/**
 * Local side of the diff: walk the link root, and hash only what looks like it
 * moved.
 *
 * mtime+size is a pre-filter, never a decision (spec §5.3): the server's mtimes
 * come from an S3-backed FUSE mount and a rewrite can keep the same length, so
 * the hash is the only thing worth trusting.
 */
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import type { IgnoreRules } from './ignore';
import type { LocalEntry } from './types';

export type { LocalEntry } from './types';

export interface ScanResult {
  files: Map<string, LocalEntry>;
  dirs: Set<string>;
  /** Files skipped because they exceed the size cap, for the UI to explain. */
  oversized: string[];
  count: number;
}

export interface ScanOptions {
  maxFileBytes: number;
  /** Stop early once this many files are seen (used by the pre-link check). */
  limit?: number;
  signal?: AbortSignal;
}

export async function scanDirectory(
  root: string,
  rules: IgnoreRules,
  opts: ScanOptions,
): Promise<ScanResult> {
  const files = new Map<string, LocalEntry>();
  const dirs = new Set<string>();
  const oversized: string[] = [];
  let count = 0;

  const walk = async (absDir: string, relDir: string): Promise<void> => {
    if (opts.signal?.aborted) return;
    if (opts.limit && count >= opts.limit) return;

    let entries: Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: treat as empty rather than failing the cycle
    }

    for (const entry of entries) {
      if (opts.limit && count >= opts.limit) return;
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;

      // Symlinks are never followed and never uploaded (spec §5.5).
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (rules.shouldSkip(relPath, true)) continue;
        dirs.add(relPath);
        await walk(path.join(absDir, entry.name), relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (rules.shouldSkip(relPath, false)) continue;

      let stat;
      try {
        stat = await fs.stat(path.join(absDir, entry.name));
      } catch {
        continue; // vanished mid-walk
      }
      if (stat.size > opts.maxFileBytes) {
        oversized.push(relPath);
        continue;
      }
      files.set(relPath, { relPath, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) });
      count++;
    }
  };

  await walk(root, '');
  return { files, dirs, oversized, count };
}

export async function hashFile(absPath: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(absPath);
    const onAbort = () => stream.destroy(new Error('aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    stream.on('end', () => {
      signal?.removeEventListener('abort', onAbort);
      resolve(hash.digest('hex'));
    });
  });
}

/** Cheap pre-link survey: file count, byte total and the risky markers. */
export async function surveyDirectory(
  root: string,
  rules: IgnoreRules,
  limit: number,
): Promise<{ count: number; bytes: number; hasGit: boolean; hasNodeModules: boolean; truncated: boolean }> {
  let count = 0;
  let bytes = 0;
  let truncated = false;
  const hasGit = await exists(path.join(root, '.git'));
  const hasNodeModules = await exists(path.join(root, 'node_modules'));

  const walk = async (absDir: string, relDir: string): Promise<void> => {
    if (count > limit) {
      truncated = true;
      return;
    }
    let entries: Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count > limit) {
        truncated = true;
        return;
      }
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (rules.shouldSkip(relPath, true)) continue;
        await walk(path.join(absDir, entry.name), relPath);
      } else if (entry.isFile() && !rules.shouldSkip(relPath, false)) {
        count++;
        const stat = await fs.stat(path.join(absDir, entry.name)).catch(() => null);
        if (stat) bytes += stat.size;
      }
    }
  };

  await walk(root, '');
  return { count, bytes, hasGit, hasNodeModules, truncated };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
