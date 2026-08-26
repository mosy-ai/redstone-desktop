/**
 * The main window: a thin desktop chrome bar above the web app.
 *
 * The window's own page is local (`chrome.html`); the web app lives in a child
 * `WebContentsView` beneath it. Both reasons for the split came out of actually
 * using the app:
 *
 *   1. **Dragging.** A window with the title bar hidden is only movable where
 *      the page declares `-webkit-app-region: drag`. The web app has no idea it
 *      is inside a desktop shell, so there was nowhere to grab. The chrome bar
 *      is that region.
 *   2. **Discoverability.** Folder linking, attaching and sync status are
 *      desktop-only, and the web app does not render buttons for them yet
 *      (spec §8 has it feature-detect `window.redstone`; the live bundles do not
 *      mention it). The bar surfaces them without touching the web app's DOM.
 *
 * The web app is still never reimplemented here — the bar holds exactly the
 * actions a browser cannot perform.
 */
import { BrowserWindow, WebContentsView, app, nativeTheme, screen } from 'electron';
import path from 'node:path';
import { SESSION_PARTITION, ROUTES } from '../../shared/constants';
import { appUrl, getSettings } from '../settings';
import { showServerWindow } from './server-window';
import { guardWebContents } from '../security';
import { setActiveSession } from '../attachments';
import { isQuitting } from '../lifecycle';
import { announceSession } from '../session-broadcast';
import { checkConnection, watchUntilOnline } from '../connection';
import logger from '../logger';

/** Height of the desktop chrome bar, in DIPs. */
const CHROME_HEIGHT = 44;

let win: BrowserWindow | null = null;
let appView: WebContentsView | null = null;

export const preloadPath = (): string => path.join(__dirname, '../preload/index.js');
const rendererFile = (name: string): string => path.join(__dirname, '../renderer', name);

export function getMainWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

/** The web app's contents — everything remote happens here, never in the window. */
export function getAppContents(): Electron.WebContents | null {
  return appView && !appView.webContents.isDestroyed() ? appView.webContents : null;
}

export function createMainWindow(): BrowserWindow {
  const existing = getMainWindow();
  if (existing) return existing;

  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#15110D' : '#15110D',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 14, y: 14 } : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: preloadPath(),
      backgroundThrottling: false,
    },
  });

  guardWebContents(win.webContents);
  void win.loadFile(rendererFile('chrome.html'));

  appView = new WebContentsView({
    webPreferences: {
      // Non-negotiable, spec §3: this view loads remote content.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      partition: SESSION_PARTITION,
      preload: preloadPath(),
      spellcheck: true,
      // The page holds the notification event stream. Electron throttles timers
      // in hidden windows, which stretches its reconnect backoff to minutes —
      // so notifications arrive late or not at all after a blip, which is
      // exactly when the window is hidden and they matter most.
      backgroundThrottling: false,
    },
  });
  win.contentView.addChildView(appView);
  guardWebContents(appView.webContents);
  watchAppNavigation(appView.webContents);

  layout();
  win.on('resize', layout);
  win.once('ready-to-show', () => win?.show());

  // Closing hides. A destroyed renderer has no event stream, and notifications
  // while the app is out of sight are the entire point of it running in the
  // tray. Quitting is explicit: the menu, the tray, or ⌘Q.
  win.on('close', (event) => {
    if (isQuitting()) return;
    event.preventDefault();
    win?.hide();
    if (process.platform === 'darwin') app.dock?.hide();
  });

  win.on('closed', () => {
    win = null;
    appView = null;
  });

  void loadApp();
  return win;
}

/** Keep the web app filling everything below the chrome bar. */
function layout(): void {
  const target = getMainWindow();
  if (!target || !appView) return;
  const { width, height } = target.getContentBounds();
  appView.setBounds({
    x: 0,
    y: CHROME_HEIGHT,
    width,
    height: Math.max(0, height - CHROME_HEIGHT),
  });
}

/**
 * Learn the open conversation from the URL.
 *
 * A fallback, not the mechanism. The web app tells us the conversation through
 * `setActiveSession`; where it does not (older deployments), `/chat?s=<id>` is
 * already in the address. The first real call from the web app switches this
 * off for good — see `setActiveSession`.
 */
function watchAppNavigation(contents: Electron.WebContents): void {
  let current: string | null = null;

  let onChat = false;
  const read = (rawUrl: string): void => {
    let sessionId: string | null = null;
    let isChat = false;
    try {
      const url = new URL(rawUrl);
      // Two different questions: is this the chat screen at all, and is a
      // conversation open on it. A new chat answers yes and no.
      isChat = url.pathname.startsWith(ROUTES.chat);
      if (isChat) sessionId = url.searchParams.get('s');
    } catch {
      /* file: pages and about:blank are neither */
    }
    if (sessionId === current && isChat === onChat) return;
    current = sessionId;
    onChat = isChat;
    setActiveSession(sessionId, 'url');
    void announceSession(sessionId, isChat);
  };
  contents.on('did-navigate', (_e, url) => read(url));
  contents.on('did-navigate-in-page', (_e, url) => read(url));

  contents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 is ERR_ABORTED, which a normal in-app navigation produces.
    if (!isMainFrame || errorCode === -3) return;
    onLoadFailed(contents, errorCode, errorDescription, validatedURL);
  });

  // Chromium finishes loading its *error* page too, and that page keeps the URL
  // it failed on — so "did-finish-load on a remote URL" is not success, and
  // treating it as success resets the retry budget into a 1.2s reload loop. The
  // navigation is only clean if nothing failed since it started.
  contents.on('did-start-loading', () => {
    failedThisLoad = false;
  });
  contents.on('did-finish-load', () => {
    if (failedThisLoad) return;
    if (contents.getURL().startsWith('file:')) return;
    silentRetried = false;
  });
}

