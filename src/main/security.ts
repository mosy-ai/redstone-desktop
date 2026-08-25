/**
 * The renderer runs remote code. Everything here exists to keep that code inside
 * a box (spec §3, §8 "trust boundary").
 *
 *   - one persistent partition for every window, so login is shared;
 *   - network requests limited to the Redstone origin plus configured storage
 *     hosts;
 *   - any other URL opens in the system browser instead of navigating a window;
 *   - no webviews, no new privileged windows, permissions denied by default.
 */
import { app, shell, type Session, type WebContents } from 'electron';
import { redstoneSession } from './auth';
import { getSettings } from './settings';
import { ensureMicrophoneAccess } from './media-access';
import { LOCAL_SCHEMES, isAllowedUrl, siblingSuffix } from '../shared/origins';
import logger from './logger';

/**
 * The Redstone origin, plus the storage host (spec §3).
 *
 * The storage host is deployment configuration, not something the shell can
 * know — but it is a sibling of the app in every deployment we have
 * (`redstone-agent.yitec.dev` → something else under `yitec.dev`), and blocking
 * it would break every image and download the web app renders. So sibling hosts
 * of the app's own domain are allowed, and anything further afield has to be
 * listed explicitly in settings.
 */
function allowedOrigins(): string[] {
  const s = getSettings();
  const explicit = [s.appOrigin, ...s.allowedOrigins].map((o) => o.replace(/\/+$/, ''));
  const siblings = siblingSuffix(s.appOrigin);
  return siblings ? [...explicit, siblings] : explicit;
}

const isAllowed = (url: string): boolean => isAllowedUrl(url, allowedOrigins());

/** Applies the network allowlist to the shared partition. Call once, after settings load. */
export function hardenSession(): void {
  const ses: Session = redstoneSession();

  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    if (isAllowed(details.url)) return callback({ cancel: false });
    logger.warn('blocked request to disallowed origin', { origin: safeOrigin(details.url) });
    callback({ cancel: true });
  });

  /**
   * Voice needs the microphone, so `media` is allowed — but only audio, only for
   * Redstone's own pages, and only after macOS has granted it too. Camera and
   * everything else stay denied; screen capture is done in the main process from
   * an explicit keystroke, never by the page.
   */
  const audioOnly = (mediaTypes?: string[]): boolean =>
    Array.isArray(mediaTypes) && mediaTypes.length > 0 && mediaTypes.every((t) => t === 'audio');

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (permission === 'clipboard-sanitized-write' || permission === 'notifications') {
      // Scoped like everything else: the renderer runs remote code, and this is
      // the same trust boundary as spec §8.
      return callback(isAllowed(details.requestingUrl || wc.getURL()));
    }

    if (permission === 'media') {
      const origin = details.requestingUrl || wc.getURL();
      const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes;
      if (!isAllowed(origin) || !audioOnly(mediaTypes)) {
        logger.info('denied media request', { origin: safeOrigin(origin), mediaTypes });
        return callback(false);
      }
      // The page's yes is worthless without the operating system's.
      void ensureMicrophoneAccess().then((granted) => {
        logger.info(`microphone request ${granted ? 'allowed' : 'blocked by macOS'}`);
        callback(granted);
      });
      return;
    }

    logger.info('denied permission request', { permission, origin: safeOrigin(details.requestingUrl) });
    callback(false);
  });

  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    // The synchronous `Notification.permission` read goes through here, and the
    // web app checks it before doing anything — a false makes the app silent
    // with no error anywhere.
    if (permission === 'clipboard-sanitized-write' || permission === 'notifications') {
      return isAllowed(requestingOrigin || '');
    }
    // Device *labels* come from this check, so a mic list stays anonymous
    // without it.
    if (permission === 'media') return isAllowed(requestingOrigin || '');
    return false;
  });

  // The app never asks for a client certificate or accepts a bad one.
  app.on('certificate-error', (event, _wc, url, error, _cert, callback) => {
    logger.error('TLS failure', { origin: safeOrigin(url), error });
    event.preventDefault();
    callback(false);
  });
}

/** Per-window guards: navigation, popups, webviews, devtools in production. */
export function guardWebContents(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowed(url) && !LOCAL_SCHEMES.has(new URL(url).protocol)) {
      // Same-origin popups (OAuth-style flows) still open externally: the shell
      // deliberately has exactly the windows it creates itself.
      void shell.openExternal(url);
      return { action: 'deny' };
    }
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (isAllowed(url)) return;
    event.preventDefault();
    logger.info('navigation to external URL sent to the browser', { origin: safeOrigin(url) });
    if (/^https?:/.test(url)) void shell.openExternal(url);
  });

  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
    logger.warn('blocked <webview> attach');
  });

  contents.on('render-process-gone', (_e, details) => {
    logger.error('renderer gone', details);
  });
}

/** Origin only — a full URL can carry a session id or a filename. */
function safeOrigin(rawUrl: string | undefined): string {
  if (!rawUrl) return 'unknown';
  try {
    return new URL(rawUrl).origin;
  } catch {
    return 'unparseable';
  }
}
