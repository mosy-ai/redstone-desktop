/**
 * The vocabulary shared by the main process, the preload bridge and the shell's
 * own renderer pages. Keep it free of imports so every surface can use it.
 *
 * The public shape of `window.redstone` is spec §8; anything added since is
 * additive and feature-detectable (see `BRIDGE_VERSION`).
 */

export const BRIDGE_VERSION = '1';

export type LinkState =
  | 'synced'
  | 'syncing'
  | 'paused'
  | 'error'
  | 'conflict'
  | 'signed_out';

/** What the web app and the status window render. Spec §8. */
export interface LinkStatus {
  folderId: string;
  folderName: string;
  localPath: string;
  state: LinkState;
  pending: number;
  conflicts: string[];
  /** Relative paths that failed repeatedly and were parked (spec §5.3). */
  errors: string[];
  /**
   * True only when the *user* paused this link. A link stopped by something
   * server-side — storage unmounted, signed out — is not resumable by a button,
   * and offering one is worse than saying what is actually wrong.
   */
  pausedByUser: boolean;
  lastSyncedAt: string | null;
  message?: string;
}

export interface AttachmentRef {
  attachmentId: string;
  filename: string;
  sizeBytes: number;
}

export interface UploadConstraints {
  maxFileBytes: number;
  maxFilesPerBatch: number;
}

/** A Redstone folder as returned by `GET /folders`. */
export interface RemoteFolder {
  id: string;
  name: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface FolderListing {
  mountReady: boolean;
  items: RemoteFolder[];
}

export interface LinkFolderOptions {
  folderId: string;
  localPath: string;
}

export interface PickFilesOptions {
  multiple?: boolean;
  /** Target conversation. Falls back to the last session the web app reported. */
  sessionId?: string;
}

export interface CaptureOptions {
  sessionId?: string;
}

export interface OpenMainWindowOptions {
  sessionId?: string;
}

export interface TurnActivity {
  sessionId: string;
  active: boolean;
}

export interface ShellInfo {
  version: string;
  platform: NodeJS.Platform;
  appOrigin: string;
  /** Shortcut accelerators currently registered (or null if registration failed). */
  shortcuts: { quickBar: string | null; capture: string | null; summon: string | null };
}

/** A Redstone instance the user has connected to before. */
export interface KnownServer {
  origin: string;
  name: string;
  lastUsedAt: string;
}

export interface ProbeResult {
  ok: boolean;
  origin?: string;
  name?: string;
  reason?: 'invalid' | 'unreachable' | 'tls' | 'not-redstone' | 'server-error';
  message?: string;
}

/** The folder state of one conversation, as the chat's control renders it. */
export interface SessionFolderState {
  sessionId: string | null;
  /**
   * True on the chat screen even before a conversation exists. A brand-new chat
   * still needs a way to link a local folder — the folder brings the
   * conversation with it — but nothing folder-shaped belongs on /missions.
   */
  onChatRoute: boolean;
  folderId: string | null;
  folderName: string | null;
  link: LinkStatus | null;
  /** True once the web app renders its own folder control; the shell hides its. */
  webAppRendersFolderControl: boolean;
}

export interface ServerState {
  activeOrigin: string | null;
  servers: KnownServer[];
  version: string;
}

export interface Settings {
  /** The active Redstone instance. Empty until the user picks one. */
  appOrigin: string;
  shortcuts: { quickBar: string; capture: string; summon: string };
  /** Quick bar starts a fresh conversation unless the user pins continuation. */
  quickBarContinuesLastSession: boolean;
  autoUpdate: boolean;
  launchAtLogin: boolean;
  /** Extra origins the renderer may talk to (storage host, CDN). */
  allowedOrigins: string[];
  /** Files larger than this are never synced (bytes). */
  maxSyncFileBytes: number;
  /**
   * The input the user picked in desktop settings, as a
   * `MediaDeviceInfo.deviceId`. The shell cannot force Chromium to use it — the
   * page owns the recording — so it is offered to the web app through the
   * bridge. Empty means "whatever the system default is".
   */
  preferredMicrophoneId: string;

