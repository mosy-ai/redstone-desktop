/**
 * Global shortcuts (spec §7.1, §7.2).
 *
 * `globalShortcut.register` returns false when another app already owns the
 * combination — that must be reported, not swallowed, or the user is left
 * pressing a key that does nothing.
 */
import { app, globalShortcut, dialog } from 'electron';
import { getSettings, updateSettings } from './settings';
import { toggleQuickWindow } from './windows/quick-window';
import { captureToActiveSession } from './capture';
import { summonMainWindow } from './windows/main-window';
import logger from './logger';

export type ShortcutName = 'quickBar' | 'capture' | 'summon';
type Registered = Record<ShortcutName, string | null>;

const registered: Registered = { quickBar: null, capture: null, summon: null };

export function registeredShortcuts(): Registered {
  return { ...registered };
}

function tryRegister(accelerator: string, handler: () => void): boolean {
  try {
    if (!accelerator) return false;
    if (globalShortcut.isRegistered(accelerator)) return false;
    return globalShortcut.register(accelerator, handler);
  } catch (err) {
    logger.warn('shortcut registration threw', { accelerator, err });
    return false;
  }
}

export function applyShortcuts(options: { announceFailures?: boolean } = {}): void {
  // Reachable before `ready` if the app is quit mid-launch, and globalShortcut
  // throws outright there rather than returning false.
  if (!app.isReady()) return;
  globalShortcut.unregisterAll();
  registered.quickBar = null;
  registered.capture = null;
  registered.summon = null;

  const { shortcuts } = getSettings();
  const failures: string[] = [];

  if (tryRegister(shortcuts.quickBar, () => void toggleQuickWindow())) {
    registered.quickBar = shortcuts.quickBar;
  } else {
    failures.push(`${shortcuts.quickBar} (quick bar)`);
  }

  if (tryRegister(shortcuts.capture, () => void captureToActiveSession())) {
    registered.capture = shortcuts.capture;
  } else {
    failures.push(`${shortcuts.capture} (screen capture)`);
  }

  if (tryRegister(shortcuts.summon, () => summonMainWindow())) {
    registered.summon = shortcuts.summon;
  } else {
    failures.push(`${shortcuts.summon} (bring Redstone to the front)`);
  }

  if (failures.length) {
    logger.warn('shortcuts unavailable', failures);
    if (options.announceFailures) {
      void dialog.showMessageBox({
        type: 'warning',
        title: 'Shortcut unavailable',
        message: 'Another app already uses these shortcuts',
        detail: `${failures.join('\n')}\n\nChange them in Redstone's settings.`,
        buttons: ['OK'],
      });
    }
  }
}

/** Change a shortcut and re-register. Returns false if the new one is taken. */
export function setShortcut(which: ShortcutName, accelerator: string): boolean {
  if (!app.isReady()) return false;
  const previous = getSettings().shortcuts;
  updateSettings({ shortcuts: { ...previous, [which]: accelerator } });
  applyShortcuts();
  const ok = registeredShortcuts()[which] === accelerator;
  if (!ok) {
    updateSettings({ shortcuts: previous });
    applyShortcuts();
  }
  return ok;
}

export function releaseShortcuts(): void {
  // Quitting during startup lands here before `ready`, where touching
  // globalShortcut throws — and an exception on the quit path becomes a native
  // "A JavaScript error occurred in the main process" dialog.
  if (!app.isReady()) return;
  globalShortcut.unregisterAll();
}
