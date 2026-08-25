/**
 * Screen capture (spec §7.2).
 *
 * Non-negotiables encoded here:
 *   - capture happens only on an explicit user action, never on a schedule;
 *   - the user sees the exact image before it is sent;
 *   - the temp file is deleted after upload;
 *   - nothing is captured while the screen is locked.
 */
import {
  BrowserWindow,
  desktopCapturer,
  dialog,
  webContents,
  nativeImage,
  screen,
  shell,
  systemPreferences,
  powerMonitor,
  ipcMain,
} from 'electron';
import path from 'node:path';
import { IPC, type AttachmentRef } from '../shared/types';
import { SESSION_PARTITION } from '../shared/constants';
import { getActiveSession, getQuickSession, uploadBuffer } from './attachments';
import { getQuickWindow } from './windows/quick-window';
import { notifyCaptureAttached } from './notifications';
import { preloadPath } from './windows/main-window';
import { guardWebContents } from './security';
import logger from './logger';

const SETTINGS_DEEP_LINK =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

export interface CaptureResult {
  /** PNG bytes — held in memory, written to disk only if a preview needs a URL. */
  png: Buffer;
  label: string;
}

/** True when the platform will actually hand us pixels. */
async function ensurePermission(): Promise<boolean> {
  if (process.platform !== 'darwin') return true;
  const status = systemPreferences.getMediaAccessStatus('screen');
  if (status === 'granted') return true;

  // macOS only lists an app under Screen Recording after it has *attempted* a
  // capture, so the attempt itself is part of the flow (spec §7.2).
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: 'Screen Recording permission needed',
    message: 'Redstone needs permission to capture your screen',
    detail:
      'Open System Settings → Privacy & Security → Screen Recording and enable Redstone. ' +
      'macOS requires the app to restart after you grant it.',
    buttons: ['Open System Settings', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) await shell.openExternal(SETTINGS_DEEP_LINK);
  return false;
}

/**
 * Grab a screen or window. Returns null if the user cancelled, the screen is
 * locked, or permission is missing.
 */
export async function captureScreen(): Promise<CaptureResult | null> {
  // Never capture a lock screen.
  if (powerMonitor.getSystemIdleState(1) === 'locked') {
    logger.info('capture skipped: screen locked');
    return null;
  }

  const displays = screen.getAllDisplays();
  const scale = Math.max(...displays.map((d) => d.scaleFactor), 1);
  const bounds = displays[0]?.bounds ?? { width: 1920, height: 1080 };

  let sources: Electron.DesktopCapturerSource[] = [];
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: {
        width: Math.round(bounds.width * Math.min(scale, 2)),
        height: Math.round(bounds.height * Math.min(scale, 2)),
      },
      fetchWindowIcons: false,
    });
  } catch (err) {
    logger.warn('desktopCapturer failed', err);
  }

  const usable = sources.filter((s) => !s.thumbnail.isEmpty());
  if (usable.length === 0) {
    // Empty or black results on macOS mean the TCC grant is missing.
    await ensurePermission();
    return null;
  }

  const screens = usable.filter((s) => s.id.startsWith('screen:'));
  const chosen = screens.length === 1 && usable.length === 1 ? screens[0] : await pickSource(usable);
  if (!chosen) return null;

  return { png: chosen.thumbnail.toPNG(), label: chosen.name };
}

/** Modal picker listing every screen and window with a live thumbnail. */
async function pickSource(
  sources: Electron.DesktopCapturerSource[],
): Promise<Electron.DesktopCapturerSource | null> {
  const parent = BrowserWindow.getFocusedWindow();
  const picker = new BrowserWindow({
    width: 860,
    height: 560,
    parent: parent ?? undefined,
    modal: Boolean(parent),
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Choose what to capture',
    backgroundColor: '#12141a',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: SESSION_PARTITION,
      preload: preloadPath(),
    },
  });
  guardWebContents(picker.webContents);

  const payload = sources.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.id.startsWith('screen:') ? 'screen' : 'window',
    thumbnail: s.thumbnail.resize({ width: 320 }).toDataURL(),
  }));

  return new Promise((resolve) => {
    let settled = false;
    const finish = (id: string | null): void => {
      if (settled) return;
      settled = true;
      ipcMain.removeHandler(IPC.captureSources);
      ipcMain.removeAllListeners(IPC.captureChoose);
      ipcMain.removeAllListeners(IPC.captureCancel);
      if (!picker.isDestroyed()) picker.close();
      resolve(id ? (sources.find((s) => s.id === id) ?? null) : null);
    };

    ipcMain.handle(IPC.captureSources, () => payload);
    ipcMain.on(IPC.captureChoose, (_e, id: string) => finish(typeof id === 'string' ? id : null));
    ipcMain.on(IPC.captureCancel, () => finish(null));
    picker.on('closed', () => finish(null));

    void picker.loadFile(path.join(__dirname, '../renderer/capture.html'));
    picker.once('ready-to-show', () => picker.show());
  });
}

