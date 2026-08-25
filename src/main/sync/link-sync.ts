/**
 * One folder link, kept in sync both ways.
 *
 * The cycle is the one in docs/folder-sync-api.md §4, in that order, because the
 * order is what keeps it correct:
 *
 *   tree(cursor) → classify against our own state → apply → record on success
 *
 * Three rules run through everything here:
 *   - a hash decides what changed, never an mtime (the server's mtimes are its
 *     own write times);
 *   - a partial listing (`truncated`) may never be read as "those files were
 *     deleted";
 *   - a conflict produces two files. Never merge, never overwrite, never
 *     resolve silently.
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { LinkState, LinkStatus } from '../../shared/types';
import { SYNC } from '../../shared/constants';
import type { FolderLink } from '../links';
import { getSettings } from '../settings';
import logger, { relPathHint } from '../logger';
import {
  ApiError,
  SignedOutError,
  deleteEntry,
  downloadFile,
  getTree,
  makeDirectory,
  moveEntry,
  uploadFile,
} from '../api/client';
import { IgnoreRules } from './ignore';
import { hashFile, scanDirectory, type LocalEntry } from './scan';
import { SyncStateStore, type FileRecord, type RemoteRecord } from './state';
import { LinkWatcher } from './watcher';
import { conflictCopyPath, planCycle } from './plan';
import { opPath, opSignature, type Op } from './types';

/** Operations the user would call "syncing" — the ones that move bytes. */
const isTransfer = (op: Op): boolean => op.kind !== 'settle' && op.kind !== 'forget';

export interface LinkSyncDeps {
  /** Serialises cycles so at most two links transfer at once (spec §5.3). */
  acquire: () => Promise<() => void>;
  /** `GET /folders` gate — writing while the mount is down loses data. */
  isMountReady: () => Promise<boolean>;
  onStatus: (status: LinkStatus) => void;
  onConflict: (folderName: string, relPath: string) => void;
  onError: (folderName: string, message: string) => void;
}

export class LinkSync {
  private state!: SyncStateStore;
  private rules!: IgnoreRules;
  private watcher: LinkWatcher | null = null;

  private timer: NodeJS.Timeout | null = null;
  private cycleRunning = false;
  private cycleQueued = false;
  private stopped = false;
  private abort = new AbortController();

  private turnActive = false;
  private lastActivityAt = Date.now();
  private networkFailures = 0;
  /** Per-path retry budget. The signature resets it when the content changes. */
  private attempts = new Map<string, { sig: string; count: number }>();

  private linkState: LinkState = 'paused';
  private message: string | undefined;
  private pending = 0;
  private settleWaiters: Array<(status: LinkStatus) => void> = [];

  constructor(
    private link: FolderLink,
    private readonly deps: LinkSyncDeps,
  ) {}

  get folderId(): string {
    return this.link.folderId;
  }

  get localPath(): string {
    return this.link.localPath;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.abort = new AbortController();
    this.state = await SyncStateStore.open(this.link.folderId, this.link.localPath);
    this.rules = await IgnoreRules.load(this.link.localPath);
    this.watcher = new LinkWatcher(this.link.localPath, this.rules, {
      onChange: () => {
        this.lastActivityAt = Date.now();
        this.schedule(0);
      },
      onIgnoreFileChanged: () => {
        void this.rules.reload().then(() => this.schedule(0));
      },
    });
    if (!this.link.paused) {
      this.watcher.start();
      this.setState('syncing');
      this.schedule(0);
    } else {
      this.setState('paused', 'Paused');
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.watcher?.stop();
    this.watcher = null;
    await this.state?.flush();
  }

  /** Unlink: stop, forget our state. Local files are never touched (spec §5.2). */
  async destroy(): Promise<void> {
    await this.stop();
    await this.state?.destroy();
  }

  async pause(): Promise<void> {
    this.link = { ...this.link, paused: true };
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.watcher?.stop();
    this.setState('paused', 'Paused');
  }

  resume(): void {
    this.link = { ...this.link, paused: false };
    this.watcher?.start();
    this.lastActivityAt = Date.now();
    this.networkFailures = 0;
    this.attempts.clear();
    this.schedule(0);
  }

  /** The web app tells us a turn is streaming, so we poll at 2s (spec §5.3). */
  setTurnActive(active: boolean): void {
    if (this.turnActive === active) return;
    this.turnActive = active;
    this.lastActivityAt = Date.now();
    if (active) this.schedule(0);
  }

  syncNow(): void {
    this.lastActivityAt = Date.now();
    this.networkFailures = 0;
    this.schedule(0);
  }

  status(): LinkStatus {
    return {
      folderId: this.link.folderId,
      folderName: this.link.folderName,
      localPath: this.link.localPath,
      state: this.linkState,
      pending: this.pending,
      conflicts: this.state?.conflicts ?? [],
      errors: this.state?.errors ?? [],
      pausedByUser: this.link.paused,
      lastSyncedAt: this.state?.lastSyncedAt ?? null,
      message: this.message,
    };
  }

  // --- scheduling ------------------------------------------------------------

  private schedule(delayMs: number): void {
    if (this.stopped || this.link.paused) return;
    if (this.cycleRunning) {
      this.cycleQueued = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runCycle();
    }, delayMs);
    this.timer.unref?.();
  }

