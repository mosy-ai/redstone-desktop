/**
 * The bridge (spec §8). This file is the *entire* surface the web app can reach.
 *
 * It runs sandboxed: no Node, no `fs`, nothing but `ipcRenderer` and
 * `webUtils`. Everything it exposes is a named operation the main process
 * validates — there is deliberately no generic file access to hang a feature on.
 *
 * It also renders the drag-and-drop target, because the page it decorates is the
 * web app and the shell should not need the web app's cooperation to accept a
 * dropped file (spec §6).
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  BRIDGE_VERSION,
  IPC,
  type AttachmentRef,
  type LinkStatus,
  type OpenMainWindowOptions,
  type PickFilesOptions,
  type CaptureOptions,
  type ConnectionReport,
  type LinkFolderOptions,
  type ProbeResult,
  type ServerState,
  type Settings,
  type SessionFolderState,
  type ShellInfo,
  type TurnActivity,
} from '../shared/types';

type Unsubscribe = () => void;

function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_event: unknown, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const bridge = {
  version: BRIDGE_VERSION,
  platform: process.platform,

  /** Shell version and registered shortcuts, so the web app can gate features. */
  info: (): Promise<ShellInfo> => ipcRenderer.invoke(IPC.shellInfo),

  // --- folders ---------------------------------------------------------------
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke(IPC.pickFolder),
  linkFolder: (options: LinkFolderOptions): Promise<LinkStatus> =>
    ipcRenderer.invoke(IPC.linkFolder, options),
  unlinkFolder: (folderId: string): Promise<void> => ipcRenderer.invoke(IPC.unlinkFolder, folderId),
  listLinks: (): Promise<LinkStatus[]> => ipcRenderer.invoke(IPC.listLinks),
  pauseLink: (folderId: string): Promise<void> => ipcRenderer.invoke(IPC.pauseLink, folderId),
  resumeLink: (folderId: string): Promise<void> => ipcRenderer.invoke(IPC.resumeLink, folderId),
  syncNow: (folderId?: string): Promise<void> => ipcRenderer.invoke(IPC.syncNow, folderId),
  revealInFileManager: (options: { folderId: string; relPath?: string }): Promise<void> =>
    ipcRenderer.invoke(IPC.revealInFileManager, options),
  /** Pick + create/attach + first sync + bound chat, in one call. */
  openFolder: (): Promise<LinkStatus | null> => ipcRenderer.invoke(IPC.openFolderFlow),

  // --- per-conversation folder link -------------------------------------------
  // What a "link folder" button in the chat header should call. Omit sessionId
  // and the shell uses the conversation it believes is open.
  sessionFolder: (sessionId?: string): Promise<SessionFolderState> =>
    ipcRenderer.invoke(IPC.sessionFolder, sessionId),
  linkSessionFolder: (sessionId?: string): Promise<LinkStatus | null> =>
    ipcRenderer.invoke(IPC.linkSessionFolder, sessionId),
  unlinkSessionFolder: (sessionId?: string): Promise<void> =>
    ipcRenderer.invoke(IPC.unlinkSessionFolder, sessionId),
  onSessionChanged: (cb: (state: SessionFolderState) => void): Unsubscribe =>
    subscribe<SessionFolderState>(IPC.sessionChanged, cb),
  onSyncStatus: (cb: (status: LinkStatus) => void): Unsubscribe =>
    subscribe<LinkStatus>(IPC.syncStatus, cb),

  // --- files -----------------------------------------------------------------
  pickFiles: (options: PickFilesOptions = {}): Promise<AttachmentRef[]> =>
    ipcRenderer.invoke(IPC.pickFiles, options),
  onFilesDropped: (cb: (refs: AttachmentRef[]) => void): Unsubscribe =>
    subscribe<AttachmentRef[]>(IPC.filesDropped, cb),

  // --- capture ---------------------------------------------------------------
  captureScreen: (options: CaptureOptions = {}): Promise<AttachmentRef | null> =>
    ipcRenderer.invoke(IPC.captureScreen, options),

  // --- windows ---------------------------------------------------------------
  openQuickBar: (): Promise<void> => ipcRenderer.invoke(IPC.openQuickBar),
  closeQuickBar: (): Promise<void> => ipcRenderer.invoke(IPC.closeQuickBar),
  openMainWindow: (options: OpenMainWindowOptions = {}): Promise<void> =>
    ipcRenderer.invoke(IPC.openMainWindow, options),

  // --- the quick bar window ---------------------------------------------------
  // For the `/quick` page: ask the shell to size the bar to your content
  // (clamped to 72–420), and to dismiss it.
  resizeQuickBar: (height: number): void => {
    ipcRenderer.send(IPC.quickResize, height);
  },
  closeQuickBarWindow: (): void => {
    ipcRenderer.send(IPC.quickHide);
  },

  // --- notifications -----------------------------------------------------------
  /**
   * Raise and focus the window — for a notification's click handler, where
   * `window.focus()` alone does not reliably un-minimise.
   */
  focusWindow: (): void => {
    ipcRenderer.send(IPC.focusWindow);
  },
  /** Mirror the bell's unread count onto the dock icon. 0 clears it. */
  setBadgeCount: (count: number): void => {
    ipcRenderer.send(IPC.setBadgeCount, count);
  },

  // --- voice -------------------------------------------------------------------
  /**
   * The input the user chose in desktop settings, or '' for the system default.
   * Pass it as `{ audio: { deviceId: { exact: id } } }` when starting voice —
   * the shell cannot apply it for you, because the page owns the recording.
   */
  preferredMicrophone: (): Promise<string> => ipcRenderer.invoke(IPC.getSettings).then(
    (s: { preferredMicrophoneId?: string }) => s.preferredMicrophoneId ?? '',
  ),

  // --- activity --------------------------------------------------------------
  /** Tell the shell a turn is streaming so sync polls at 2s (spec §5.3). */
  setTurnActive: (activity: TurnActivity & { folderId?: string }): void => {
    ipcRenderer.send(IPC.setTurnActive, activity);
  },
  /** Which conversation attachments belong to. */
  setActiveSession: (sessionId: string | null): void => {
    ipcRenderer.send(IPC.setActiveSession, sessionId);
  },
} as const;

