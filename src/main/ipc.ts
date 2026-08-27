/**
 * Every method the renderer can reach, and the checks each one carries.
 *
 * The renderer runs remote code, so nothing here is generic: no readFile, no
 * writeFile, no exec (spec §8). A `localPath` is only accepted when a native
 * dialog produced it, and a `relPath` is always resolved inside its link root.
 */
import { BrowserWindow, app, ipcMain, shell, webContents } from 'electron';
import { IPC, type LinkStatus, type ServerState, type ShellInfo } from '../shared/types';
import { ROUTES, SYNC } from '../shared/constants';
import { activeServer, forgetServer, knownServers, probeServer } from './servers';
import { connectToServer } from './server-switch';
import { closeServerWindow, showServerWindow } from './windows/server-window';
import { getSettings, updateSettings } from './settings';
import { isApproved, listLinks } from './links';
import path from 'node:path';
import { listFolders } from './api/client';
import { syncEngine } from './sync/engine';
import { openFolderFlow, pickFolder, revealInFileManager } from './folder-flow';
import {
  NoActiveSessionError,
  getActiveSession,
  pickAndUpload,
  setActiveSession,
  setQuickSession,
  uploadPaths,
} from './attachments';
import { showError } from './dialogs';
import { captureAndConfirm, flushPendingCapture } from './capture';
import { ensureMicrophoneAccess, microphoneStatus } from './media-access';
import {
  linkFolderToSession,
  noteWebAppRendersFolderControl,
  sessionFolderState,
  unlinkSessionFolder,
} from './session-folder';
import { announceSession } from './session-broadcast';
import {
  focusMainWindow,
  getMainWindow,
  loadApp,
  pushReduceMotion,
  reloadApp,
  showMainWindow,
} from './windows/main-window';
import { showStatusWindow } from './windows/status-window';
import { showPreferencesWindow } from './windows/preferences-window';
import { buildMenu } from './menu';
import {
  checkConnection,
  getConnection,
  reportRendererNetwork,
  type ConnectionReport,
} from './connection';
import {
  getQuickWindow,
  hideQuickWindow,
  resizeQuickWindow,
  showQuickWindow,
} from './windows/quick-window';
import { registeredShortcuts, setShortcut, type ShortcutName } from './shortcuts';
import logger from './logger';

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/**
 * The window a native dialog should hang off.
 *
 * The web app lives in a `WebContentsView`, not a `BrowserWindow`, so
 * `fromWebContents` returns **null** for every call the page makes — and a
 * parentless `showOpenDialog` on macOS opens as its own window that can land
 * behind the app. From the user's side that is a button that does nothing.
 * Falling back to the main window makes it a sheet, which cannot hide.
 */
const windowFor = (event: { sender: Electron.WebContents }): BrowserWindow | null =>
  BrowserWindow.fromWebContents(event.sender) ?? getMainWindow();

/** Did this call come from the quick bar's window rather than the main one? */
const isQuickBar = (event: { sender: Electron.WebContents }): boolean => {
  const bar = getQuickWindow();
  return Boolean(bar && !bar.isDestroyed() && bar.webContents.id === event.sender.id);
};

/** Broadcast a sync status to every window that might be rendering it. */
/** Broadcast a connection report to every window that renders one. */
export function broadcastConnection(report: ConnectionReport): void {
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed()) continue;
    contents.send(IPC.connectionChanged, report);
  }
}

export function broadcastStatus(status: LinkStatus): void {
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed()) continue;
    contents.send(IPC.syncStatus, status);
  }
}

/**
 * Records, once per channel per run, when a call arrives from the *web app*
 * rather than from one of the shell's own pages.
 *
 * "Is the web app actually using the bridge?" is otherwise unanswerable without
 * reading their bundle: the shell's chrome bar calls the same methods, so a
 * channel firing proves nothing on its own. Local pages are `file:`, the web app
 * is `https:` — that is the whole test.
 */
const announcedCallers = new Set<string>();
function noteCaller(channel: string, event: { senderFrame?: { url?: string } | null }): void {
  const url = event.senderFrame?.url ?? '';
  if (!/^https?:/.test(url)) return;
  const folderChannel =
    channel === IPC.sessionFolder ||
    channel === IPC.linkSessionFolder ||
    channel === IPC.unlinkSessionFolder;
  if (folderChannel && noteWebAppRendersFolderControl()) {
    void announceSession(getActiveSession());
  }
  if (announcedCallers.has(channel)) return;
  announcedCallers.add(channel);
  logger.info(`bridge: the web app called ${channel}`);
}

