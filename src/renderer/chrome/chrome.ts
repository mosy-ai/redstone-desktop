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