/**
 * Capture, show the user exactly what will be sent, and upload only if they
 * confirm. Returns null on cancel.
 */
export async function captureAndConfirm(sessionId?: string): Promise<AttachmentRef | null> {
  const shot = await captureScreen();
  if (!shot) return null;
  if (!(await confirmShot(shot))) return null;
  return uploadCapture(shot, sessionId);
}

/** "Never send a capture the user has not seen" (spec §7.2), in one place. */
async function confirmShot(shot: CaptureResult): Promise<boolean> {
  const preview = nativeImage.createFromBuffer(shot.png);
  const { response } = await dialog.showMessageBox({
    type: 'none',
    icon: preview.resize({ width: 480 }),
    title: 'Send this capture?',
    message: `Send this capture of “${shot.label}” to Redstone?`,
    detail: 'Nothing is uploaded until you choose Send.',
    buttons: ['Send', 'Discard'],
    defaultId: 0,
    cancelId: 1,
  });
  return response === 0;
}

/**
 * What the capture shortcut does: grab the screen, show the user exactly what
 * will be sent, upload it to the conversation they are in, and tell the web app
 * so it can put the chip in its composer.
 *
 * The notification is not decoration — the shortcut can be pressed while the app
 * has no window on screen, and a silent upload would be indistinguishable from a
 * shortcut that did nothing.
 */
export async function captureToActiveSession(): Promise<AttachmentRef | null> {
  // Whichever surface the user is looking at owns the screenshot. The bar is
  // summoned over other apps, so if it is up, it is what they mean.
  const bar = getQuickWindow();
  const targetingBar = Boolean(bar?.isVisible());
  const sessionId = targetingBar ? getQuickSession() : getActiveSession();

  if (!sessionId && !targetingBar) {
    // Nothing to attach to, and nowhere for the shot to wait. Say so rather than
    // capturing and discarding.
    void dialog.showMessageBox({
      type: 'info',
      title: 'Open a conversation first',
      message: 'Open a Redstone conversation, then press the capture shortcut',
      detail: 'A screenshot is attached to a conversation, so there has to be one open.',
      buttons: ['OK'],
    });
    return null;
  }

  const shot = await captureScreen();
  if (!shot) return null;
  if (!(await confirmShot(shot))) return null;

  if (!sessionId) {
    // The bar has not created its conversation yet (it does that on first send).
    // Hold the bytes rather than posting them into the main window's chat, which
    // is not the conversation the user is having.
    pendingForQuickBar = shot;
    logger.info('capture held until the quick bar has a conversation');
    return null;
  }

  return deliver(shot, sessionId, targetingBar ? bar?.webContents : undefined);
}

/** A confirmed capture waiting for the quick bar to claim a conversation. */
let pendingForQuickBar: CaptureResult | null = null;

/** Called when the bar reports its session — upload what was waiting. */
export async function flushPendingCapture(sessionId: string): Promise<void> {
  const shot = pendingForQuickBar;
  if (!shot) return;
  pendingForQuickBar = null;
  await deliver(shot, sessionId, getQuickWindow()?.webContents).catch((err) =>
    logger.warn('held capture could not be uploaded', err),
  );
}

/** The bar closed without sending: the bytes go no further. */
export function discardPendingCapture(): void {
  if (!pendingForQuickBar) return;
  pendingForQuickBar = null;
  logger.info('held capture discarded — the quick bar closed');
}

async function deliver(
  shot: CaptureResult,
  sessionId: string,
  target?: Electron.WebContents,
): Promise<AttachmentRef> {
  const ref = await uploadCapture(shot, sessionId);
  // `onFilesDropped` is the existing bridge event for "the shell just attached
  // something" — reused rather than inventing a second channel. Sent to the
  // surface that owns the conversation, so the chip appears in the right
  // composer.
  if (target && !target.isDestroyed()) {
    target.send(IPC.filesDropped, [ref]);
  } else {
    for (const contents of webContents.getAllWebContents()) {
      if (!contents.isDestroyed()) contents.send(IPC.filesDropped, [ref]);
    }
  }
  notifyCaptureAttached();
  return ref;
}

/**
 * Upload a capture. Spec §7.2 asks for the temp file to be deleted after upload;
 * the stronger version is what happens here — the PNG never reaches disk at all,
 * so there is nothing to leak if the upload fails or the app is killed.
 */
export async function uploadCapture(shot: CaptureResult, sessionId?: string): Promise<AttachmentRef> {
  const filename = `screen-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
  return uploadBuffer(filename, shot.png, sessionId ? { sessionId } : {});
}
