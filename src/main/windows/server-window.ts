/**
 * The window that asks which Redstone instance to talk to.
 *
 * It is the first thing a fresh install shows — before the login form, because
 * the login form lives on the server the user has not named yet — and it comes
 * back from "Switch Server…". A local page, deliberately: at this point there is
 * no origin to load anything remote from.
 */
import { BrowserWindow } from 'electron';
import path from 'node:path';
import { SESSION_PARTITION } from '../../shared/constants';
import { guardWebContents } from '../security';
import { preloadPath } from './main-window';

let win: BrowserWindow | null = null;

export function getServerWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

export function showServerWindow(): BrowserWindow {
  const existing = getServerWindow();
  if (existing) {
    existing.show();
    existing.focus();
    return existing;
  }

  win = new BrowserWindow({
    width: 520,
    // Tall enough for the first-run screen plus a few remembered servers; the
    // page scrolls if the list grows past that.
    height: 680,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'Connect to Redstone',
    backgroundColor: '#15110D',
    // Frameless on macOS so the brand panel reads as one surface; the CSS marks
    // the background as a drag region.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 14, y: 16 } : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: SESSION_PARTITION,
      preload: preloadPath(),
    },
  });

  guardWebContents(win.webContents);
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => {
    win = null;
  });
  void win.loadFile(path.join(__dirname, '../renderer/server.html'));
  return win;
}

export function closeServerWindow(): void {
  getServerWindow()?.close();
}
