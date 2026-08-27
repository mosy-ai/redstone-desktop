/** User settings: origin, shortcuts, update and sync preferences. */
import { app } from 'electron';
import type { Settings } from '../shared/types';
import { SYNC } from '../shared/constants';
import { JsonStore, userDataFile } from './store';
import logger from './logger';

const defaults = (): Settings => ({
  // Empty by design: Redstone is self-hostable and regional, so the instance is
  // something the user tells us on first run (see servers.ts). REDSTONE_ORIGIN
  // skips that screen when developing against a known deployment.
  appOrigin: process.env.REDSTONE_ORIGIN?.replace(/\/+$/, '') || '',
  shortcuts: {
    quickBar: process.platform === 'darwin' ? 'Command+Shift+Space' : 'Control+Shift+Space',
    capture: process.platform === 'darwin' ? 'Command+Shift+1' : 'Control+Shift+1',
    // Deliberately not Cmd/Ctrl+Shift+R: a *global* shortcut outranks every app,
    // and that one is hard-reload in every browser.
    summon: process.platform === 'darwin' ? 'Command+Alt+R' : 'Control+Alt+R',
  },
  quickBarContinuesLastSession: false,
  autoUpdate: true,
  launchAtLogin: false,
  allowedOrigins: [],
  maxSyncFileBytes: SYNC.maxFileBytes,
  preferredMicrophoneId: '',
  reduceBackgroundAnimation: false,
});

let store: JsonStore<Settings> | null = null;

export async function initSettings(): Promise<void> {
  const fallback = defaults();
  store = await JsonStore.open<Settings>(userDataFile('settings.json'), fallback);

  // The snapshot merge is shallow, so a settings.json written before a new
  // shortcut existed replaces the whole `shortcuts` object and the new one comes
  // back undefined — which registers as `undefined` and fails silently on every
  // launch. Nested defaults have to be filled in explicitly.
  store.update((draft) => {
    draft.shortcuts = { ...fallback.shortcuts, ...draft.shortcuts };
  });
  await store.flush();

  applyLaunchAtLogin(getSettings().launchAtLogin);
}

export function getSettings(): Settings {
  if (!store) throw new Error('settings not initialised');
  return store.get() as Settings;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  if (!store) throw new Error('settings not initialised');
  store.update((draft) => {
    Object.assign(draft, patch);
    if (patch.appOrigin) draft.appOrigin = patch.appOrigin.replace(/\/+$/, '');
    if (patch.shortcuts) draft.shortcuts = { ...draft.shortcuts, ...patch.shortcuts };
  });
  if (patch.launchAtLogin !== undefined) applyLaunchAtLogin(patch.launchAtLogin);
  logger.info('settings updated', Object.keys(patch));
  return getSettings();
}

export function flushSettings(): Promise<void> {
  return store ? store.flush() : Promise.resolve();
}

export function apiBase(): string {
  return `${getSettings().appOrigin}/api/v1`;
}

export function appUrl(pathname: string, query: Record<string, string> = {}): string {
  const url = new URL(pathname, `${getSettings().appOrigin}/`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url.toString();
}

function applyLaunchAtLogin(enabled: boolean): void {
  // Not supported on every Linux desktop, and macOS refuses it for an unsigned
  // dev build — neither may break startup. Writing it only when it actually
  // differs also keeps the noisy "Operation not permitted" out of every launch.
  try {
    if (app.getLoginItemSettings().openAtLogin === enabled) return;
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
  } catch (err) {
    logger.warn('launch-at-login unavailable', err);
  }
}