export function registerIpc(): void {
  // Thin wrappers so every bridge call is attributed to its caller.
  const handle = (
    channel: string,
    fn: (event: Electron.IpcMainInvokeEvent, ...args: never[]) => unknown,
  ): void => {
    ipcMain.handle(channel, (event, ...args) => {
      noteCaller(channel, event);
      return fn(event, ...(args as never[]));
    });
  };
  const on = (
    channel: string,
    fn: (event: Electron.IpcMainEvent, ...args: never[]) => void,
  ): void => {
    ipcMain.on(channel, (event, ...args) => {
      noteCaller(channel, event);
      fn(event, ...(args as never[]));
    });
  };

  // --- shell info ------------------------------------------------------------
  handle(IPC.shellInfo, (): ShellInfo => {
    const settings = getSettings();
    return {
      version: app.getVersion(),
      platform: process.platform,
      appOrigin: settings.appOrigin,
      shortcuts: registeredShortcuts(),
    };
  });

  // --- folders ---------------------------------------------------------------
  handle(IPC.pickFolder, async (event) => {
    const window = windowFor(event);
    return pickFolder(window);
  });

  handle(IPC.linkFolder, async (_event, raw: unknown) => {
    const options = (raw ?? {}) as { folderId?: unknown; localPath?: unknown };
    const folderId = asString(options.folderId);
    const localPath = asString(options.localPath);
    if (!folderId || !localPath) throw new Error('folderId and localPath are required');
    // The trust boundary: a path the renderer invented is refused outright.
    if (!isApproved(localPath)) {
      throw new Error('that folder was not chosen through a Redstone file dialog');
    }
    // A raw id is not a name. Ask the server what the folder is called, and if
    // that cannot be answered, the directory the user picked is a better label
    // than a UUID in the window chrome.
    const known = listLinks().find((l) => l.folderId === folderId);
    const name =
      known?.folderName ??
      (await listFolders()
        .then(({ items }) => items.find((f) => f.id === folderId)?.name)
        .catch(() => undefined)) ??
      path.basename(localPath);
    return syncEngine.link(folderId, name, localPath);
  });

  handle(IPC.unlinkFolder, async (_event, folderId: unknown) => {
    const id = asString(folderId);
    if (!id) throw new Error('folderId is required');
    await syncEngine.unlink(id);
  });

  handle(IPC.listLinks, (): LinkStatus[] => syncEngine.statuses());

  handle(IPC.pauseLink, async (_event, folderId: unknown) => {
    const id = asString(folderId);
    if (id) await syncEngine.pause(id);
  });

  handle(IPC.resumeLink, async (_event, folderId: unknown) => {
    const id = asString(folderId);
    if (id) await syncEngine.resume(id);
  });

  handle(IPC.syncNow, (_event, folderId: unknown) => {
    syncEngine.syncNow(asString(folderId));
  });

  handle(IPC.revealInFileManager, (_event, raw: unknown) => {
    const options = (raw ?? {}) as { folderId?: unknown; relPath?: unknown };
    const folderId = asString(options.folderId);
    if (!folderId) throw new Error('folderId is required');
    revealInFileManager(folderId, asString(options.relPath));
  });

  handle(IPC.openFolderFlow, async (event) => {
    const window = windowFor(event);
    const result = await openFolderFlow(window);
    return result.status;
  });

  // --- files -----------------------------------------------------------------
  handle(IPC.pickFiles, async (event, raw: unknown) => {
    const options = (raw ?? {}) as { multiple?: unknown; sessionId?: unknown };
    const window = windowFor(event);
    try {
      return await pickAndUpload({
        parent: window,
        multiple: options.multiple !== false,
        sessionId: asString(options.sessionId),
      });
    } catch (err) {
      logger.warn('attach failed', err);
      showError(
        err instanceof NoActiveSessionError ? 'Open a conversation first' : 'Could not attach those files',
        err,
      );
      return [];
    }
  });

  handle(IPC.uploadDroppedPaths, async (_event, raw: unknown) => {
    const options = (raw ?? {}) as { paths?: unknown; sessionId?: unknown };
    const paths = Array.isArray(options.paths)
      ? options.paths.filter((p): p is string => typeof p === 'string')
      : [];
    if (!paths.length) return [];
    // Dropped paths come from the OS drag payload, not from page script, so they
    // are as trustworthy as a dialog — but they are still only ever uploaded,
    // never read back into the page.
    const refs = await uploadPaths(paths, { sessionId: asString(options.sessionId) });
    for (const contents of webContents.getAllWebContents()) {
      if (!contents.isDestroyed()) contents.send(IPC.filesDropped, refs);
    }
    return refs;
  });

  // --- capture ---------------------------------------------------------------
  handle(IPC.captureScreen, async (_event, raw: unknown) => {
    const options = (raw ?? {}) as { sessionId?: unknown };
    return captureAndConfirm(asString(options.sessionId));
  });

  // --- windows ---------------------------------------------------------------
  handle(IPC.openQuickBar, async () => {
    await showQuickWindow();
  });
  handle(IPC.closeQuickBar, () => hideQuickWindow());
  handle(IPC.openMainWindow, (_event, raw: unknown) => {
    const options = (raw ?? {}) as { sessionId?: unknown };
    showMainWindow({ sessionId: asString(options.sessionId) });
  });

  // --- turn activity ---------------------------------------------------------
  on(IPC.setTurnActive, (event, raw: unknown) => {
    const options = (raw ?? {}) as { sessionId?: unknown; active?: unknown; folderId?: unknown };
    const sessionId = asString(options.sessionId);
    if (sessionId) {
      if (isQuickBar(event)) {
        setQuickSession(sessionId);
        void flushPendingCapture(sessionId);
      } else {
        setActiveSession(sessionId, 'web-app');
      }
    }
    syncEngine.setTurnActive(asString(options.folderId) ?? null, options.active === true);
  });

  on(IPC.setActiveSession, (event, sessionId: unknown) => {
    const id = asString(sessionId) ?? null;
    // The quick bar creates its own conversation on first send. Attributing that
    // to the main window would send later screenshots to the wrong chat.
    if (isQuickBar(event)) {
      setQuickSession(id);
      if (id) void flushPendingCapture(id);
      return;
    }
    setActiveSession(id, 'web-app');
  });

  // --- settings --------------------------------------------------------------
  handle(IPC.getSettings, () => getSettings());
  handle(IPC.setSettings, (_event, raw: unknown) => {
    const patch = (raw ?? {}) as Record<string, unknown>;

    // Shortcuts go through the registrar so a clash is reported rather than
    // silently saved.
    const shortcuts = patch.shortcuts as Partial<Record<ShortcutName, string>> | undefined;
    for (const name of ['quickBar', 'capture', 'summon'] as const) {
      const value = shortcuts?.[name];
      if (typeof value === 'string') setShortcut(name, value);
    }

    // Everything else is copied field by field, never spread. `appOrigin` and
    // `allowedOrigins` are deliberately absent: they define what the renderer is
    // allowed to reach, and remote code must not be able to widen its own cage.
    const safe: Parameters<typeof updateSettings>[0] = {};
    if (typeof patch.quickBarContinuesLastSession === 'boolean') {
      safe.quickBarContinuesLastSession = patch.quickBarContinuesLastSession;
    }
    if (typeof patch.autoUpdate === 'boolean') safe.autoUpdate = patch.autoUpdate;
    if (typeof patch.launchAtLogin === 'boolean') safe.launchAtLogin = patch.launchAtLogin;
    if (typeof patch.preferredMicrophoneId === 'string') {
      safe.preferredMicrophoneId = patch.preferredMicrophoneId.slice(0, 200);
    }
    if (typeof patch.maxSyncFileBytes === 'number' && Number.isFinite(patch.maxSyncFileBytes)) {
      safe.maxSyncFileBytes = Math.max(1, Math.min(patch.maxSyncFileBytes, SYNC.maxFileBytes));
    }
    if (typeof patch.reduceBackgroundAnimation === 'boolean') {
      safe.reduceBackgroundAnimation = patch.reduceBackgroundAnimation;
    }
    const saved = updateSettings(safe);
    // Takes effect on the open page, not just the next one.
    if (safe.reduceBackgroundAnimation !== undefined) pushReduceMotion();
    return saved;
  });

  // --- server picker ---------------------------------------------------------
  handle(IPC.serverState, (): ServerState => ({
    activeOrigin: activeServer(),
    servers: knownServers(),
    version: app.getVersion(),
  }));

  handle(IPC.probeServer, async (_event, raw: unknown) => {
    const input = asString(raw);
    if (!input) return { ok: false, reason: 'invalid', message: 'Enter a server address.' };
    return probeServer(input);
  });

  handle(IPC.useServer, async (_event, raw: unknown) => {
    const origin = asString(raw);
    if (!origin) throw new Error('a server origin is required');
    await connectToServer(origin);
  });

  handle(IPC.forgetServer, async (_event, raw: unknown) => {
    const origin = asString(raw);
    if (origin) await forgetServer(origin);
  });

  handle(IPC.closeServerPicker, () => closeServerWindow());

  // --- per-conversation folder link ------------------------------------------
  handle(IPC.sessionFolder, async (_event, raw: unknown) => {
    // No argument means "whichever conversation is open" — the shell tracks it.
    const sessionId = asString(raw) ?? getActiveSession();
    return sessionFolderState(sessionId);
  });

  handle(IPC.linkSessionFolder, async (event, raw: unknown) => {
    const sessionId = asString(raw) ?? getActiveSession();
    const window = windowFor(event);
    logger.info(`link-folder requested (session ${sessionId ? 'known' : 'unknown'})`);
    if (!sessionId) {
      // Surfaced natively: the caller may be the 44px chrome bar, which has
      // nowhere to draw a message of its own.
      showError(
        'Open a conversation first',
        new Error('Open a chat, then link a folder to it — a folder belongs to a conversation.'),
      );
      return null;
    }
    try {
      return await linkFolderToSession(sessionId, window);
    } catch (err) {
      logger.warn('link-folder failed', err);
      showError('Could not link that folder', err);
      return null;
    }
  });

  handle(IPC.unlinkSessionFolder, async (_event, raw: unknown) => {
    const sessionId = asString(raw) ?? getActiveSession();
    if (sessionId) await unlinkSessionFolder(sessionId);
  });

  // --- notifications ---------------------------------------------------------
  // The web app owns notifications for server events — it holds the stream, and
  // a second path in the shell would double-notify. These two are the parts a
  // page cannot do for itself.
  on(IPC.focusWindow, () => focusMainWindow());

  on(IPC.setBadgeCount, (_event, raw: unknown) => {
    const count = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;
    if (process.platform === 'win32') {
      // Windows has no numeric badge; an overlay is the equivalent, and doing
      // nothing is better than a wrong number.
      return;
    }
    app.setBadgeCount(count);
  });

  // --- preferences -----------------------------------------------------------
  handle(IPC.microphoneStatus, () => microphoneStatus());

  handle(IPC.requestMicrophone, () => ensureMicrophoneAccess());

  handle(IPC.openSoundSettings, () => {
    // Chromium records from the system default input, so which device that is
    // gets decided here, not in the app.
    void shell.openExternal(
      process.platform === 'darwin'
        ? 'x-apple.systempreferences:com.apple.preference.sound'
        : 'ms-settings:sound',
    );
  });

  handle(IPC.openPreferences, () => {
    showPreferencesWindow();
  });

  handle(IPC.serverPickerOpen, () => {
    showServerWindow();
  });

  handle(IPC.openAccountSettings, () => {
    // Account settings are the web app's; the shell only opens the door.
    void loadApp(ROUTES.settings);
    showMainWindow();
  });

  handle(IPC.setShortcut, (_event, raw: unknown) => {
    const options = (raw ?? {}) as { name?: unknown; accelerator?: unknown };
    const name = asString(options.name) as ShortcutName | undefined;
    const accelerator = asString(options.accelerator);
    if (!name || !accelerator || !['quickBar', 'capture', 'summon'].includes(name)) {
      return { ok: false, shortcuts: registeredShortcuts() };
    }
    // Reported rather than swallowed: a shortcut another app owns cannot be
    // claimed, and a key that silently does nothing is the worst outcome.
    const ok = setShortcut(name, accelerator);
    buildMenu();
    return { ok, shortcuts: registeredShortcuts() };
  });

  // --- connection health -----------------------------------------------------
  // Read by the offline screen and the chrome bar's banner. `connectionCheck`
  // is the "Try again" button: it forces a probe rather than waiting out the
  // backoff, and answers with the result so the page can say what happened.
  handle(IPC.connectionState, (): ConnectionReport => getConnection());
  handle(IPC.connectionCheck, (): Promise<ConnectionReport> => checkConnection());

  // A hint from any page, including the web app: its `navigator.onLine`
  // flipped. Main still verifies with its own probe — `onLine` is true on a
  // café network whose portal has not been accepted.
  on(IPC.networkReport, (_event, online: unknown) => {
    if (typeof online === 'boolean') reportRendererNetwork(online);
  });

  // --- desktop chrome bar ----------------------------------------------------
  handle(IPC.reloadApp, () => reloadApp());
  handle(IPC.openStatusWindow, () => {
    showStatusWindow();
  });

  // --- quick bar ---------------------------------------------------------------
  // The bar's contents are the web app's `/quick` route; the only thing it needs
  // from the shell is a say in how tall the window is.
  on(IPC.quickResize, (_event, height: unknown) => {
    if (typeof height === 'number' && Number.isFinite(height)) resizeQuickWindow(height);
  });
  on(IPC.quickHide, () => hideQuickWindow());

  logger.info('ipc handlers registered');
}
