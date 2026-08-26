/**
 * Desktop chrome bar — window furniture, nothing more.
 *
 * It briefly carried buttons and a sync summary. Both were wrong: a control
 * belongs beside the thing it acts on (the web app's own UI —
 * docs/integration/04-desktop-affordances-in-web-ui.md), and a one-line sync
 * summary can only describe a single folder honestly. Sync status lives where it
 * has room for all of them: the Folder Sync Status window, the tray menu, and
 * the web app's per-conversation control.
 *
 * What is left is what a page cannot do for itself:
 *
 *   - a drag region, because a frameless window is only movable where the page
 *     says so, and the web app does not know it is inside one;
 *   - reload, for when the page is wedged and the menu is out of reach.
 */
// `export {}` keeps this a module: without an import or export it is a script,
// and its top-level `const`s would collide with the other renderer pages'.
export {};

const bridge = window.redstone;
const shell = window.redstoneShell;

document.body.dataset.platform = bridge.platform;

(document.getElementById('reload') as HTMLButtonElement).addEventListener('click', () => {
  void shell?.reloadApp();
});

// --- connection ---------------------------------------------------------------
// A dropped connection used to be invisible until the whole view went blank.
// The bar is the only part of the window the shell owns, so it is where the
// warning goes — and *only* the warning. A working connection is the normal
// state and gets no pixels: no confirmation, no "back online", nothing to
// dismiss. The banner appearing means something is wrong; it disappearing means
// it is over.

const net = document.getElementById('net') as HTMLDivElement;
const netText = document.getElementById('net-text') as HTMLSpanElement;

function showConnection(report: { state: string; host: string; message?: string }): void {
  if (report.state === 'online') {
    net.hidden = true;
    return;
  }

  net.dataset.tone = 'down';
  netText.textContent =
    report.state === 'no-internet'
      ? 'No internet connection'
      : report.state === 'unstable'
        ? // The page is reloading itself; the shell is only the messenger, so
          // it uses the wording the main process chose rather than inventing
          // its own account of a problem it does not own.
          (report.message ?? 'The page keeps reloading')
        : `Can't reach ${report.host || 'the server'} — reconnecting…`;
  // Truncated in the bar; the whole sentence is one hover away.
  net.title = netText.textContent ?? '';
  net.hidden = false;
}

shell?.onConnection(showConnection);
void shell?.connection().then(showConnection);
