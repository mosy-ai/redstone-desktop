/**
 * The screen behind a failed connection.
 *
 * Its one job beyond explaining itself is **not to flash**. The previous version
 * re-opened the main window on a fixed 15s timer, which on a weak connection
 * meant: error screen, reload, fail, error screen — a strobing window that also
 * stole focus every fifteen seconds. So:
 *
 *   - recovery is detected by *probing* (the main process asks the server's
 *     health endpoint), never by navigating and seeing what happens;
 *   - the wait between probes backs off, and the page says how long it is, so
 *     nothing appears frozen;
 *   - the view is navigated exactly once, when the server has already answered.
 */
export {};

const shell = window.redstoneShell;

const gem = document.getElementById('gem') as unknown as SVGSVGElement;
const title = document.getElementById('title') as HTMLHeadingElement;
const body = document.getElementById('body') as HTMLParagraphElement;
const retry = document.getElementById('retry') as HTMLButtonElement;
const status = document.getElementById('status') as HTMLDivElement;
const detail = document.getElementById('detail') as HTMLDivElement;

/** Matches the main process's own backoff, in seconds. */
const BACKOFF = [2, 5, 10, 20, 30, 60];

let countdown: number | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let checking = false;

const reason = new URLSearchParams(location.search).get('reason');
if (reason) detail.textContent = reason;

function render(report: { state: string; message: string; host: string }): void {
  if (report.state === 'no-internet') {
    title.textContent = "You're offline";
    body.textContent =
      'This computer has no internet connection. Redstone will pick up where it left off — your folders keep syncing as soon as it is back.';
  } else {
    title.textContent = report.host ? `Can't reach ${report.host}` : "Can't reach Redstone";
    body.textContent =
      report.message ||
      'The server is not answering. Your folders keep syncing in the background and the queue drains as soon as the connection is back.';
  }
}

function tick(): void {
  if (countdown === null) return;
  countdown -= 1;
  if (countdown > 0) {
    status.textContent = `Checking again in ${countdown}s…`;
    return;
  }
  stopCountdown();
  void probe();
}

function stopCountdown(): void {
  countdown = null;
  if (timer !== null) clearInterval(timer);
  timer = null;
}

function scheduleNext(attempt: number): void {
  stopCountdown();
  countdown = BACKOFF[Math.min(attempt - 1, BACKOFF.length - 1)] ?? 60;
  status.textContent = `Checking again in ${countdown}s…`;
  timer = setInterval(tick, 1000);
}

let attempts = 0;

async function probe(): Promise<void> {
  if (checking) return;
  checking = true;
  gem.classList.add('checking');
  retry.disabled = true;
  status.textContent = 'Checking the connection…';
  try {
    const report = await shell!.checkConnection();
    if (report.state === 'online') {
      status.textContent = 'Back online — reopening Redstone…';
      stopCountdown();
      // The only navigation this page performs, and only once the server has
      // already answered.
      await shell!.reloadApp();
      return;
    }
    attempts += 1;
    render(report);
    scheduleNext(attempts);
  } catch {
    attempts += 1;
    scheduleNext(attempts);
  } finally {
    checking = false;
    gem.classList.remove('checking');
    retry.disabled = false;
  }
}

retry.addEventListener('click', () => {
  // An explicit "try again" resets the backoff: the user knows something the
  // shell does not — they just reconnected the Wi-Fi.
  attempts = 0;
  stopCountdown();
  void probe();
});

// The machine came back. Probe immediately rather than sitting out a 60s wait.
window.addEventListener('online', () => {
  attempts = 0;
  stopCountdown();
  void probe();
});

void shell!.connection().then(render);
void probe();
