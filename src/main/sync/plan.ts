/**
 * The classification table from docs/folder-sync-api.md §4, as a pure function.
 *
 * | local     | remote    | action                                  |
 * |-----------|-----------|-----------------------------------------|
 * | unchanged | changed   | download                                |
 * | changed   | unchanged | upload                                  |
 * | changed   | changed   | **conflict** (keep both)                |
 * | deleted   | unchanged | delete remote                           |
 * | unchanged | deleted   | delete local                            |
 * | deleted   | changed   | download — a resurrect beats a loss     |
 * | changed   | deleted   | upload — same reason                    |
 *
 * Nothing here touches the network, the disk or Electron: given three snapshots
 * it returns the operations, which is what makes the rules testable instead of
 * merely asserted. `link-sync.ts` supplies the snapshots and applies the result.
 */
import type { FileRecord, LocalEntry, Op, RemoteRecord } from './types';
import { opPath } from './types';

export interface PlanInput {
  /** Sync state as of the last successful sync, keyed by relative path. */
  records: Map<string, FileRecord>;
  localFiles: Map<string, LocalEntry>;
  localDirs: Set<string>;
  remoteFiles: Map<string, RemoteRecord>;
  remoteDirs: Set<string>;
  /** A partial listing may never be read as "those files were deleted". */
  truncated: boolean;
  /** Ops whose retry budget is spent are dropped until the work changes. */
  isParked?: (op: Op) => boolean;
}

export function planCycle(input: PlanInput): Op[] {
  const { records, localFiles, localDirs, remoteFiles, remoteDirs, truncated } = input;
  const ops: Op[] = [];
  const handled = new Set<string>();

  // Renames first: a path that disappeared and one that appeared with the same
  // hash is a move, not a delete plus a fresh upload.
  for (const [from, to, side] of detectRenames(input)) {
    if (side === 'local') {
      const local = localFiles.get(to);
      if (local) ops.push({ kind: 'move-remote', from, to, local });
    } else {
      const remote = remoteFiles.get(to);
      if (remote) ops.push({ kind: 'move-local', from, to, remote });
    }
    handled.add(from);
    handled.add(to);
  }

  const paths = new Set<string>([...localFiles.keys(), ...remoteFiles.keys(), ...records.keys()]);

  for (const relPath of paths) {
    if (handled.has(relPath)) continue;
    const local = localFiles.get(relPath);
    const remote = remoteFiles.get(relPath);
    const record = records.get(relPath);

    if (!record) {
      if (local && !remote) ops.push({ kind: 'upload', relPath, local });
      else if (!local && remote) ops.push({ kind: 'download', relPath, remote });
      else if (local && remote) {
        // Both sides appeared since we last looked.
        if (local.hash === remote.hash) ops.push({ kind: 'settle', relPath, local, remote });
        else ops.push({ kind: 'conflict', relPath, remote, local });
      }
      continue;
    }

    const localChanged = local ? local.hash !== record.localHash : false;
    const remoteChanged = remote ? remote.hash !== record.remoteHash : false;

    if (local && remote) {
      if (local.hash === remote.hash) {
        if (localChanged || remoteChanged) ops.push({ kind: 'settle', relPath, local, remote });
        continue;
      }
      if (localChanged && remoteChanged) ops.push({ kind: 'conflict', relPath, remote, local });
      else if (localChanged) ops.push({ kind: 'upload', relPath, local });
      else if (remoteChanged) ops.push({ kind: 'download', relPath, remote });
      // Neither side changed but the hashes disagree: an earlier cycle was
      // interrupted between writing and recording. Keep both rather than guess.
      else ops.push({ kind: 'conflict', relPath, remote, local });
      continue;
    }

    if (!local && remote) {
      // Local deletion. A remote edit outranks it: resurrecting beats losing.
      if (remoteChanged) ops.push({ kind: 'download', relPath, remote });
      else ops.push({ kind: 'delete-remote', relPath });
      continue;
    }

    if (local && !remote) {
      if (truncated) continue; // not evidence of deletion
      if (localChanged) ops.push({ kind: 'upload', relPath, local });
      else ops.push({ kind: 'delete-local', relPath });
      continue;
    }

    // Gone from both sides.
    if (!truncated) ops.push({ kind: 'forget', relPath });
  }

  // Empty directories are content too. A directory that already holds files
  // arrives implicitly with the first file, so only the empty ones are worth an
  // explicit operation.
  for (const dir of localDirs) {
    if (!remoteDirs.has(dir) && !hasChildren(localFiles, dir)) {
      ops.push({ kind: 'mkdir-remote', relPath: dir });
    }
  }
  for (const dir of remoteDirs) {
    if (!localDirs.has(dir) && !hasChildren(remoteFiles, dir)) {
      ops.push({ kind: 'mkdir-local', relPath: dir });
    }
  }

  const kept = input.isParked ? ops.filter((op) => !input.isParked?.(op)) : ops;
  return orderOps(kept);
}

