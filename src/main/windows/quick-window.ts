/**
 * The quick chat bar (spec §7.1).
 *
 * A thin container around the web app's `/quick` route, which keeps streaming,
 * markdown, citations, i18n and model routing identical to the main app for
 * free. The shell contributes the window, the global shortcut and the screen
 * capture; the page contributes everything a user reads.
 *
 * Redstone is self-hostable, so an older server may not serve `/quick` at all.
 * That case gets a one-line notice rather than a second chat UI inside the
 * shell — see `src/renderer/quick/quick.html`.
 */
import { BrowserWindow, screen, app } from 'electron';
import path from 'node:path';
import { QUICK_BAR, ROUTES, SESSION_PARTITION, TOKEN_COOKIE } from '../../shared/constants';
import { appUrl } from '../settings';
import { guardWebContents } from '../security';
import { getToken } from '../auth';
import { discardPendingCapture } from '../capture';
import { setQuickSession } from '../attachments';
import { preloadPath } from './main-window';
import logger from '../logger';

let win: BrowserWindow | null = null;
let quickRouteAvailable: boolean | null = null;
let streaming = false;

export function getQuickWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

export function setQuickStreaming(active: boolean): void {
  streaming = active;
}

/**
 * Does the web app serve `/quick` yet? Probed once per run.
 *
 * Two traps here, both hit in practice. The route is guarded by the web app's
 * middleware, which reads the **cookie** — a bearer header alone gets bounced —
 * and it answers a 307 to `/login` rather than a 404 when it is not satisfied.
 * So only a 2xx counts: anything else and the bar would end up rendering a login
 * page inside a 720×72 window.
 */
async function hasQuickRoute(): Promise<boolean> {
  if (quickRouteAvailable !== null) return quickRouteAvailable;
  try {
    const token = await getToken();
    const headers: Record<string, string> = {};
    if (token) {
      headers.Authorization = `Bearer ${token}`;
      headers.Cookie = `${TOKEN_COOKIE}=${encodeURIComponent(token)}`;
    }
    const res = await fetch(appUrl(ROUTES.quick, { client: 'desktop' }), {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(4_000),
      redirect: 'manual',
    });
    quickRouteAvailable = res.status >= 200 && res.status < 300;
  } catch {
    quickRouteAvailable = false;
  }
  logger.info(`quick route ${quickRouteAvailable ? 'available' : 'not available — using local bar'}`);
  return quickRouteAvailable;
}

function position(target: BrowserWindow): void {
  const cursor = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(cursor).workArea;
  const [width = QUICK_BAR.width, height = QUICK_BAR.collapsedHeight] = target.getSize();
  target.setPosition(
    Math.round(area.x + (area.width - width) / 2),
    Math.round(area.y + area.height * QUICK_BAR.topFraction - height / 2),
  );
}

export async function createQuickWindow(): Promise<BrowserWindow> {
  const existing = getQuickWindow();
  if (existing) return existing;

  win = new BrowserWindow({
    width: QUICK_BAR.width,
    // Opens at the expanded height: the page decides how tall it wants to be by
    // calling `resizeQuickBar`, and until it does, a too-tall bar merely looks
    // roomy while a too-short one would clip the answer.
    height: QUICK_BAR.expandedHeight,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    // Keep it out of the window list on macOS so Cmd-Tab is unaffected.
    type: process.platform === 'darwin' ? 'panel' : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: SESSION_PARTITION,
      preload: preloadPath(),
    },
  });

  guardWebContents(win.webContents);
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.on('blur', () => {
    // Blur hides — unless an answer is still streaming (spec §7.1).
    if (!streaming) hideQuickWindow();
  });
  win.on('closed', () => {
    win = null;
  });

  if (await hasQuickRoute()) {
    await win.loadURL(appUrl(ROUTES.quick, { client: 'desktop' }));
  } else {
    logger.info('this server has no /quick route — showing the unsupported notice');
    await win.loadFile(path.join(__dirname, '../renderer/quick.html'));
  }

  position(win);
  return win;
}

export async function showQuickWindow(): Promise<void> {
  const target = await createQuickWindow();
  position(target);
  target.showInactive();
  target.focus();
  target.webContents.focus();
}

export function hideQuickWindow(): void {
  const target = getQuickWindow();
  if (!target) return;
  streaming = false;
  // Whatever was held for this bar is gone with it: a screenshot the user never
  // sent should not survive to surprise them in the next conversation.
  discardPendingCapture();
  setQuickSession(null);
  target.hide();
  resizeQuickWindow(QUICK_BAR.collapsedHeight);
  // Hand focus back to whatever the user was in — but only if the bar was the
  // last thing we had on screen, or this would hide the main window too.
  const othersVisible = BrowserWindow.getAllWindows().some((w) => w !== target && w.isVisible());
  if (process.platform === 'darwin' && !othersVisible) app.hide?.();
}

export async function toggleQuickWindow(): Promise<void> {
  const target = getQuickWindow();
  if (target?.isVisible()) hideQuickWindow();
  else await showQuickWindow();
}

export function resizeQuickWindow(height: number): void {
  const target = getQuickWindow();
  if (!target) return;
  const clamped = Math.max(QUICK_BAR.collapsedHeight, Math.min(height, QUICK_BAR.expandedHeight));
  const [width = QUICK_BAR.width] = target.getSize();
  target.setSize(width, Math.round(clamped), false);
  position(target);
}

export function sendToQuick(channel: string, payload: unknown): void {
  getQuickWindow()?.webContents.send(channel, payload);
}
