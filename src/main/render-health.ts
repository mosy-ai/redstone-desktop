/**
 * Watching how hard the web app is working, and what it is complaining about.
 *
 * "The window is flashing" arrived three times with nothing in the log to show
 * for it. The reason is that none of the shell's existing signals fire for it:
 * the page is not reloading (no `did-fail-load`, no document load), the
 * connection is fine, and repeat bridge calls are logged once per channel. A
 * page stuck re-rendering itself is invisible from the main process — except in
 * the one place it cannot hide, which is the CPU it burns doing it.
 *
 * So two measurements:
 *
 *   - **Sustained CPU** in the renderer and GPU processes. A page at rest costs
 *     nothing; one repainting continuously shows up immediately, and it stays
 *     visible even when the window is minimised, because notifications require
 *     `backgroundThrottling: false` and an unthrottled runaway page keeps
 *     running.
 *   - **Console errors** from the page. A React render loop announces itself
 *     there and nowhere else. Deduplicated and capped, because a loop produces
 *     thousands of identical lines and the log is not the place to reproduce
 *     them.
 *
 * Neither is shown to the user. A slow page is not something they can act on,
 * and a warning they cannot act on is noise — this exists to make the next
 * report diagnosable instead of anecdotal.
 */
import { app } from 'electron';
import os from 'node:os';
import logger from './logger';

/** Electron reports a share of the whole machine; people think in cores. */
const cores = Math.max(1, os.cpus().length);
const perCore = (percentOfMachine: number): number => percentOfMachine * cores;

/** How often to sample. Cheap — `getAppMetrics` reads counters the OS keeps. */
const SAMPLE_MS = 15_000;
/**
 * Percent of **one core**, above which a process is not idling.
 *
 * `getAppMetrics` reports a share of the whole machine, so on this 8-core
 * laptop a process pinning half a core reads as 6%. Comparing that against a
 * threshold that looks like a CPU percentage is how the first version of this
 * check silently never fired — the numbers are normalised to one core here so
 * the constant means what it says, and matches what Activity Monitor shows.
 */
const BUSY_PERCENT = 20;
/** Consecutive busy samples before it counts as sustained rather than a burst. */
const BUSY_SAMPLES = 4;

let timer: NodeJS.Timeout | null = null;
let busyRun = 0;
let announced = false;

export function startRenderHealth(): void {
  if (timer) return;
  timer = setInterval(sample, SAMPLE_MS);
  timer.unref?.();
}

export function stopRenderHealth(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

function sample(): void {
  let metrics: Electron.ProcessMetric[];
  try {
    metrics = app.getAppMetrics();
  } catch {
    return; // shutting down
  }

  const busiest = metrics
    .filter((m) => m.type === 'Tab' || m.type === 'GPU')
    .reduce<Electron.ProcessMetric | null>(
      (worst, m) => (!worst || m.cpu.percentCPUUsage > worst.cpu.percentCPUUsage ? m : worst),
      null,
    );
  if (!busiest) return;

  const busiestPerCore = perCore(busiest.cpu.percentCPUUsage);
  if (busiestPerCore < BUSY_PERCENT) {
    if (announced) {
      logger.info('the web app settled down', {
        after: `${(busyRun * SAMPLE_MS) / 1000}s`,
      });
    }
    busyRun = 0;
    announced = false;
    return;
  }

  busyRun += 1;
  if (busyRun < BUSY_SAMPLES || announced) return;
  announced = true;
  // Once per episode: the point is to record that this happened and how hard,
  // not to narrate every sample of it.
  logger.warn('the web app has been redrawing continuously', {
    process: busiest.type,
    percentOfOneCore: Math.round(busiestPerCore),
    forSeconds: (busyRun * SAMPLE_MS) / 1000,
    processes: metrics
      .filter((m) => perCore(m.cpu.percentCPUUsage) >= 5)
      .map((m) => `${m.type}:${Math.round(perCore(m.cpu.percentCPUUsage))}%`),
  });
}

/**
 * Record what the page logs, without reproducing a loop in our own log.
 *
 * Only warnings and errors, only the first line, capped in length: the page is
 * remote and its console carries whatever it carries, so this keeps a
 * fingerprint rather than a transcript. Identical messages are counted, not
 * repeated.
 */
export function watchConsole(contents: Electron.WebContents): void {
  const seen = new Map<string, number>();
  let distinct = 0;

  contents.on('console-message', (event) => {
    // 0 verbose, 1 info, 2 warning, 3 error — anything below a warning is the
    // page's normal chatter and none of our business.
    if (event.level !== 'warning' && event.level !== 'error') return;

    const key = (event.message ?? '').split('\n')[0]?.slice(0, 160) ?? '';
    if (!key) return;

    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);

    // First sighting is logged; after that only at exponential milestones, so a
    // runaway loop reads as "this happened 1000 times" in a handful of lines.
    if (count === 1) {
      if (distinct >= 40) return; // a page determined to fill the log will not
      distinct += 1;
      logger.warn('web app console', { level: event.level, message: key });
      return;
    }
    if (count === 10 || count === 100 || count === 1_000 || count === 10_000) {
      logger.warn('web app console, repeating', { count, message: key });
    }
  });
}

// --- request rate ------------------------------------------------------------
// A page that is "constantly refreshing" says so on the wire long before anyone
// can describe it. Counted from the allowlist hook, which already sees every
// request, rather than a second webRequest listener — Electron keeps only one
// per event, so registering another would silently disable the allowlist.
//
// Paths only: a query string carries conversation ids, and this is a rate
// measurement, not a record of what the user did.

/** Requests to one path within the window, above which something is looping. */
const PATH_LIMIT = 60;
/** Requests across all paths within the window. */
const TOTAL_LIMIT = 300;
const RATE_WINDOW_MS = 60_000;

const requests: Array<{ at: number; path: string }> = [];
let rateAnnounced = 0;

export function noteRequest(rawUrl: string, resourceType: string): void {
  const now = Date.now();
  let path: string;
  try {
    const url = new URL(rawUrl);
    // Websocket reconnect loops are the specific case worth naming: an HMR or
    // notification socket that drops and redials is invisible everywhere else.
    path = `${resourceType === 'webSocket' ? 'ws ' : ''}${url.pathname}`;
  } catch {
    return;
  }

  requests.push({ at: now, path });
  while (requests.length && now - requests[0]!.at > RATE_WINDOW_MS) requests.shift();

  // At most one report a minute, however bad it gets.
  if (now - rateAnnounced < RATE_WINDOW_MS) return;

  const perPath = new Map<string, number>();
  for (const r of requests) perPath.set(r.path, (perPath.get(r.path) ?? 0) + 1);
  const worst = [...perPath.entries()].sort((a, b) => b[1] - a[1]);
  const [topPath, topCount] = worst[0] ?? ['', 0];

  if (topCount < PATH_LIMIT && requests.length < TOTAL_LIMIT) return;
  rateAnnounced = now;
  logger.warn('the web app is making requests in a loop', {
    inLastMinute: requests.length,
    worst: `${topPath} x${topCount}`,
    next: worst.slice(1, 4).map(([p, c]) => `${p} x${c}`),
  });
}
