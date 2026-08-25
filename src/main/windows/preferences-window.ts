/**
 * Desktop settings: the shortcuts, launch-at-login, and which server this app
 * talks to. Everything about the *account* stays in the web app — this window
 * links there rather than reimplementing it.
 *
 * It exists because a global shortcut has nowhere else to live: it belongs to
 * the app, not to a conversation, and a browser tab cannot own one.
 */
import { BrowserWindow } from 'electron';
import path from 'node:path';
import { SESSION_PARTITION } from '../../shared/constants';
import { guardWebContents } from '../security';
import { preloadPath } from './main-window';

let win: BrowserWindow | null = null;

export function getPreferencesWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

export function showPreferencesWindow(): BrowserWindow {
  const existing = getPreferencesWindow();
  if (existing) {
    existing.show();
    existing.focus();
    return existing;
  }

  win = new BrowserWindow({
    width: 520,
    height: 640,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'Redstone Settings',
    backgroundColor: '#15110D',
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
  void win.loadFile(path.join(__dirname, '../renderer/preferences.html'));
  return win;
}