function hasChildren(files: Map<string, unknown>, dir: string): boolean {
  const prefix = `${dir}/`;
  for (const key of files.keys()) if (key.startsWith(prefix)) return true;
  return false;
}

/**
 * Pairs of (oldPath, newPath, which side moved).
 *
 * A rename is only claimed when the *other* side still agrees with our record —
 * otherwise it is an edit that happens to share a hash, and a move would throw
 * away the other side's change.
 */
export function detectRenames(input: PlanInput): Array<[string, string, 'local' | 'remote']> {
  const { records, localFiles, remoteFiles, truncated } = input;
  const pairs: Array<[string, string, 'local' | 'remote']> = [];
  const all = [...records.values()];

  const localGone = all.filter((r) => !localFiles.has(r.relPath));
  for (const [newPath, entry] of localFiles) {
    if (records.has(newPath)) continue;
    const match = localGone.find(
      (r) =>
        r.localHash === entry.hash &&
        !pairs.some(([from]) => from === r.relPath) &&
        remoteFiles.get(r.relPath)?.hash === r.remoteHash &&
        !remoteFiles.has(newPath),
    );
    if (match) pairs.push([match.relPath, newPath, 'local']);
  }

  if (!truncated) {
    const remoteGone = all.filter((r) => !remoteFiles.has(r.relPath));
    for (const [newPath, entry] of remoteFiles) {
      if (records.has(newPath)) continue;
      const match = remoteGone.find(
        (r) =>
          r.remoteHash === entry.hash &&
          !pairs.some(([from]) => from === r.relPath) &&
          localFiles.get(r.relPath)?.hash === r.localHash &&
          !localFiles.has(newPath),
      );
      if (match) pairs.push([match.relPath, newPath, 'remote']);
    }
  }
  return pairs;
}

/**
 * Directories before their contents, downloads before uploads (so a conflict
 * copy exists before anything is overwritten), children before parents when
 * deleting.
 */
export function orderOps(ops: Op[]): Op[] {
  const rank: Readonly<Record<Op['kind'], number>> = {
    'mkdir-local': 0,
    'mkdir-remote': 1,
    'move-local': 2,
    'move-remote': 3,
    conflict: 4,
    download: 5,
    upload: 6,
    'delete-local': 7,
    'delete-remote': 8,
    settle: 9,
    forget: 10,
  };
  const depth = (op: Op): number => opPath(op).split('/').length;
  return [...ops].sort((a, b) => {
    const byKind = rank[a.kind] - rank[b.kind];
    if (byKind !== 0) return byKind;
    const deleting = a.kind === 'delete-local' || a.kind === 'delete-remote';
    return deleting ? depth(b) - depth(a) : depth(a) - depth(b);
  });
}

/** `notes.md` → `notes (Redstone's copy 2026-08-11 1043).md` (spec §5.4). */
export function conflictCopyPath(relPath: string, when: Date): string {
  const slash = relPath.lastIndexOf('/');
  const dir = slash >= 0 ? relPath.slice(0, slash + 1) : '';
  const name = relPath.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ` +
    `${pad(when.getHours())}${pad(when.getMinutes())}`;
  return `${dir}${base} (Redstone's copy ${stamp})${ext}`;
}
