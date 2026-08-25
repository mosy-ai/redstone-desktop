/** Deployment constants. Everything user-tunable lives in Settings instead. */

/**
 * Offered as a suggestion on the server screen, never assumed. Redstone is
 * self-hostable and regional, so the instance is the user's to name.
 */
export const EXAMPLE_ORIGIN = 'https://redstone-agent.yitec.dev';

/** One partition for every window, so the web app's login is shared. Spec §3. */
export const SESSION_PARTITION = 'persist:redstone';

/** Cookie the web app writes the access token into. Spec §4. */
export const TOKEN_COOKIE = 'rs_token';

export const ROUTES = {
  chat: '/chat',
  login: '/login',
  settings: '/settings',
  quick: '/quick',
} as const;

/** Spec §5.5 / sync API §5 — server-side scaffolding, hidden from listings.
 *  Never upload these, never read their absence as a remote deletion. */
export const SERVER_HIDDEN_NAMES: readonly string[] = [
  'session.json',
  'workspace_context.json',
  '.env',
  '.gitignore',
  '.git',
  '__pycache__',
  'node_modules',
  '.venv',
  '.claude',
  'skills',
  'data-workspace',
  '.memory',
  'MEMORY.md',
  '.skills-account',
  '.skills-baseline.json',
];

/** Directories that are never worth mirroring, at any depth. */
export const ALWAYS_SKIPPED_DIRS: readonly string[] = [
  '.git',
  'node_modules',
  '__pycache__',
  '.venv',
  '.mypy_cache',
  '.pytest_cache',
  '.next',
  '.turbo',
];

/** Local-only junk (spec §5.5). */
export const LOCAL_SKIP_GLOBS: readonly string[] = [
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '~$*',
  '*.tmp',
  '*.crdownload',
  '*.part',
  '*.swp',
  '.redstone-tmp-*',
];

export const IGNORE_FILE = '.redstoneignore';

export const SYNC = {
  /** Poll cadences, ms. Spec §5.3. */
  pollActiveMs: 2_000,
  pollNormalMs: 10_000,
  pollIdleMs: 60_000,
  /** Idle kicks in after this long with no activity on either side. */
  idleAfterMs: 5 * 60_000,
  /** Watchers miss events after sleep — full rescan on this cadence. */
  fullRescanMs: 15 * 60_000,
  /** chokidar awaitWriteFinish + per-path debounce. */
  writeSettleMs: 1_500,
  debounceMs: 1_500,
  /** Cycles in flight across all links. Spec §5.3: never saturate the uplink. */
  maxParallelLinks: 2,
  /** A file that fails this many times is parked in the error list. */
  maxFileAttempts: 5,
  /** Network backoff, ms. */
  backoffBaseMs: 5_000,
  backoffMaxMs: 5 * 60_000,
  /** Soft warn / hard refuse thresholds. Spec §5.5, sync API §5. */
  warnFileCount: 5_000,
  refuseFileCount: 20_000,
  /** Files above this are skipped entirely. */
  maxFileBytes: 100 * 1024 * 1024,
} as const;

export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Fallback limits until `GET /files/upload-constraints` answers. Spec §6. */
export const DEFAULT_UPLOAD_CONSTRAINTS = {
  maxFileBytes: 100 * 1024 * 1024,
  maxFilesPerBatch: 20,
} as const;

export const QUICK_BAR = {
  width: 720,
  collapsedHeight: 72,
  expandedHeight: 420,
  /** Fraction of the work area height the bar sits at. */
  topFraction: 1 / 3,
} as const;
