/**
 * Native notifications, for the four things in spec §7.3 and nothing else.
 * Explicitly *not* per file synced.
 */
import { Notification } from 'electron';
import { showMainWindow } from './windows/main-window';
import { showStatusWindow } from './windows/status-window';
import logger from './logger';

const supported = (): boolean => Notification.isSupported();

function show(options: Electron.NotificationConstructorOptions, onClick: () => void): void {
  if (!supported()) return;
  try {
    const n = new Notification(options);
    n.on('click', onClick);
    n.show();
  } catch (err) {
    logger.warn('notification failed', err);
  }
}

/*
 * Nothing here for "the agent answered": the quick bar runs the web app's own
 * /quick route, which holds the event stream and raises that itself. A second
 * path in the shell would notify twice (docs/desktop-notifications §1).
 */

/** A screenshot taken by the global shortcut landed in the open conversation. */
export function notifyCaptureAttached(): void {
  show(
    { title: 'Screenshot attached', body: 'Added to your open Redstone conversation.' },
    () => showMainWindow(),
  );
}

/** A sync conflict — both copies were kept. */
export function notifyConflict(folderName: string, relPath: string): void {
  show(
    {
      title: `Conflict in ${folderName}`,
      body: `Both versions of "${relPath}" were kept. Redstone's copy sits beside yours.`,
    },
    () => showStatusWindow(),
  );
}

/** A sync error that needs a human. */
export function notifySyncError(folderName: string, message: string): void {
  show({ title: `Sync problem in ${folderName}`, body: message }, () => showStatusWindow());
}

/** The token expired; only the web app can fix it. */
export function notifySignedOut(): void {
  show(
    { title: 'Sign in again', body: 'Redstone paused syncing until you sign in.' },
    () => showMainWindow(),
  );
}
