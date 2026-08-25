/**
 * Which Redstone instance this app talks to.
 *
 * Redstone can be self-hosted and exists in more than one region, so the shell
 * cannot assume an origin the way a single-tenant app can. Like Mattermost, the
 * first thing a new install asks for is the server URL — before any login, since
 * the login form itself lives on that server.
 *
 * The active origin is mirrored into `settings.appOrigin`, which is what the
 * rest of the app already reads; this module owns validation, the probe, and the
 * list of servers the user has used before.
 */
import { JsonStore, userDataFile } from './store';
import { getSettings, updateSettings } from './settings';
import logger from './logger';

export interface KnownServer {
  origin: string;
  /** What the server called itself when we probed it. */
  name: string;
  lastUsedAt: string;
  /**
   * Set once this server's web app was seen rendering its own folder control.
   * Remembered so the shell can hide its duplicate on the *next* launch before
   * anything is painted, instead of showing it until the web app's first call
   * arrives — which is a visible flash of two buttons doing the same job.
   */
  webAppRendersFolderControl?: boolean;
}

interface ServersFile {
  version: 1;
  servers: KnownServer[];
}

let store: JsonStore<ServersFile> | null = null;

export async function initServers(): Promise<void> {
  store = await JsonStore.open<ServersFile>(userDataFile('servers.json'), {
    version: 1,
    servers: [],
  });
}

export function knownServers(): KnownServer[] {
  return [...(store?.get().servers ?? [])].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
}

/** The configured server, or null on a fresh install. */
export function activeServer(): string | null {
  const origin = getSettings().appOrigin;
  return origin ? origin : null;
}

export function hasServer(): boolean {
  return activeServer() !== null;
}

/**
 * Accepts what a person actually types — `redstone.acme.com`,
 * `https://redstone.acme.com/chat`, a trailing slash — and returns the origin,
 * or null if there is no sane reading of it.
 *
 * The path is dropped deliberately: the web app routes from the domain root
 * (`/chat`, `/api/v1`), so a sub-path deployment is not something this shell can
 * support by pretending.
 */
export function normaliseOrigin(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  // Single-label hosts (`localhost`, a docker service name) are legitimate, so
  // the only requirement is that there is a host at all.
  if (!url.hostname) return null;
  return url.origin;
}

/** Hosts where an http:// fallback is reasonable — a dev box, not the internet. */
function isLocalHost(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname.endsWith('.local') ||
      /^10\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    );
  } catch {
    return false;
  }
}

export type ProbeFailure =
  | 'invalid'
  | 'unreachable'
  | 'tls'
  | 'not-redstone'
  | 'server-error';

export interface ProbeResult {
  ok: boolean;
  /** The origin that actually answered — may differ if the server redirected. */
  origin?: string;
  name?: string;
  reason?: ProbeFailure;
  message?: string;
}

/**
 * Ask an origin whether it is a Redstone instance.
 *
 * `GET /api/v1/health` is unauthenticated and answers
 * `{"status":"healthy","service":"Redstone Agent"}`, which is enough to tell a
 * real instance from a typo that happens to resolve.
 */
export async function probeServer(rawInput: string, signal?: AbortSignal): Promise<ProbeResult> {
  const origin = normaliseOrigin(rawInput);
  if (!origin) {
    return { ok: false, reason: 'invalid', message: 'That does not look like a web address.' };
  }

  const candidates = [origin];
  // A local dev instance is usually plain http; typing "localhost:3070" should
  // work without knowing to spell out the scheme.
  if (origin.startsWith('https://') && isLocalHost(origin)) {
    candidates.push(origin.replace(/^https:/, 'http:'));
  }

  let lastFailure: ProbeResult = {
    ok: false,
    reason: 'unreachable',
    message: 'Could not reach that server.',
  };

  for (const candidate of candidates) {
    const attempt = await probeOne(candidate, signal);
    if (attempt.ok) return attempt;
    lastFailure = attempt;
    // A server that answered but is not Redstone is a definite answer; retrying
    // over http would only produce a second wrong answer.
    if (attempt.reason === 'not-redstone' || attempt.reason === 'server-error') break;
  }
  return lastFailure;
}

async function probeOne(origin: string, signal?: AbortSignal): Promise<ProbeResult> {
  const timeout = AbortSignal.timeout(10_000);
  const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(`${origin}/api/v1/health`, {
      headers: { Accept: 'application/json' },
      redirect: 'follow',
      signal: merged,
    });
  } catch (err) {
    const message = (err as Error).message ?? '';
    if (/certificate|tls|ssl/i.test(message)) {
      return {
        ok: false,
        reason: 'tls',
        message: "The server's security certificate could not be verified.",
      };
    }
    return {
      ok: false,
      reason: 'unreachable',
      message: 'Could not reach that server. Check the address and your connection.',
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      reason: res.status >= 500 ? 'server-error' : 'not-redstone',
      message:
        res.status === 404
          ? 'That server answered, but it is not a Redstone instance.'
          : `That server answered with ${res.status}.`,
    };
  }

  let body: { status?: string; service?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return {
      ok: false,
      reason: 'not-redstone',
      message: 'That server answered, but it is not a Redstone instance.',
    };
  }

  if (!body.service || !/redstone/i.test(body.service)) {
    return {
      ok: false,
      reason: 'not-redstone',
      message: 'That server answered, but it is not a Redstone instance.',
    };
  }

  // A redirect (http → https, apex → www) means the origin we should keep is the
  // one that actually served the response, not the one that was typed.
  const settled = safeOrigin(res.url) ?? origin;
  logger.info('server probe succeeded');
  return { ok: true, origin: settled, name: body.service };
}

function safeOrigin(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return null;
  }
}

/** Make `origin` the active server and remember it. */
export async function setActiveServer(origin: string, name = 'Redstone'): Promise<void> {
  const normalised = normaliseOrigin(origin);
  if (!normalised) throw new Error('invalid server origin');
  updateSettings({ appOrigin: normalised });
  store?.update((draft) => {
    draft.servers = draft.servers.filter((s) => s.origin !== normalised);
    draft.servers.push({ origin: normalised, name, lastUsedAt: new Date().toISOString() });
    // Keep the list short — this is a convenience, not a history.
    draft.servers = draft.servers.slice(-8);
  });
  await store?.flush();
  logger.info('active server set');
}

/** Did this server's web app render its own folder control last time? */
export function serverRendersFolderControl(): boolean {
  const active = activeServer();
  if (!active) return false;
  return knownServers().find((s) => s.origin === active)?.webAppRendersFolderControl === true;
}

export async function rememberFolderControl(): Promise<void> {
  const active = activeServer();
  if (!active) return;
  store?.update((draft) => {
    const server = draft.servers.find((s) => s.origin === active);
    if (server) server.webAppRendersFolderControl = true;
  });
  await store?.flush();
}

export async function forgetServer(origin: string): Promise<void> {
  store?.update((draft) => {
    draft.servers = draft.servers.filter((s) => s.origin !== origin);
  });
  await store?.flush();
}

export function flushServers(): Promise<void> {
  return store ? store.flush() : Promise.resolve();
}
