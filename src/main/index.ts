/**
 * Main process bootstrap.
 *
 * Order matters: logging (so nothing before it escapes unredacted) → settings →
 * session hardening → windows → sync. Sync starts last because it needs the
 * partition to exist before it can read the auth cookie.
 */
import { app, BrowserWindow, powerMonitor } from 'electron';
import { initLogging } from './logger';
import logger from './logger';
import { flushSettings, getSettings, initSettings } from './settings';
import { hardenSession } from './security';
import { authEvents, redstoneSession } from './auth';
import { initLinks, flushLinks } from './links';
import { flushServers, hasServer, initServers, knownServers } from './servers';
import { showServerWindow } from './windows/server-window';
import { registerIpc, broadcastStatus, broadcastConnection } from './ipc';
import { onConnectionChange } from './connection';
import { IPC } from '../shared/types';
import { buildMenu } from './menu';
import { createTray, destroyTray, refreshTray } from './tray';
import { applyShortcuts, releaseShortcuts } from './shortcuts';
import { createMainWindow, showMainWindow } from './windows/main-window';
import { syncEngine } from './sync/engine';
import { initUpdater, stopUpdater } from './updater';
import { notifyConflict, notifySignedOut, notifySyncError } from './notifications';
import { beginQuitting } from './lifecycle';
import { runE2E } from './e2e';
import { getActiveSession, setActiveSession } from './attachments';
import { announceSession } from './session-broadcast';
import { preloadPath } from './windows/main-window';

const smokeTest = process.argv.includes('--smoke-test') || process.env.REDSTONE_SMOKE_TEST === '1';
/** Drives the chrome bar's buttons with the native picker stubbed. See runUiTest. */
const uiTest = process.argv.includes('--ui-test');
/** Full acceptance run against a real signed-in server. See e2e.ts. */
const e2e = process.argv.includes('--e2e');

// A second launch focuses the running app instead of starting a rival copy that
// would fight it over the same sync state.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

function main(): void {
  app.on('second-instance', () => (hasServer() ? showMainWindow() : showServerWindow()));

  // Windows silently drops every toast unless this matches the AppUserModelID
  // the installer registers (docs/desktop-notifications §2.4). Set before any
  // window exists.
  if (process.platform === 'win32') app.setAppUserModelId('dev.yitec.redstone.desktop');

  // Chromium's default is fine everywhere except Linux, where a sandboxed
  // AppImage on a kernel without unprivileged user namespaces cannot start.
  if (process.platform === 'linux' && process.env.REDSTONE_NO_SANDBOX === '1') {
    app.commandLine.appendSwitch('no-sandbox');
  }

  app.on('window-all-closed', () => {
    // The tray keeps the app alive: sync should continue with no window open.
    if (process.platform !== 'darwin' && smokeTest) app.quit();
  });

  app.on('activate', () => {
    if (!hasServer()) {
      showServerWindow();
      return;
    }
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    else showMainWindow();
  });

  app.on('before-quit', () => {
    // Tells the window's close handler that this one is real.
    beginQuitting();
    releaseShortcuts();
    stopUpdater();
  });

  app.on('will-quit', (event) => {
    event.preventDefault();
    // `.catch` as well as `.finally`: a rejection here would surface as an
    // uncaught exception dialog on the way out, which is the worst possible
    // moment to show one.
    void shutdown()
      .catch((err) => logger.warn('shutdown failed', err))
      .finally(() => app.exit(0));
  });

  void app.whenReady().then(bootstrap);
}

let shuttingDown = false;

async function bootstrap(): Promise<void> {
  initLogging();
  logger.info(`Redstone ${app.getVersion()} starting on ${process.platform}`);

  await initSettings();
  await initServers();
  await initLinks();
  hardenSession();
  registerIpc();
  buildMenu();

  // Every window that draws a connection banner hears about a change from here,
  // rather than each of them polling on its own timer.
  onConnectionChange(broadcastConnection);

  if (smokeTest) {
    await runSmokeTest();
    return;
  }

  if (uiTest) {
    await runUiTest();
    return;
  }

  if (e2e) {
    // The sync engine has to be running for the acceptance checks to mean
    // anything; everything else (tray, updater) is noise here.
    wireSyncEvents();
    await syncEngine.start();
    await runE2E();
    return;
  }

  createTray();
  applyShortcuts({ announceFailures: true });
  initUpdater();
  wireSyncEvents();

  // Redstone can be self-hosted or regional, so a fresh install has nowhere to
  // point yet: ask for the server before opening a window onto one. Login
  // happens after, on the server's own form.
  if (!hasServer()) {
    showServerWindow();
    return;
  }

  createMainWindow();
  await syncEngine.start();

  // Watchers miss events across sleep, so a wake is treated as "rescan now"
  // (spec §5.3).
  powerMonitor.on('resume', () => {
    logger.info('system resumed — resyncing');
    syncEngine.syncAll();
  });
  powerMonitor.on('unlock-screen', () => syncEngine.syncAll());
}

function wireSyncEvents(): void {
  syncEngine.on('status', (status) => {
    broadcastStatus(status);
    refreshTray();
  });
  syncEngine.on('conflict', (folderName: string, relPath: string) => {
    notifyConflict(folderName, relPath);
  });
  syncEngine.on('error', (folderName: string, message: string) => {
    notifySyncError(folderName, message);
  });
  authEvents.on('signed-out', () => {
    notifySignedOut();
    refreshTray();
  });
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // Quit before startup finished: none of the things below exist yet, and each
  // one would throw on its own.
  if (!app.isReady()) return;
  logger.info('shutting down');
  releaseShortcuts();
  stopUpdater();
  destroyTray();

  // Chromium writes cookies and local storage lazily, and `app.exit()` does not
  // wait for it. Without this the login the web app just stored is lost on quit
  // and the user signs in again on every launch.
  try {
    const ses = redstoneSession();
    await ses.cookies.flushStore();
    await ses.flushStorageData?.();
  } catch (err) {
    logger.warn('could not flush session storage', err);
  }
  await Promise.all([syncEngine.stop(), flushSettings(), flushLinks(), flushServers()]).catch(
    (err) => logger.warn('shutdown flush failed', err),
  );
}

