/**
 * Per-link sync state: one record per synced file, plus the last tree cursor and
 * the last complete remote listing.
 *
 * Row shape follows spec §5.3 exactly, so this is a drop-in for a SQLite table
 * if the file store ever stops being enough.
 *
 * The remote listing is cached because `unchanged: true` comes back with no
 * entries — without a cached copy we would have to re-request the full tree just
 * to diff against it, which is precisely what the cursor exists to avoid.
 */
import type { TreeEntry } from '../api/client';
import { JsonStore, userDataFile } from '../store';
import type { FileRecord, RemoteRecord } from './types';

export type { FileSyncState, FileRecord, RemoteRecord } from './types';

export interface LinkStateFile {
  version: 1;
  folderId: string;
  localPath: string;
  cursor: string | null;
  truncated: boolean;
  lastSyncedAt: string | null;
  files: Record<string, FileRecord>;
  remote: Record<string, RemoteRecord>;
  conflicts: string[];
  errors: string[];
}

const emptyState = (folderId: string, localPath: string): LinkStateFile => ({
  version: 1,
  folderId,
  localPath,
  cursor: null,
  truncated: false,
  lastSyncedAt: null,
  files: {},
  remote: {},
  conflicts: [],
  errors: [],
});

/** File name is derived from the folder id, which is already opaque. */
const stateFile = (folderId: string): string =>
  userDataFile('sync', `${folderId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);

export class SyncStateStore {
  private constructor(private readonly store: JsonStore<LinkStateFile>) {}

  static async open(folderId: string, localPath: string): Promise<SyncStateStore> {
    const store = await JsonStore.open<LinkStateFile>(
      stateFile(folderId),
      emptyState(folderId, localPath),
      {
        debounceMs: 500,
        migrate: (raw) => {
          const value = raw as Partial<LinkStateFile> | null;
          if (!value || value.version !== 1) return null;
          // A link re-pointed at a different directory starts from scratch:
          // reusing hashes from another tree would mislabel every file.
          if (value.localPath && value.localPath !== localPath) return null;
          return value as LinkStateFile;
        },
      },
    );
    return new SyncStateStore(store);
  }

  get state(): Readonly<LinkStateFile> {
    return this.store.get();
  }

  get cursor(): string | null {
    return this.store.get().cursor;
  }

  get truncated(): boolean {
    return this.store.get().truncated;
  }

  get conflicts(): string[] {
    return [...this.store.get().conflicts];
  }

  get errors(): string[] {
    return [...this.store.get().errors];
  }

  get lastSyncedAt(): string | null {
    return this.store.get().lastSyncedAt;
  }

  files(): FileRecord[] {
    return Object.values(this.store.get().files);
  }

  file(relPath: string): FileRecord | undefined {
    return this.store.get().files[relPath];
  }

  remoteEntries(): RemoteRecord[] {
    return Object.values(this.store.get().remote);
  }

  putFile(record: FileRecord): void {
    this.store.update((draft) => {
      draft.files[record.relPath] = record;
    });
  }

  dropFile(relPath: string): void {
    this.store.update((draft) => {
      delete draft.files[relPath];
    });
  }

  renameFile(from: string, to: string): void {
    this.store.update((draft) => {
      const record = draft.files[from];
      if (!record) return;
      delete draft.files[from];
      draft.files[to] = { ...record, relPath: to };
    });
  }

  /** Replace the cached listing wholesale — it is always a complete tree. */
  setRemote(entries: TreeEntry[], cursor: string | null, truncated: boolean): void {
    this.store.update((draft) => {
      draft.remote = {};
      for (const e of entries) {
        draft.remote[e.path] = {
          path: e.path,
          isDir: e.isDir,
          size: e.size,
          modified: e.modified,
          hash: e.hash,
        };
      }
      draft.cursor = cursor;
      draft.truncated = truncated;
    });
  }

  /** Keep the cached listing in step after we write to the server ourselves. */
  patchRemote(record: RemoteRecord): void {
    this.store.update((draft) => {
      draft.remote[record.path] = record;
    });
  }

  dropRemote(relPath: string): void {
    this.store.update((draft) => {
      delete draft.remote[relPath];
      for (const key of Object.keys(draft.remote)) {
        if (key.startsWith(`${relPath}/`)) delete draft.remote[key];
      }
    });
  }

  /** The cursor is a signature over the tree; our own writes invalidate it. */
  invalidateCursor(): void {
    this.store.update((draft) => {
      draft.cursor = null;
    });
  }

  markConflict(relPath: string): void {
    this.store.update((draft) => {
      if (!draft.conflicts.includes(relPath)) draft.conflicts.push(relPath);
    });
  }

  clearConflict(relPath: string): void {
    this.store.update((draft) => {
      draft.conflicts = draft.conflicts.filter((c) => c !== relPath);
    });
  }

  markError(relPath: string): void {
    this.store.update((draft) => {
      if (!draft.errors.includes(relPath)) draft.errors.push(relPath);
    });
  }

  clearError(relPath: string): void {
    this.store.update((draft) => {
      draft.errors = draft.errors.filter((e) => e !== relPath);
    });
  }

  touchSynced(): void {
    this.store.update((draft) => {
      draft.lastSyncedAt = new Date().toISOString();
    });
  }

  flush(): Promise<void> {
    return this.store.flush();
  }

  destroy(): Promise<void> {
    return this.store.destroy();
  }
}