contextBridge.exposeInMainWorld('redstone', bridge);

/**
 * The shell's own pages (quick bar fallback, sync status, capture picker) need a
 * few extra channels. They are exposed only to `file:` pages the shell ships, so
 * remote content can never see them.
 */
const isLocalPage = location.protocol === 'file:';

const shellOnly = {
  // capture picker
  captureSources: (): Promise<Array<{ id: string; name: string; kind: string; thumbnail: string }>> =>
    ipcRenderer.invoke(IPC.captureSources),
  chooseCaptureSource: (id: string): void => ipcRenderer.send(IPC.captureChoose, id),
  cancelCapture: (): void => ipcRenderer.send(IPC.captureCancel),

  // microphone (preferences window)
  microphoneStatus: (): Promise<string> => ipcRenderer.invoke(IPC.microphoneStatus),
  requestMicrophone: (): Promise<boolean> => ipcRenderer.invoke(IPC.requestMicrophone),
  openSoundSettings: (): Promise<void> => ipcRenderer.invoke(IPC.openSoundSettings),

  // preferences window
  getSettings: (): Promise<Settings> => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke(IPC.setSettings, patch),
  setShortcut: (
    name: 'quickBar' | 'capture' | 'summon',
    accelerator: string,
  ): Promise<{ ok: boolean; shortcuts: ShellInfo['shortcuts'] }> =>
    ipcRenderer.invoke(IPC.setShortcut, { name, accelerator }),
  openServerPicker: (): Promise<void> => ipcRenderer.invoke(IPC.serverPickerOpen),
  openAccountSettings: (): Promise<void> => ipcRenderer.invoke(IPC.openAccountSettings),

  // desktop chrome bar
  reloadApp: (): Promise<void> => ipcRenderer.invoke(IPC.reloadApp),
  openSyncStatus: (): Promise<void> => ipcRenderer.invoke(IPC.openStatusWindow),

  // connection health — the offline screen and the chrome bar's banner
  connection: (): Promise<ConnectionReport> => ipcRenderer.invoke(IPC.connectionState),
  /** Force a probe now, rather than waiting out the backoff. */
  checkConnection: (): Promise<ConnectionReport> => ipcRenderer.invoke(IPC.connectionCheck),
  onConnection: (cb: (report: ConnectionReport) => void): Unsubscribe =>
    subscribe(IPC.connectionChanged, cb),

  // server picker — the screen before login, since login lives on the server
  serverState: (): Promise<ServerState> => ipcRenderer.invoke(IPC.serverState),
  probeServer: (input: string): Promise<ProbeResult> => ipcRenderer.invoke(IPC.probeServer, input),
  useServer: (origin: string): Promise<void> => ipcRenderer.invoke(IPC.useServer, origin),
  forgetServer: (origin: string): Promise<void> => ipcRenderer.invoke(IPC.forgetServer, origin),
  closeServerPicker: (): Promise<void> => ipcRenderer.invoke(IPC.closeServerPicker),
} as const;

if (isLocalPage) contextBridge.exposeInMainWorld('redstoneShell', shellOnly);

// --- decorative animation ------------------------------------------------------
// A mitigation for someone else's CSS, kept as narrow as honesty allows.
//
// The web app animates `scale` on four background blobs carrying
// `filter: blur(90-110px)`. Scaling a blurred element cannot be composited from
// an existing raster — the blur is recomputed every frame — which measured at
// 45% of a CPU core, continuously, forever, and does not stop when the window
// is hidden because notifications need `backgroundThrottling: false`.
//
// Only *infinite* animations on *blurred* elements are paused, so spinners,
// progress bars and transitions are untouched. Off unless the user asks for it
// in desktop settings: this is their product's design, not ours to override.

