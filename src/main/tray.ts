/**
 * Tray: sync state at a glance, plus the actions worth reaching without the
 * main window.
 */
import { Menu, Tray, app, nativeImage } from 'electron';
import path from 'node:path';
import type { LinkStatus } from '../shared/types';
import { showMainWindow, summonMainWindow } from './windows/main-window';
import { showPreferencesWindow } from './windows/preferences-window';
import { registeredShortcuts } from './shortcuts';
import { showStatusWindow } from './windows/status-window';
import { toggleQuickWindow } from './windows/quick-window';
import { openFolderFlow } from './folder-flow';
import { linkFolderToSession } from './session-folder';
import { getActiveSession } from './attachments';
import { syncEngine } from './sync/engine';
import { showError } from './dialogs';
import logger from './logger';

let tray: Tray | null = null;

const summarise = (statuses: LinkStatus[]): string => {
  if (statuses.length === 0) return 'No folders linked';
  if (statuses.some((s) => s.state === 'signed_out')) return 'Sign in again';
  const conflicts = statuses.reduce((n, s) => n + s.conflicts.length, 0);
  if (conflicts) return `Conflicts (${conflicts})`;
  if (statuses.some((s) => s.state === 'error')) return 'Sync error';
  const pending = statuses.reduce((n, s) => n + s.pending, 0);
  if (pending) return `Syncing (${pending} file${pending === 1 ? '' : 's'})`;
  if (statuses.every((s) => s.state === 'paused')) return 'Paused';
  return 'Synced';
};

export function createTray(): void {
  if (tray) return;
  const iconPath = path.join(__dirname, '../renderer/tray.png');
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    // Packaging without the asset must not crash startup.
    logger.warn('tray icon missing');
    image = nativeImage.createEmpty();
  }
  const scaled = image.isEmpty() ? image : image.resize({ width: 18, height: 18 });
  if (process.platform === 'darwin') scaled.setTemplateImage(true);

  tray = new Tray(scaled);
  tray.setToolTip('Redstone');
  refreshTray();
  tray.on('click', () => (process.platform === 'darwin' ? tray?.popUpContextMenu() : showMainWindow()));
}

/** macOS renders accelerators in tray menus as plain text, so spell them out. */
const accel = (key: string | null): string =>
  key
    ? `  (${key
        .replace('CommandOrControl', '⌘')
        .replace('Command', '⌘')
        .replace('Control', '⌃')
        .replace('Alt', '⌥')
        .replace('Shift', '⇧')
        .replace(/\+/g, '')})`
    : '';

export function refreshTray(): void {
  if (!tray) return;
  const shortcuts = registeredShortcuts();
  const statuses = syncEngine.statuses();
  const summary = summarise(statuses);
  tray.setToolTip(`Redstone — ${summary}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Redstone — ${summary}`, enabled: false },
      { type: 'separator' },
      {
        label: `Open Redstone${accel(shortcuts.summon)}`,
        click: () => summonMainWindow(),
      },
      {
        label: `Quick Chat Bar${accel(shortcuts.quickBar)}`,
        click: () => void toggleQuickWindow(),
      },
      { type: 'separator' },
      {
        label: 'Link a Folder to This Chat…',
        click: () => {
          const sessionId = getActiveSession();
          const run = sessionId
            ? linkFolderToSession(sessionId, null)
            : openFolderFlow(null).then((r) => r.status);
          void run.catch((err) => showError('Could not link that folder', err));
        },
      },
      { label: 'Folder Sync Status…', click: () => showStatusWindow() },
      { label: 'Settings…', click: () => showPreferencesWindow() },
      { label: 'Sync Now', enabled: statuses.length > 0, click: () => syncEngine.syncAll() },
      { type: 'separator' },
      { label: 'Quit Redstone', click: () => app.quit() },
    ]),
  );
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}
