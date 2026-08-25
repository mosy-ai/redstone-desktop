/**
 * Moving the app from one Redstone instance to another.
 *
 * The order matters. Sync has to stop before the origin changes, or an in-flight
 * cycle finishes against the new server with the old server's state — which is
 * how you upload one company's files into another's folder. Everything else
 * (windows, tray, shortcuts) is safe to point at the new origin afterwards.
 *
 * Links are not discarded on a switch: they belong to the server they were made
 * on and start syncing again when the user comes back to it.
 */
import { setActiveServer } from './servers';
import { syncEngine } from './sync/engine';
import { setActiveSession } from './attachments';
import { loadApp, getMainWindow, showMainWindow } from './windows/main-window';
import { closeServerWindow } from './windows/server-window';
import { hideQuickWindow } from './windows/quick-window';
import { refreshTray } from './tray';
import logger from './logger';

export async function connectToServer(origin: string, name?: string): Promise<void> {
  logger.info(`connecting to server${getMainWindow() ? '' : ' (first run)'}`);

  // 1. Stop touching files against the old origin.
  await syncEngine.stop();

  // 2. Point the app at the new one. Everything that reads `settings.appOrigin`
  //    — the API client, the navigation allowlist, the quick bar — follows.
  await setActiveServer(origin, name);

  // 3. The old server's conversation is meaningless here.
  setActiveSession(null);
  hideQuickWindow();

  // 4. Show the app. Creating the window navigates it, so a second loadApp here
  //    would abort the first one mid-flight (ERR_ABORTED) for no gain; only an
  //    existing window — the switch-server case — needs pointing at the new
  //    origin.
  closeServerWindow();
  const existing = getMainWindow();
  showMainWindow();
  if (existing) await loadApp();

  // 5. Sync resumes for the links that belong to this server.
  await syncEngine.start();
  refreshTray();
}
