/**
 * Small crash-safe JSON store used for settings, the link registry and per-link
 * sync state.
 *
 * Deliberately not SQLite. The spec suggests `better-sqlite3`, but a native
 * module means the app can only be packaged on the OS it targets and every
 * Electron bump needs a rebuild. The state this app keeps is one record per
 * synced file with a hard ceiling of 20,000 files per link (sync API §5), which
 * a snapshot file handles comfortably. `docs/DESIGN.md` records the trade-off;
 * `SyncStateStore` keeps the shape row-like so swapping in SQLite later is a
 * local change.
 *
 * Durability: write to a sibling temp file, fsync, rename over the target.
 * A crash mid-write leaves the previous snapshot intact.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import logger from './logger';

export class JsonStore<T extends object> {
  private data: T;
  private writeTimer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;

  private constructor(
    private readonly file: string,
    initial: T,
    private readonly debounceMs: number,
  ) {
    this.data = initial;
  }

  static async open<T extends object>(
    file: string,
    fallback: T,
    opts: { debounceMs?: number; migrate?: (raw: unknown) => T | null } = {},
  ): Promise<JsonStore<T>> {
    let value = fallback;
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
      const migrated = opts.migrate ? opts.migrate(raw) : (raw as T);
      if (migrated) value = { ...fallback, ...migrated };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.warn('store: unreadable snapshot, starting fresh', { file: path.basename(file), err });
        // Keep the damaged file for post-mortem rather than silently dropping it.
        await fs.rename(file, `${file}.corrupt`).catch(() => undefined);
      }
    }
    return new JsonStore<T>(file, value, opts.debounceMs ?? 300);
  }

  get(): Readonly<T> {
    return this.data;
  }

  /** Replace the snapshot and schedule a write. */
  set(next: T): void {
    this.data = next;
    this.schedule();
  }

  /** Mutate in place, then schedule a write. */
  update(fn: (draft: T) => void): void {
    fn(this.data);
    this.schedule();
  }

  private schedule(): void {
    this.dirty = true;
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.flush();
    }, this.debounceMs);
    this.writeTimer.unref?.();
  }

  /** Force the snapshot to disk. Awaited on quit. */
  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (!this.dirty) return this.writing;
    this.dirty = false;
    const payload = JSON.stringify(this.data);
    this.writing = this.writing.then(() => atomicWrite(this.file, payload));
    return this.writing;
  }

  async destroy(): Promise<void> {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = null;
    this.dirty = false;
    await this.writing.catch(() => undefined);
    await fs.rm(this.file, { force: true });
  }
}

export async function atomicWrite(file: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
}

export function userDataFile(...parts: string[]): string {
  return path.join(app.getPath('userData'), ...parts);
}
