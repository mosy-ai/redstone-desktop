/**
 * Microphone access, which needs two separate yeses on macOS: the page's
 * permission request (Chromium) and the operating system's TCC grant. Answering
 * only the first is what makes an app say "no microphone detected" while the
 * same site works in a browser — the browser already holds the OS grant.
 */
import { dialog, shell, systemPreferences } from 'electron';
import logger from './logger';

const SETTINGS_DEEP_LINK =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';

let explaining = false;

export async function ensureMicrophoneAccess(): Promise<boolean> {
  if (process.platform !== 'darwin') return true;

  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') return true;

  if (status === 'not-determined') {
    // Triggers the system prompt, once. The answer is remembered by macOS.
    const granted = await systemPreferences.askForMediaAccess('microphone');
    logger.info(`microphone access ${granted ? 'granted' : 'refused'} by the system prompt`);
    return granted;
  }

  // Denied or restricted: only System Settings can undo it, so say so rather
  // than failing silently a second time.
  if (!explaining) {
    explaining = true;
    void dialog
      .showMessageBox({
        type: 'info',
        title: 'Microphone access is turned off',
        message: 'macOS is blocking Redstone from using the microphone',
        detail:
          'Open System Settings → Privacy & Security → Microphone and turn Redstone on. ' +
          'You may need to reopen Redstone afterwards.',
        buttons: ['Open System Settings', 'Not now'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) void shell.openExternal(SETTINGS_DEEP_LINK);
      })
      .finally(() => {
        explaining = false;
      });
  }
  return false;
}

export function microphoneStatus(): string {
  if (process.platform !== 'darwin') return 'granted';
  return systemPreferences.getMediaAccessStatus('microphone');
}
