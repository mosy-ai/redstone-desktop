/**
 * Local change detection.
 *
 * `awaitWriteFinish` matters more than it looks: editors write a temp file and
 * rename, and without it we would upload half-written files (spec §5.3). The
 * watcher only ever says "something moved" — the cycle decides what actually
 * changed, by hash.
 */
import chokidar, { type FSWatcher } from 'chokidar';
import path from 'node:path';
import { IGNORE_FILE, SYNC } from '../../shared/constants';
import type { IgnoreRules } from './ignore';
import logger from '../logger';

export interface WatcherEvents {
  /** Fired (debounced) when anything under the root changed. */
  onChange: (relPaths: string[]) => void;
  /** Fired when `.redstoneignore` itself changed. */
  onIgnoreFileChanged: () => void;
}

export class LinkWatcher {
  private watcher: FSWatcher | null = null;
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly root: string,
    private readonly rules: IgnoreRules,
    private readonly events: WatcherEvents,
  ) {}

  start(): void {
    if (this.watcher) return;
    this.watcher = chokidar.watch(this.root, {
      ignoreInitial: true,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: SYNC.writeSettleMs, pollInterval: 100 },
      // A watcher error (permissions, deleted root) must not kill the process;
      // the periodic full rescan is the backstop.
      ignorePermissionErrors: true,
      // chokidar calls this once with no stats (before it knows what the entry
      // is) and again with them, so gitignore's `dir/` rules match on the
      // second pass rather than being missed entirely.
      ignored: (target: string, stats?: { isDirectory(): boolean }) => {
        const rel = this.toRel(target);
        if (rel === null || rel === '') return false;
        return this.rules.shouldSkip(rel, stats?.isDirectory() ?? false);
      },
    });

    for (const event of ['add', 'change', 'unlink', 'addDir', 'unlinkDir'] as const) {
      this.watcher.on(event, (target: string) => this.queue(target));
    }
    this.watcher.on('error', (err) => logger.warn('watcher error', err));
  }

  private toRel(target: string): string | null {
    const rel = path.relative(this.root, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join('/');
  }

  private queue(target: string): void {
    const rel = this.toRel(target);
    if (rel === null) return;
    if (rel === IGNORE_FILE) {
      this.events.onIgnoreFileChanged();
      return;
    }
    this.pending.add(rel);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const batch = [...this.pending];
      this.pending.clear();
      this.events.onChange(batch);
    }, SYNC.debounceMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    await this.watcher?.close();
    this.watcher = null;
  }
}
