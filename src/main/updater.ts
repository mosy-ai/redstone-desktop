/**
 * Auto-update (spec §10): check on launch and every 6 hours, never force a
 * restart mid-turn — prompt, and default to applying on next launch.
 */
import { app, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';
import { UPDATE_CHECK_INTERVAL_MS } from '../shared/constants';
import { getSettings } from './settings';
import logger from './logger';

let timer: NodeJS.Timeout | null = null;
let prompting = false;

export function initUpdater(): void {
  if (!app.isPackaged) {
    logger.info('updater disabled in development');
    return;
  }
  autoUpdater.logger = logger;
  autoUpdater.autoDownload = true;
  // The safe default: the update lands the next time the app starts.
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => logger.warn('update check failed', err));
  autoUpdater.on('update-available', (info) => logger.info(`update available: ${info.version}`));
  autoUpdater.on('update-downloaded', (info) => void offerRestart(info.version));

  void checkForUpdates();
  timer = setInterval(() => void checkForUpdates(), UPDATE_CHECK_INTERVAL_MS);
  timer.unref?.();
}

export async function checkForUpdates(opts: { interactive?: boolean } = {}): Promise<void> {
  if (!app.isPackaged) {
    if (opts.interactive) {
      await dialog.showMessageBox({
        type: 'info',
        title: 'Updates',
        message: 'Updates are only checked in packaged builds.',
        buttons: ['OK'],
      });
    }
    return;
  }
  if (!getSettings().autoUpdate && !opts.interactive) return;

  try {
    const result = await autoUpdater.checkForUpdates();
    if (opts.interactive && !result?.updateInfo) {
      await dialog.showMessageBox({
        type: 'info',
        title: 'Updates',
        message: `Redstone ${app.getVersion()} is up to date.`,
        buttons: ['OK'],
      });
    }
  } catch (err) {
    logger.warn('update check failed', err);
    if (opts.interactive) {
      await dialog.showMessageBox({
        type: 'warning',
        title: 'Updates',
        message: 'Could not check for updates right now.',
        buttons: ['OK'],
      });
    }
  }
}

async function offerRestart(version: string): Promise<void> {
  if (prompting) return;
  prompting = true;
  try {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Update ready',
      message: `Redstone ${version} is ready to install`,
      detail: 'Restarting now takes a few seconds. Otherwise it installs the next time you quit.',
      buttons: ['Install on Next Launch', 'Restart Now'],
      defaultId: 0,
      cancelId: 0,
    });
    if (response === 1) {
      setImmediate(() => autoUpdater.quitAndInstall(false, true));
    }
  } finally {
    prompting = false;
  }
}

export function stopUpdater(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
