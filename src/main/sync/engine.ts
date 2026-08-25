/**
 * Owns every `LinkSync`, the two-at-a-time transfer budget, the `mount_ready`
 * gate and the status fan-out to windows.
 */
import { EventEmitter } from 'node:events';
import type { LinkStatus } from '../../shared/types';
import { SYNC } from '../../shared/constants';
import { basename } from 'node:path';
import {
  addLink,
  getLink,
  linksForServer,
  removeLink,
  setLinkName,
  setPaused,
  type FolderLink,
} from '../links';
import { ApiError, listFolders } from '../api/client';
import { authEvents } from '../auth';
import { activeServer } from '../servers';
import logger from '../logger';
import { LinkSync } from './link-sync';

class Semaphore {
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiting.shift()?.();
    };
  }
}

export interface SyncEngineEvents {
  status: (status: LinkStatus) => void;
  conflict: (folderName: string, relPath: string) => void;
  error: (folderName: string, message: string) => void;
}

export class SyncEngine extends EventEmitter {
  private links = new Map<string, LinkSync>();
  private transfers = new Semaphore(SYNC.maxParallelLinks);
  private mountCheck: { at: number; ready: boolean } | null = null;

  /**
   * Links made before the shell knew how to ask for a folder's name were saved
   * with the id as their label, which then showed up in the window chrome. Fix
   * them once, on the way in.
   */
  private async repairNames(links: FolderLink[]): Promise<void> {
    const broken = links.filter((l) => l.folderName === l.folderId || !l.folderName);
    if (!broken.length) return;
    const named = await listFolders()
      .then(({ items }) => new Map(items.map((f) => [f.id, f.name])))
      // An unreachable server is not a reason to keep showing a UUID: the
      // directory the user picked is a perfectly good label.
      .catch(() => new Map<string, string>());
    for (const link of broken) {
      const name = named.get(link.folderId) ?? basename(link.localPath);
      link.folderName = name;
      await setLinkName(link.folderId, name);
    }
  }

  async start(): Promise<void> {
    // Only this server's links. A folder id from another instance would 404 at
    // best and mirror the wrong tree at worst.
    const links = linksForServer(activeServer());
    for (const link of links) {
      await this.spawn(link);
    }
    // Deliberately not awaited: it is a cosmetic label fix behind a network
    // call, and when the server is unwell that call hangs — which would hold up
    // starting sync, and with it the whole app.
    void this.repairNames(links).catch((err) => logger.warn('could not repair link names', err));
    // A fresh sign-in should not wait out a backoff.
    authEvents.on('signed-in', () => this.syncAll());
    logger.info(`sync engine started with ${this.links.size} link(s)`);
  }

  async stop(): Promise<void> {
    await Promise.all([...this.links.values()].map((l) => l.stop()));
    this.links.clear();
  }

  statuses(): LinkStatus[] {
    return [...this.links.values()].map((l) => l.status());
  }

  status(folderId: string): LinkStatus | undefined {
    return this.links.get(folderId)?.status();
  }

  has(folderId: string): boolean {
    return this.links.has(folderId);
  }

  /** Link a folder that a native dialog approved, and start syncing it. */
  async link(
    folderId: string,
    folderName: string,
    localPath: string,
    sessionId?: string,
  ): Promise<LinkStatus> {
    const serverOrigin = activeServer();
    if (!serverOrigin) throw new Error('no Redstone server is configured');
    const record = await addLink({ folderId, folderName, localPath, serverOrigin, sessionId });
    const existing = this.links.get(folderId);
    if (existing) await existing.stop();
    const sync = await this.spawn(record);
    return sync.status();
  }

  /** Wait for a link's first cycle to finish (or give up after `timeoutMs`). */
  async waitForSync(folderId: string, timeoutMs?: number): Promise<LinkStatus | undefined> {
    return this.links.get(folderId)?.whenSettled(timeoutMs);
  }

  /** Stop syncing. Local files are never deleted (spec §5.2). */
  async unlink(folderId: string): Promise<void> {
    const folderName = getLink(folderId)?.folderName ?? '';
    const sync = this.links.get(folderId);
    if (sync) {
      await sync.destroy();
      this.links.delete(folderId);
    }
    await removeLink(folderId);
    this.emit('status', {
      folderId,
      folderName,
      localPath: '',
      state: 'paused',
      pending: 0,
      conflicts: [],
      errors: [],
      pausedByUser: false,
      lastSyncedAt: null,
      message: 'Unlinked',
    } satisfies LinkStatus);
  }

  async pause(folderId: string): Promise<void> {
    await setPaused(folderId, true);
    await this.links.get(folderId)?.pause();
  }

  async resume(folderId: string): Promise<void> {
    await setPaused(folderId, false);
    this.links.get(folderId)?.resume();
  }

  syncNow(folderId?: string): void {
    // The mount answer is cached for 30s; a user pressing "Sync now" during an
    // outage deserves a fresh question rather than a cached no.
    this.mountCheck = null;
    if (folderId) this.links.get(folderId)?.syncNow();
    else this.syncAll();
  }

  /** Is the server currently refusing writes? Drives the UI's wording. */
  async storageAvailable(): Promise<boolean> {
    this.mountCheck = null;
    return this.isMountReady().catch(() => false);
  }

  syncAll(): void {
    for (const link of this.links.values()) link.syncNow();
  }

  /** Spec §8: the web app tells us a turn is streaming so we poll at 2s. */
  setTurnActive(folderId: string | null, active: boolean): void {
    if (folderId) {
      this.links.get(folderId)?.setTurnActive(active);
      return;
    }
    // Without a folder hint, treat it as activity everywhere — cheap, and the
    // common case is a single link.
    for (const link of this.links.values()) link.setTurnActive(active);
  }

  private async spawn(link: FolderLink): Promise<LinkSync> {
    const sync = new LinkSync(link, {
      acquire: () => this.transfers.acquire(),
      isMountReady: () => this.isMountReady(),
      onStatus: (status) => this.emit('status', status),
      onConflict: (folderName, relPath) => this.emit('conflict', folderName, relPath),
      onError: (folderName, message) => this.emit('error', folderName, message),
    });
    this.links.set(link.folderId, sync);
    await sync.start();
    return sync;
  }

  /**
   * `mount_ready: false` means object storage is not attached and writes would
   * land on ephemeral disk. Cached briefly so every link does not re-ask.
   */
  private async isMountReady(): Promise<boolean> {
    if (this.mountCheck && Date.now() - this.mountCheck.at < 30_000) return this.mountCheck.ready;
    try {
      const { mountReady } = await listFolders();
      this.mountCheck = { at: Date.now(), ready: mountReady };
      if (!mountReady) logger.warn('folder storage is not mounted — sync paused');
      return mountReady;
    } catch (err) {
      if (err instanceof ApiError && err.isAuth) throw err;
      // Can't tell: assume ready and let the individual calls fail loudly rather
      // than silently freezing sync on a blip.
      logger.warn('mount check failed', err);
      return true;
    }
  }
}

export const syncEngine = new SyncEngine();