  private nextInterval(): number {
    if (this.networkFailures > 0) {
      return Math.min(SYNC.backoffBaseMs * 2 ** (this.networkFailures - 1), SYNC.backoffMaxMs);
    }
    if (this.turnActive) return SYNC.pollActiveMs;
    if (Date.now() - this.lastActivityAt > SYNC.idleAfterMs) return SYNC.pollIdleMs;
    return SYNC.pollNormalMs;
  }

  private setState(next: LinkState, message?: string): void {
    if (this.linkState === next && this.message === message) return;
    this.linkState = next;
    this.message = message;
    const status = this.status();
    this.deps.onStatus(status);
    if (next !== 'syncing') {
      const waiters = this.settleWaiters.splice(0);
      for (const resolve of waiters) resolve(status);
    }
  }

  /**
   * Resolves when the link stops being mid-cycle. Used by the link flow so a new
   * chat opens on a folder that already has the user's files in it, rather than
   * on an empty directory (sync API §6).
   */
  whenSettled(timeoutMs = 90_000): Promise<LinkStatus> {
    if (this.linkState !== 'syncing') return Promise.resolve(this.status());
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.settleWaiters = this.settleWaiters.filter((w) => w !== onSettled);
        resolve(this.status());
      }, timeoutMs);
      timer.unref?.();
      const onSettled = (status: LinkStatus): void => {
        clearTimeout(timer);
        resolve(status);
      };
      this.settleWaiters.push(onSettled);
    });
  }

  // --- the cycle -------------------------------------------------------------

  private async runCycle(): Promise<void> {
    if (this.stopped || this.link.paused || this.cycleRunning) return;
    this.cycleRunning = true;
    const release = await this.deps.acquire();
    try {
      await this.cycle();
      this.networkFailures = 0;
    } catch (err) {
      this.handleCycleError(err);
    } finally {
      release();
      this.cycleRunning = false;
      const again = this.cycleQueued;
      this.cycleQueued = false;
      if (!this.stopped) this.schedule(again ? 0 : this.nextInterval());
    }
  }

  private handleCycleError(err: unknown): void {
    if (err instanceof SignedOutError || (err instanceof ApiError && err.isAuth)) {
      this.setState('signed_out', 'Sign in again');
      return;
    }
    if (err instanceof ApiError && err.isMissing) {
      // 404 on the folder means it is gone or no longer ours: stop syncing it.
      this.setState('error', 'This Redstone folder no longer exists');
      void this.pause();
      this.deps.onError(this.link.folderName, 'The Redstone folder no longer exists. Sync stopped.');
      return;
    }
    this.networkFailures++;
    const retryable = !(err instanceof ApiError) || err.isRetryable;
    logger.warn(`sync cycle failed (${this.networkFailures})`, err);
    this.setState(
      this.state?.conflicts.length ? 'conflict' : 'error',
      retryable ? 'Reconnecting…' : `Sync error: ${(err as Error).message}`,
    );
    if (this.networkFailures === 5) {
      this.deps.onError(this.link.folderName, 'Sync keeps failing. Redstone will keep retrying.');
    }
  }

  private async cycle(): Promise<void> {
    if (!(await this.deps.isMountReady())) {
      // Not the user's doing and not fixable from here: the server says object
      // storage is not attached, and uploading into that loses the bytes.
      this.setState('paused', 'Redstone storage is unavailable — retrying');
      return;
    }
    this.setState('syncing');

    // 1 & 2 — remote listing.
    const tree = await getTree(this.link.folderId, this.state.cursor, { signal: this.abort.signal });
    if (!tree.unchanged) {
      if (tree.entries.filter((e) => !e.isDir).length > SYNC.refuseFileCount) {
        this.setState('error', 'This folder is too large to mirror (over 20,000 files)');
        return;
      }
      this.state.setRemote(tree.entries, tree.cursor, tree.truncated);
    }
    const truncated = tree.unchanged ? this.state.truncated : tree.truncated;
    if (truncated) {
      this.setState('syncing', 'Folder is too large to mirror fully — deletions are not applied');
    }

    // 4 — local listing, hashing only what moved.
    const scan = await scanDirectory(this.link.localPath, this.rules, {
      maxFileBytes: getSettings().maxSyncFileBytes,
      signal: this.abort.signal,
    });

    /**
     * Paths this cycle must not reason about at all. A file we could not read —
     * because it is over the size cap, locked by another process, or vanished
     * mid-walk — is *absent* from the local listing, and an absent file with a
     * record reads as a deletion. Propagating that would delete the server's
     * copy of a file the user still has. Dropping the path from every input
     * instead makes the cycle a no-op for it.
     */
    const untouchable = new Set<string>(scan.oversized);

    const localFiles = new Map<string, LocalEntry>();
    for (const [rel, entry] of scan.files) {
      const record = this.state.file(rel);
      const unmoved =
        record && record.localSize === entry.size && record.localMtimeMs === entry.mtimeMs;
      const hash = unmoved
        ? record.localHash
        : await hashFile(path.join(this.link.localPath, rel), this.abort.signal).catch(() => null);
      if (!hash) {
        untouchable.add(rel);
        continue;
      }
      localFiles.set(rel, { ...entry, hash });
    }

    const remoteFiles = new Map<string, RemoteRecord>();
    const remoteDirs = new Set<string>();
    for (const entry of this.state.remoteEntries()) {
      if (untouchable.has(entry.path)) continue;
      if (this.rules.shouldSkip(entry.path, entry.isDir)) continue;
      if (entry.isDir) remoteDirs.add(entry.path);
      else remoteFiles.set(entry.path, entry);
    }

    const records = new Map(
      this.state.files().filter((r) => !untouchable.has(r.relPath)).map((r) => [r.relPath, r]),
    );

    // 5 — classify, then 6 — apply.
    const ops = planCycle({
      records,
      localFiles,
      localDirs: scan.dirs,
      remoteFiles,
      remoteDirs,
      truncated,
      isParked: (op) => this.isParked(op),
    });
    // `settle` and `forget` only touch our own bookkeeping — counting them would
    // show the user files "to sync" that involve no transfer at all.
    this.pending = ops.filter(isTransfer).length;
    if (this.pending > 0) {
      this.lastActivityAt = Date.now();
      this.setState('syncing', `${this.pending} file${this.pending === 1 ? '' : 's'} to sync`);
    }
    await this.apply(ops);
    await this.state.flush();

    this.state.touchSynced();
    this.pending = 0;
    if (this.state.conflicts.length) {
      this.setState('conflict', `${this.state.conflicts.length} conflict(s) — both copies kept`);
    } else if (this.state.errors.length) {
      this.setState('error', `${this.state.errors.length} file(s) could not sync`);
    } else if (scan.oversized.length) {
      this.setState('synced', `${scan.oversized.length} file(s) skipped: over the size limit`);
    } else {
      this.setState('synced', undefined);
    }
  }

  // --- application -----------------------------------------------------------

  private async apply(ops: Op[]): Promise<void> {
    for (const op of ops) {
      if (this.stopped || this.abort.signal.aborted) return;
      const relPath = opPath(op);
      try {
        await this.applyOne(op);
        this.attempts.delete(relPath);
        this.state.clearError(relPath);
        if (isTransfer(op)) this.pending = Math.max(0, this.pending - 1);
      } catch (err) {
        if (err instanceof SignedOutError || (err instanceof ApiError && err.isAuth)) throw err;
        const sig = opSignature(op);
        const prior = this.attempts.get(relPath);
        const count = prior && prior.sig === sig ? prior.count + 1 : 1;
        this.attempts.set(relPath, { sig, count });
        logger.warn(`sync op ${op.kind} failed (${count})`, { file: relPathHint(relPath), err });
        if (count >= SYNC.maxFileAttempts) {
          // Parked, not retried forever, and it does not block the queue.
          this.state.markError(relPath);
          this.deps.onError(
            this.link.folderName,
            `Could not sync "${path.basename(relPath)}" after ${count} attempts.`,
          );
        }
        if (err instanceof ApiError && err.status === 0) throw err; // offline: end the cycle
      }
    }
  }


  /**
   * An operation that already burned its retry budget is dropped from the plan
   * — but only while the work is identical. Edit the file (or let the agent edit
   * it) and the signature changes, which is the retry.
   */
  private isParked(op: Op): boolean {
    const entry = this.attempts.get(opPath(op));
    return !!entry && entry.count >= SYNC.maxFileAttempts && entry.sig === opSignature(op);
  }

  private abs(relPath: string): string {
    return path.join(this.link.localPath, relPath.split('/').join(path.sep));
  }

  private async applyOne(op: Op): Promise<void> {
    switch (op.kind) {
      case 'mkdir-local':
        await fs.mkdir(this.abs(op.relPath), { recursive: true });
        return;

      case 'mkdir-remote': {
        const parent = op.relPath.includes('/') ? op.relPath.slice(0, op.relPath.lastIndexOf('/')) : '';
        const name = op.relPath.slice(op.relPath.lastIndexOf('/') + 1);
        await makeDirectory(this.link.folderId, parent, name);
        this.state.patchRemote({ path: op.relPath, isDir: true, size: null, modified: null, hash: null });
        this.state.invalidateCursor();
        return;
      }

      case 'move-remote': {
        const ok = await moveEntry(this.link.folderId, op.from, op.to);
        if (!ok) {
          // Destination taken or source gone — fall back to a plain upload and
          // let the next cycle sort the old path out.
          await this.applyOne({ kind: 'upload', relPath: op.to, local: op.local });
          return;
        }
        const record = this.state.file(op.from);
        this.state.renameFile(op.from, op.to);
        this.state.dropRemote(op.from);
        if (record) {
          this.state.patchRemote({
            path: op.to,
            isDir: false,
            size: record.remoteSize,
            modified: record.remoteMtime,
            hash: record.remoteHash,
          });
          this.state.putFile({
            ...record,
            relPath: op.to,
            localMtimeMs: op.local.mtimeMs,
            localSize: op.local.size,
            state: 'synced',
          });
        }
        this.state.invalidateCursor();
        return;
      }

      case 'move-local': {
        const from = this.abs(op.from);
        const to = this.abs(op.to);
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.rename(from, to);
        const stat = await fs.stat(to);
        const record = this.state.file(op.from);
        this.state.renameFile(op.from, op.to);
        if (record) {
          this.state.putFile({
            ...record,
            relPath: op.to,
            localMtimeMs: Math.round(stat.mtimeMs),
            localSize: stat.size,
            remoteHash: op.remote.hash ?? record.remoteHash,
            remoteSize: op.remote.size ?? record.remoteSize,
            remoteMtime: op.remote.modified,
            state: 'synced',
          });
        }
        return;
      }

      case 'download': {
        await this.downloadTo(op.relPath, op.relPath, op.remote);
        return;
      }

      case 'conflict': {
        // Keep both. The remote copy lands beside the user's file; the user's
        // file keeps the canonical path and is uploaded as-is.
        const copyPath = conflictCopyPath(op.relPath, new Date());
        await this.downloadTo(op.relPath, copyPath, op.remote, { recordState: false });
        await this.uploadOne(op.relPath, op.local);
        this.state.markConflict(op.relPath);
        this.deps.onConflict(this.link.folderName, op.relPath);
        logger.info('conflict resolved by keeping both copies', { file: relPathHint(op.relPath) });
        return;
      }

      case 'upload': {
        await this.uploadOne(op.relPath, op.local);
        return;
      }

      case 'delete-local': {
        await fs.rm(this.abs(op.relPath), { force: true });
        this.state.dropFile(op.relPath);
        this.state.clearConflict(op.relPath);
        return;
      }

      case 'delete-remote': {
        const result = await deleteEntry(this.link.folderId, op.relPath);
        if (result === 'not-empty') return; // a directory grew under us; next cycle
        this.state.dropFile(op.relPath);
        this.state.dropRemote(op.relPath);
        this.state.clearConflict(op.relPath);
        this.state.invalidateCursor();
        return;
      }

      case 'settle': {
        // Both sides already hold the same bytes — just record it.
        this.state.putFile({
          relPath: op.relPath,
          localHash: op.local.hash ?? '',
          localMtimeMs: op.local.mtimeMs,
          localSize: op.local.size,
          remoteHash: op.remote.hash ?? '',
          remoteSize: op.remote.size ?? op.local.size,
          remoteMtime: op.remote.modified,
          state: 'synced',
        });
        this.state.clearConflict(op.relPath);
        return;
      }

      case 'forget': {
        this.state.dropFile(op.relPath);
        this.state.clearConflict(op.relPath);
        return;
      }
    }
  }

  private async downloadTo(
    remoteRelPath: string,
    localRelPath: string,
    remote: RemoteRecord,
    opts: { recordState?: boolean } = {},
  ): Promise<void> {
    const dest = this.abs(localRelPath);
    const tmp = path.join(path.dirname(dest), `.redstone-tmp-${randomBytes(6).toString('hex')}`);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    try {
      await downloadFile(this.link.folderId, remoteRelPath, tmp, this.abort.signal);
      // Verify before it becomes the user's file: a truncated download that
      // silently replaced good content would be exactly the data loss the
      // conflict rule exists to prevent.
      if (remote.hash) {
        const got = await hashFile(tmp, this.abort.signal);
        if (got !== remote.hash) throw new Error('downloaded bytes did not match the server hash');
      }
      await fs.rename(tmp, dest);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }

    if (opts.recordState === false) return;
    const stat = await fs.stat(dest);
    this.state.putFile({
      relPath: localRelPath,
      localHash: remote.hash ?? '',
      localMtimeMs: Math.round(stat.mtimeMs),
      localSize: stat.size,
      remoteHash: remote.hash ?? '',
      remoteSize: remote.size ?? stat.size,
      remoteMtime: remote.modified,
      state: 'synced',
    });
    this.state.clearConflict(localRelPath);
  }

  private async uploadOne(relPath: string, local: LocalEntry): Promise<void> {
    const abs = this.abs(relPath);
    const contents = await fs.readFile(abs);
    // Hash what we actually sent, not what we saw during the scan: if the file
    // changed between the two, the next cycle re-uploads rather than recording a
    // hash that never existed on the wire.
    const sentHash = await hashFile(abs, this.abort.signal).catch(() => local.hash ?? '');
    const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
    const name = relPath.slice(relPath.lastIndexOf('/') + 1);
    const written = await uploadFile(this.link.folderId, dir, name, contents, this.abort.signal);

    const stat = await fs.stat(abs).catch(() => null);
    const record: FileRecord = {
      relPath,
      localHash: sentHash,
      localMtimeMs: stat ? Math.round(stat.mtimeMs) : local.mtimeMs,
      localSize: stat?.size ?? contents.byteLength,
      remoteHash: sentHash,
      remoteSize: written.size ?? contents.byteLength,
      remoteMtime: written.modified,
      state: 'synced',
    };
    this.state.putFile(record);
    this.state.patchRemote({
      path: relPath,
      isDir: false,
      size: record.remoteSize,
      modified: record.remoteMtime,
      hash: sentHash,
    });
    this.state.clearConflict(relPath);
    // Our own write changes the server's tree signature.
    this.state.invalidateCursor();
  }
}

export { conflictCopyPath } from './plan';
