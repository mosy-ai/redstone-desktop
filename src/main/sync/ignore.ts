/**
 * What never syncs (spec §5.5, sync API §5).
 *
 * Three layers:
 *   1. server-hidden scaffolding — invisible in listings even though it exists,
 *      so it must be invisible to us too, in both directions;
 *   2. always-skipped directories and local junk;
 *   3. the user's own `.redstoneignore` (gitignore syntax) at the link root.
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import ignoreFactory, { type Ignore } from 'ignore';
import {
  ALWAYS_SKIPPED_DIRS,
  IGNORE_FILE,
  LOCAL_SKIP_GLOBS,
  SERVER_HIDDEN_NAMES,
} from '../../shared/constants';
import logger from '../logger';

const globToRegExp = (glob: string): RegExp =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');

const LOCAL_SKIP_RES = LOCAL_SKIP_GLOBS.map(globToRegExp);
const HIDDEN = new Set(SERVER_HIDDEN_NAMES);
const SKIPPED_DIRS = new Set(ALWAYS_SKIPPED_DIRS);

export class IgnoreRules {
  private userRules: Ignore | null = null;

  private constructor(private readonly root: string) {}

  static async load(root: string): Promise<IgnoreRules> {
    const rules = new IgnoreRules(root);
    await rules.reload();
    return rules;
  }

  /** Re-read `.redstoneignore`; called when the watcher sees it change. */
  async reload(): Promise<void> {
    try {
      const text = await fs.readFile(path.join(this.root, IGNORE_FILE), 'utf8');
      this.userRules = ignoreFactory().add(text);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(`could not read ${IGNORE_FILE}`, err);
      }
      this.userRules = null;
    }
  }

  /**
   * `relPath` is POSIX and relative to the link root. Directories should be
   * passed with `isDir` so gitignore's `dir/` rules match.
   */
  shouldSkip(relPath: string, isDir = false): boolean {
    if (!relPath || relPath === '.') return false;
    const segments = relPath.split('/');
    const name = segments[segments.length - 1] ?? '';

    // Server-hidden names live at the folder root only, which is exactly what
    // the server hides. Deeper files with the same name are ordinary content.
    if (segments.length === 1 && HIDDEN.has(name)) return true;

    // …except these, which are noise wherever they appear.
    if (segments.some((s) => SKIPPED_DIRS.has(s))) return true;

    if (LOCAL_SKIP_RES.some((re) => re.test(name))) return true;

    if (this.userRules) {
      const candidate = isDir ? `${relPath}/` : relPath;
      if (this.userRules.ignores(candidate)) return true;
    }
    return false;
  }
}