  /**
   * Pause the web app's decorative background animations.
   *
   * Measured on an M1 Pro: four blurred blobs animating `scale` behind the chat
   * hold the GPU process at 45% of a core continuously — the browser has to
   * re-rasterise a 90-110px blur every frame — and keep doing it while the
   * window is hidden, because the notification event stream needs
   * `backgroundThrottling: false`. Only infinite animations on blurred elements
   * are paused, so spinners and progress indicators still move.
   */
  reduceBackgroundAnimation: boolean;
}

export type ConnectionState =
  /** The server answered. */
  | 'online'
  /** This machine has no network at all — Wi-Fi off, cable out, flight mode. */
  | 'no-internet'
  /** The network is up but the instance did not answer, or answered wrong. */
  | 'server-unreachable'
  /** A probe is in flight and there is no previous answer to show. */
  | 'checking'
  /** Reachable, but the page keeps reloading itself. See `reportReloadStorm`. */
  | 'unstable';

export interface ConnectionReport {
  state: ConnectionState;
  /** One sentence, already phrased for a person. */
  message: string;
  /** The instance being talked to, host only — never a full URL with a token. */
  host: string;
  /** Consecutive failed probes. 0 whenever the state is `online`. */
  attempts: number;
  /** When the current state began, ms since epoch. */
  since: number;
}

/** IPC channel names. Renderer→main are `invoke`; main→renderer are `send`. */
export const IPC = {
  // bridge (remote web app + local pages)
  shellInfo: 'redstone:shell-info',
  pickFolder: 'redstone:pick-folder',
  linkFolder: 'redstone:link-folder',
  unlinkFolder: 'redstone:unlink-folder',
  listLinks: 'redstone:list-links',
  pauseLink: 'redstone:pause-link',
  resumeLink: 'redstone:resume-link',
  syncNow: 'redstone:sync-now',
  revealInFileManager: 'redstone:reveal',
  pickFiles: 'redstone:pick-files',
  uploadDroppedPaths: 'redstone:upload-dropped',
  captureScreen: 'redstone:capture-screen',
  openQuickBar: 'redstone:open-quick-bar',
  closeQuickBar: 'redstone:close-quick-bar',
  openMainWindow: 'redstone:open-main-window',
  setTurnActive: 'redstone:set-turn-active',
  setActiveSession: 'redstone:set-active-session',
  openFolderFlow: 'redstone:open-folder-flow',
  getSettings: 'redstone:get-settings',
  setSettings: 'redstone:set-settings',

  // server picker (first run, and "Switch Server…")
  serverState: 'redstone:server-state',
  probeServer: 'redstone:probe-server',
  useServer: 'redstone:use-server',
  forgetServer: 'redstone:forget-server',
  closeServerPicker: 'redstone:close-server-picker',

  // notifications (docs/desktop-notifications §3, §4)
  focusWindow: 'redstone:focus-window',
  setBadgeCount: 'redstone:set-badge-count',

  // preferences
  microphoneStatus: 'redstone:microphone-status',
  requestMicrophone: 'redstone:request-microphone',
  openSoundSettings: 'redstone:open-sound-settings',
  openPreferences: 'redstone:open-preferences',
  setShortcut: 'redstone:set-shortcut',
  serverPickerOpen: 'redstone:open-server-picker',
  openAccountSettings: 'redstone:open-account-settings',

  // desktop chrome bar
  reloadApp: 'redstone:reload-app',
  openStatusWindow: 'redstone:open-status-window',

  /** main → the web app's page: whether to pause decorative animations. */
  reduceMotion: 'redstone:reduce-motion',

  // connection health — the offline screen and the chrome bar's banner
  connectionState: 'redstone:connection-state',
  connectionCheck: 'redstone:connection-check',
  connectionChanged: 'redstone:connection-changed',
  /** Renderer→main hint: this page's `navigator.onLine` flipped. */
  networkReport: 'redstone:network-report',

  // per-conversation folder link
  sessionFolder: 'redstone:session-folder',
  linkSessionFolder: 'redstone:link-session-folder',
  unlinkSessionFolder: 'redstone:unlink-session-folder',
  sessionChanged: 'redstone:session-changed',

  // main → renderer
  syncStatus: 'redstone:sync-status',
  filesDropped: 'redstone:files-dropped',

  // quick bar — the window; its contents are the web app's /quick route
  quickResize: 'redstone:quick-resize',
  quickHide: 'redstone:quick-hide',

  // capture source picker
  captureSources: 'redstone:capture-sources',
  captureChoose: 'redstone:capture-choose',
  captureCancel: 'redstone:capture-cancel',
  captureConfirm: 'redstone:capture-confirm',
  capturePreview: 'redstone:capture-preview',
} as const;

/** Frames the local quick-bar fallback renders while a turn streams. */
