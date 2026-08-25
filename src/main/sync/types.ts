/**
 * Sync vocabulary, kept free of Electron and of I/O so the planner that uses it
 * can be exercised without booting an app or touching a disk.
 */

export type FileSyncState = 'synced' | 'pending_up' | 'pending_down' | 'conflict';

/** One row of sync state, as of the last *successful* sync. Spec §5.3. */
export interface FileRecord {
  relPath: string;
  localHash: string;
  localMtimeMs: number;
  localSize: number;
  remoteHash: string;
  remoteSize: number;
  remoteMtime: string | null;
  state: FileSyncState;
}

/** An entry in the server's tree listing. */
export interface RemoteRecord {
  path: string;
  isDir: boolean;
  size: number | null;
  modified: string | null;
  hash: string | null;
}

/** A file on disk. `hash` is filled in only when the cheap filter says it moved. */
export interface LocalEntry {
  relPath: string;
  size: number;
  mtimeMs: number;
  hash?: string;
}

export type Op =
  | { kind: 'download'; relPath: string; remote: RemoteRecord }
  | { kind: 'upload'; relPath: string; local: LocalEntry }
  | { kind: 'conflict'; relPath: string; remote: RemoteRecord; local: LocalEntry }
  | { kind: 'delete-local'; relPath: string }
  | { kind: 'delete-remote'; relPath: string }
  | { kind: 'move-remote'; from: string; to: string; local: LocalEntry }
  | { kind: 'move-local'; from: string; to: string; remote: RemoteRecord }
  | { kind: 'mkdir-remote'; relPath: string }
  | { kind: 'mkdir-local'; relPath: string }
  | { kind: 'settle'; relPath: string; local: LocalEntry; remote: RemoteRecord }
  | { kind: 'forget'; relPath: string };

/** The path an operation is "about" — the destination, for moves. */
export const opPath = (op: Op): string => ('relPath' in op ? op.relPath : op.to);

/** Changes whenever the work changes, which is what resets a retry budget. */
export function opSignature(op: Op): string {
  switch (op.kind) {
    case 'upload':
      return `${op.kind}:${op.local.hash}`;
    case 'download':
      return `${op.kind}:${op.remote.hash}`;
    case 'conflict':
      return `${op.kind}:${op.local.hash}:${op.remote.hash}`;
    case 'move-remote':
    case 'move-local':
      return `${op.kind}:${op.from}`;
    default:
      return op.kind;
  }
}