/**
 * `--ui-test` renders the real chrome bar with the real preload and checks what
 * it shows.
 *
 * The bar is deliberately empty of actions now — those live in the web app's UI
 * — so most of what this guards is that they stay gone, that the drag region
 * survives, and the session-source regression that once left every
 * session-scoped action with nothing to act on. The folder flow itself is
 * covered end to end by `--e2e` against a real server.
 */
async function runUiTest(): Promise<void> {
  const { BrowserWindow: BW } = require('electron') as typeof import('electron');
  const path = require('node:path') as typeof import('node:path');

  const window = new BW({
    show: false,
    width: 900,
    height: 44,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: preloadPath() },
  });
  await window.loadFile(path.join(__dirname, '../renderer/chrome.html'));

  const results: Record<string, boolean> = {};

  // 1. The bar carries no actions and no sync summary. Both belong elsewhere
  //    (docs/integration/04-desktop-affordances-in-web-ui.md, and the status
  //    window for sync); anything reappearing here is a regression.
  await announceSession(null);
  await settle();
  results.barCarriesNothingButChrome = await window.webContents.executeJavaScript(
    '["folder","attach","capture","sync"].every((id) => document.getElementById(id) === null)',
  );

  // 3. The regression that shipped: connecting to a server calls
  //    setActiveSession(null) internally, which used to be indistinguishable
  //    from the web app reporting — and that permanently disabled reading the
  //    conversation from the URL, leaving every session-scoped action with
  //    nothing to act on and no visible error.
  setActiveSession(null);
  setActiveSession('ui-test-session', 'url');
  results.urlFallbackSurvivesInternalCalls = getActiveSession() === 'ui-test-session';

  // 3b. A connection problem must be *visible*. It used to be invisible until
  //     the view went blank, which is how a flaky café network turned into "the
  //     app is broken". The bar stays silent while everything works, says what
  //     is wrong while it is wrong, and confirms recovery.
  const banner = (): Promise<string> =>
    window.webContents.executeJavaScript(
      'JSON.stringify({hidden: document.getElementById("net").hidden, text: document.getElementById("net-text").textContent})',
    );

  results.barIsSilentWhileOnline = JSON.parse(await banner()).hidden === true;

  window.webContents.send(IPC.connectionChanged, {
    state: 'no-internet',
    message: '',
    host: 'redstone.example.com',
    attempts: 1,
    since: Date.now(),
  });
  await settle();
  const down = JSON.parse(await banner());
  results.barWarnsWhenOffline = down.hidden === false && /no internet/i.test(down.text);

  window.webContents.send(IPC.connectionChanged, {
    state: 'server-unreachable',
    message: '',
    host: 'redstone.example.com',
    attempts: 2,
    since: Date.now(),
  });
  await settle();
  const unreachable = JSON.parse(await banner());
  results.barNamesTheServerItCannotReach = /redstone\.example\.com/.test(unreachable.text);

  window.webContents.send(IPC.connectionChanged, {
    state: 'online',
    message: '',
    host: 'redstone.example.com',
    attempts: 0,
    since: Date.now(),
  });
  await settle();
  const back = JSON.parse(await banner());
  results.barConfirmsRecovery = back.hidden === false && /back online/i.test(back.text);

  // 4. The drag region is the whole point of the bar existing.
  results.barIsDraggable = await window.webContents.executeJavaScript(
    'getComputedStyle(document.querySelector(".bar")).webkitAppRegion === "drag"',
  );

  const failed = Object.entries(results).filter(([, ok]) => !ok).map(([name]) => name);
  // eslint-disable-next-line no-console
  console.log(`[ui-test] ${JSON.stringify(results)}`);
  if (failed.length) console.error(`[ui-test] FAILED: ${failed.join(', ')}`);
  window.destroy();
  await shutdown();
  app.exit(failed.length === 0 ? 0 : 1);
}

const settle = (ms = 250): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `--smoke-test` boots the whole main process — settings, session hardening,
 * IPC, menu, a real BrowserWindow with the production preload — without loading
 * remote content, then exits. It is what the build pipeline runs to prove the
 * bundle actually executes on each platform.
 */
async function runSmokeTest(): Promise<void> {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: require('node:path').join(__dirname, '../preload/index.js'),
    },
  });
  await window.loadURL('about:blank');
  const bridgeOk = await window.webContents.executeJavaScript(
    'typeof window.redstone === "object" && window.redstone.version === "1"',
  );
  const checks = {
    // Not "an origin exists" — a fresh install deliberately has none until the
    // user names their instance. What matters is that settings loaded.
    settings: Boolean(getSettings().shortcuts.quickBar),
    servers: Array.isArray(knownServers()),
    window: !window.isDestroyed(),
    bridge: bridgeOk === true,
    links: Array.isArray(syncEngine.statuses()),
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  // eslint-disable-next-line no-console
  console.log(`[smoke] ${JSON.stringify(checks)}`);
  window.destroy();
  await shutdown();
  app.exit(failed.length === 0 ? 0 : 1);
}