/**
 * One silent retry, then the offline screen.
 *
 * A single dropped packet while switching access points fails a navigation, and
 * replacing a working page with an error screen for that is worse than the blip
 * — so the first failure is retried quietly. The second is real, and gets an
 * explanation instead of another attempt: from here recovery is detected by
 * probing (`connection.ts`), never by reloading the view on a timer. Reloading
 * on a timer is what made a weak connection flash.
 */
let silentRetried = false;
/** Set by `did-fail-load`, cleared when the next navigation starts. */
let failedThisLoad = false;

function onLoadFailed(
  contents: Electron.WebContents,
  errorCode: number,
  errorDescription: string,
  validatedURL: string,
): void {
  logger.warn('web app failed to load', { errorCode, errorDescription });
  failedThisLoad = true;

  if (!silentRetried) {
    silentRetried = true;
    setTimeout(() => {
      if (contents.isDestroyed()) return;
      // Only if nothing else has claimed the view in the meantime — the user may
      // have hit reload, or a notification may have opened a conversation.
      // A *failed* navigation leaves the attempted URL in place, so matching it
      // is what "still here" looks like; anything else means someone moved on.
      const now = contents.getURL();
      if (now && now !== validatedURL) return;
      void contents.loadURL(validatedURL).catch(() => {
        /* did-fail-load runs again and takes it from there */
      });
    }, 1_200);
    return;
  }

  void showOfflineScreen(contents, errorDescription);
}

async function showOfflineScreen(
  contents: Electron.WebContents,
  reason: string,
): Promise<void> {
  const report = await checkConnection();
  if (contents.isDestroyed()) return;
  // The probe may well have succeeded — a stale DNS answer fails one navigation
  // while the network is fine. Take the win rather than showing an error.
  if (report.state === 'online') {
    silentRetried = false;
    void loadApp();
    return;
  }
  watchUntilOnline();
  await contents.loadFile(rendererFile('offline.html'), { query: { reason } });
}

/** Navigate the web app view to a route. */
export async function loadApp(
  pathname: string = ROUTES.chat,
  query: Record<string, string> = {},
): Promise<void> {
  // Nothing to navigate to before the user has named their instance. This is
  // reachable from a menu item or a stale window, not just first run.
  if (!getSettings().appOrigin) {
    showServerWindow();
    return;
  }
  createMainWindow();
  const contents = getAppContents();
  if (!contents) return;
  // A deliberate navigation — the menu, a notification, "Try again" — starts a
  // fresh episode and is allowed its own silent retry.
  silentRetried = false;
  await contents.loadURL(appUrl(pathname, query)).catch((err: NodeJS.ErrnoException) => {
    // ERR_ABORTED means another navigation superseded this one — routine when
    // the user clicks through quickly, not something to report.
    if (err?.code === 'ERR_ABORTED') return;
    logger.warn('navigation failed', err);
  });
}

export function showMainWindow(options: { sessionId?: string } = {}): void {
  const target = createMainWindow();
  if (options.sessionId) {
    void loadApp(ROUTES.chat, { s: options.sessionId });
  } else if (getAppContents()?.getURL().startsWith('file:')) {
    // Sitting on the offline screen: showing the window means "try again".
    void loadApp();
  }
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
  if (process.platform === 'darwin') app.dock?.show();
}

/**
 * Bring the app to the front, on the screen the user is actually looking at.
 *
 * "To the top" is the easy half. The rest is that on a multi-display desk the
 * window is usually on the *other* one, and a shortcut that raises a window you
 * cannot see is indistinguishable from a shortcut that did nothing — so it moves
 * to the display under the cursor, and on macOS onto the current Space.
 */
export function summonMainWindow(): void {
  const target = createMainWindow();
  const cursor = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(cursor).workArea;
  const bounds = target.getBounds();

  const alreadyThere =
    bounds.x + bounds.width / 2 >= area.x &&
    bounds.x + bounds.width / 2 <= area.x + area.width &&
    bounds.y + bounds.height / 2 >= area.y &&
    bounds.y + bounds.height / 2 <= area.y + area.height;

  if (!alreadyThere) {
    const width = Math.min(bounds.width, area.width);
    const height = Math.min(bounds.height, area.height);
    target.setBounds({
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + (area.height - height) / 2),
      width,
      height,
    });
  }

  if (target.isMinimized()) target.restore();

  // macOS keeps a window on the Space it was opened in. Briefly claiming all
  // Spaces drags it to the one in front of the user, which is the point.
  if (process.platform === 'darwin') {
    target.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    target.show();
    target.focus();
    setTimeout(() => {
      if (!target.isDestroyed()) target.setVisibleOnAllWorkspaces(false);
    }, 300);
    app.dock?.show();
    app.focus({ steal: true });
  } else {
    target.show();
    target.focus();
  }
}

/**
 * Raise and focus, for the web app's notification-click handler —
 * `window.focus()` from a renderer does not reliably un-minimise a window
 * (docs/desktop-notifications §3).
 */
export function focusMainWindow(): void {
  const target = createMainWindow();
  if (target.isMinimized()) target.restore();
  if (!target.isVisible()) target.show();
  target.focus();
  if (process.platform === 'darwin') {
    app.dock?.show();
    app.focus({ steal: true });
  }
}

export function reloadApp(): void {
  const contents = getAppContents();
  if (!contents) return;
  if (contents.getURL().startsWith('file:')) void loadApp();
  else contents.reload();
}
