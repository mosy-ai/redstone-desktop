/**
 * Whether Redstone can actually be reached, and telling the user when it can't.
 *
 * The window shows remote content, so a bad network is not an abstract failure
 * mode: it is a blank page. Three things have to be true for that to be bearable
 *
 *   1. **Say which failure it is.** "No Wi-Fi" and "the server is down" look
 *      identical from inside a blank window and need completely different
 *      reactions from the user. `net.isOnline()` separates them: it reports
 *      Chromium's own link state, so a failed probe with the link up means the
 *      server, not the café.
 *   2. **Never retry on a fixed timer.** A flaky connection retried every N
 *      seconds produces a window that reloads, fails, and reloads again — the
 *      flashing this module exists to stop. Backoff, with a ceiling.
 *   3. **Probe, don't navigate.** Recovery is checked with a cheap unauthorised
 *      `GET /api/v1/health` in the main process. The view is only navigated once
 *      that succeeds, so the user sees one transition, not a strobe.
 *
 * Nothing here is authenticated and nothing here is retried forever: when the
 * app is out of sight the watcher idles, because a probe nobody is waiting for
 * is just battery.
 */
import { net } from 'electron';
import { probeServer } from './servers';
import { getSettings } from './settings';
import logger from './logger';
import type { ConnectionReport, ConnectionState } from '../shared/types';

export type { ConnectionReport, ConnectionState };

type Listener = (report: ConnectionReport) => void;

/**
 * Backoff, in ms, indexed by consecutive failure count. The first two are quick
 * because most drops are a lift going past a wall; the tail is long because a
 * server that has been down for five minutes is not coming back this second.
 */
const BACKOFF = [2_000, 5_000, 10_000, 20_000, 30_000, 60_000];

/**
 * How long to wait before the nth consecutive re-check, in ms.
 *
 * Pure and exported because this is the part that has to be right: a schedule
 * that fails to grow is the flashing bug, and one that grows too fast leaves the
 * user staring at an error screen for a minute after the Wi-Fi is back.
 */
export function backoffDelay(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1) - 1, BACKOFF.length - 1);
  return BACKOFF[index] ?? BACKOFF[BACKOFF.length - 1] ?? 60_000;
}

/**
 * What to tell the user, given how the probe failed.
 *
 * "Something went wrong" is not an option here: the four failures need four
 * different reactions — check your Wi-Fi, wait for your admin, fix the clock or
 * the certificate, or you typed the wrong address.
 */
export function describeFailure(reason: string | undefined, host: string): string {
  const where = host || 'the server';
  switch (reason) {
    case 'tls':
      return `The security certificate for ${where} could not be verified.`;
    case 'server-error':
      return `${where} is reachable but not answering properly.`;
    case 'not-redstone':
      return `${where} answered, but it is not a Redstone server.`;
    default:
      return `Can't reach ${where}.`;
  }
}

const listeners = new Set<Listener>();
let report: ConnectionReport = {
  state: 'online',
  message: '',
  host: '',
  attempts: 0,
  since: Date.now(),
};
let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<ConnectionReport> | null = null;

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export function getConnection(): ConnectionReport {
  return report;
}

export function onConnectionChange(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function publish(next: Omit<ConnectionReport, 'since'>): ConnectionReport {
  const changed = next.state !== report.state;
  report = { ...next, since: changed ? Date.now() : report.since };
  if (changed) {
    logger.info('connection state', { state: report.state, attempts: report.attempts });
  }
  // A listener that throws must not take the watcher down with it.
  for (const cb of listeners) {
    try {
      cb(report);
    } catch (err) {
      logger.warn('connection listener failed', err);
    }
  }
  return report;
}

/**
 * Check once, now. Concurrent callers share the one probe — the offline screen,
 * the chrome bar and a `did-fail-load` all ask at the same moment, and three
 * simultaneous requests to a server that is already struggling is not help.
 */
export function checkConnection(): Promise<ConnectionReport> {
  if (inFlight) return inFlight;
  inFlight = runCheck().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runCheck(): Promise<ConnectionReport> {
  const origin = getSettings().appOrigin;
  const host = origin ? hostOf(origin) : '';
  if (!origin) {
    return publish({ state: 'online', message: '', host: '', attempts: 0 });
  }

  // Chromium's link state. Cheap, synchronous, and the only way to tell "no
  // network" from "server down" without guessing at error codes.
  if (!net.isOnline()) {
    return fail('no-internet', 'This computer is not connected to the internet.', host);
  }

  const result = await probeServer(origin);
  if (result.ok) {
    return publish({ state: 'online', message: '', host, attempts: 0 });
  }

  return fail('server-unreachable', describeFailure(result.reason, host), host);
}

function fail(state: ConnectionState, message: string, host: string): ConnectionReport {
  return publish({ state, message, host, attempts: report.attempts + 1 });
}

/**
 * Keep checking until the server answers, with backoff.
 *
 * Safe to call repeatedly — a watch already running is left alone rather than
 * restarted, so a burst of failures cannot compound into a burst of probes.
 */
export function watchUntilOnline(): void {
  if (timer) return;
  const step = (): void => {
    timer = null;
    void checkConnection().then((next) => {
      if (next.state === 'online') return;
      timer = setTimeout(step, backoffDelay(next.attempts));
      timer.unref?.();
    });
  };
  // The first probe is immediate: the caller only starts a watch because
  // something just failed.
  step();
}

export function stopWatching(): void {
  if (!timer) return;
  clearTimeout(timer);
  timer = null;
}

/**
 * A page told us its `navigator.onLine` flipped.
 *
 * A hint, never the verdict: `onLine` is true on any café Wi-Fi whose portal
 * has not been accepted yet. It only decides *when* to probe, and coming back
 * resets the backoff so recovery is immediate rather than up to a minute late.
 */
export function reportRendererNetwork(online: boolean): void {
  if (online) {
    stopWatching();
    report = { ...report, attempts: 0 };
    void checkConnection().then((next) => {
      if (next.state !== 'online') watchUntilOnline();
    });
    return;
  }
  publish({
    state: 'no-internet',
    message: 'This computer is not connected to the internet.',
    host: report.host,
    attempts: Math.max(report.attempts, 1),
  });
  watchUntilOnline();
}