let reduceMotion = false;

const isDecorative = (el: Element): boolean => {
  const style = getComputedStyle(el);
  if (style.animationName === 'none') return false;
  if (!style.animationIterationCount.split(',').some((n) => n.trim() === 'infinite')) return false;
  return style.filter !== 'none' && /blur/.test(style.filter);
};

const setPlayState = (el: Element, state: 'paused' | 'running'): void => {
  (el as HTMLElement).style.animationPlayState = state;
};

// `animationstart` bubbles, so one capturing listener covers everything the page
// renders now and everything it renders later — no polling, no MutationObserver.
window.addEventListener(
  'animationstart',
  (event) => {
    if (!reduceMotion) return;
    const target = event.target;
    if (target instanceof Element && isDecorative(target)) setPlayState(target, 'paused');
  },
  true,
);

function applyReduceMotion(enabled: boolean): void {
  reduceMotion = enabled;
  // Animations already running when the setting changed, or when the page was
  // restored from bfcache, never fire `animationstart` again.
  for (const el of document.querySelectorAll('*')) {
    if (enabled) {
      if (isDecorative(el)) setPlayState(el, 'paused');
    } else if ((el as HTMLElement).style.animationPlayState === 'paused') {
      setPlayState(el, 'running');
    }
  }
}

ipcRenderer.on(IPC.reduceMotion, (_event, enabled: boolean) => applyReduceMotion(Boolean(enabled)));

// --- connection ---------------------------------------------------------------
// The shell cannot see inside the page, and the page has the one signal the
// main process lacks: Chromium's own link state. Reported from every page, the
// web app included, so a dropped connection is noticed the moment it happens
// instead of at the next probe. It is a hint — main verifies before believing
// it (see connection.ts).
const reportNetwork = (): void => {
  ipcRenderer.send(IPC.networkReport, navigator.onLine);
};
window.addEventListener('online', reportNetwork);
window.addEventListener('offline', reportNetwork);

// --- drag and drop ----------------------------------------------------------
// Rendered by the shell rather than the web app: `webUtils.getPathForFile` only
// exists here, and the drop target should work on any page the window shows.

let depth = 0;
let overlay: HTMLElement | null = null;

/**
 * Styles are applied through the CSSOM rather than an injected `<style>` tag or
 * `innerHTML`: the page this decorates is remote and may ship a strict CSP,
 * which would drop a stylesheet on the floor and leave the user with an
 * unreadable overlay. Element `.style` assignments are not policed by CSP.
 */
function style(el: HTMLElement, rules: Partial<CSSStyleDeclaration>): HTMLElement {
  Object.assign(el.style, rules);
  return el;
}

function ensureOverlay(): HTMLElement {
  if (overlay?.isConnected) return overlay;

  const el = style(document.createElement('div'), {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    display: 'none',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(13, 15, 19, 0.72)',
    backdropFilter: 'blur(2px)',
    font: '500 15px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif',
    color: '#f6f7f9',
    pointerEvents: 'none',
  });
  el.id = 'redstone-drop-target';
  el.setAttribute('role', 'presentation');

  const card = style(document.createElement('div'), {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '14px',
    padding: '34px 46px',
    borderRadius: '16px',
    border: '2px dashed rgba(214, 64, 58, 0.7)',
    background: 'rgba(22, 24, 31, 0.88)',
    boxShadow: '0 24px 60px rgba(0, 0, 0, 0.45)',
  });

  const glyph = style(document.createElement('div'), {
    width: '34px',
    height: '34px',
    transform: 'rotate(45deg)',
    borderRadius: '5px',
    background: 'linear-gradient(150deg, #e6524b, #a12520)',
  });

  const label = document.createElement('div');
  label.textContent = 'Drop to attach';

  card.append(glyph, label);
  el.append(card);
  document.body.append(el);
  overlay = el;
  return el;
}

function setOverlay(active: boolean): void {
  ensureOverlay().style.display = active ? 'flex' : 'none';
}

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

window.addEventListener('dragenter', (event) => {
  if (isLocalPage || !hasFiles(event)) return;
  depth++;
  setOverlay(true);
});

window.addEventListener('dragover', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('dragleave', (event) => {
  if (!hasFiles(event)) return;
  depth = Math.max(0, depth - 1);
  if (depth === 0) setOverlay(false);
});

window.addEventListener('drop', (event) => {
  if (isLocalPage || !hasFiles(event)) return;
  event.preventDefault();
  depth = 0;
  setOverlay(false);

  const files = Array.from(event.dataTransfer?.files ?? []);
  if (!files.length) return;
  // `File.path` was removed from Electron; this is the supported replacement.
  const paths = files.map((file) => webUtils.getPathForFile(file)).filter(Boolean);
  if (!paths.length) return;
  void ipcRenderer.invoke(IPC.uploadDroppedPaths, { paths });
});

declare global {
  interface Window {
    redstone: typeof bridge;
    redstoneShell?: typeof shellOnly;
  }
}
