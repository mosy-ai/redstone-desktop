/**
 * Sync status window: which folders are linked, what state they are in, and the
 * three actions that belong to the shell (reveal, pause, unlink).
 *
 * Not a file browser (spec §12) — it lists links, not files. The OS file manager
 * is the file browser.
 */
import { BrowserWindow } from 'electron';
import path from 'node:path';
import { SESSION_PARTITION } from '../../shared/constants';
import { guardWebContents } from '../security';
import { preloadPath } from './main-window';

let win: BrowserWindow | null = null;

export function getStatusWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

export function showStatusWindow(): BrowserWindow {
  const existing = getStatusWindow();
  if (existing) {
    existing.show();
    existing.focus();
    return existing;
  }

  win = new BrowserWindow({
    width: 640,
    height: 520,
    minWidth: 480,
    minHeight: 360,
    show: false,
    title: 'Redstone folders',
    backgroundColor: '#12141a',
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
  void win.loadFile(path.join(__dirname, '../renderer/status.html'));
  return win;
}
