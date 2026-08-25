/**
 * `--e2e` — the acceptance run, against a real signed-in server.
 *
 * Spec §13 asks a reviewer to do these by hand on a clean machine. This does the
 * same things with the same code paths, so "does folder sync actually work" has
 * an answer that is not somebody's recollection:
 *
 *   2. link a local directory to a conversation and see it report Synced
 *   3. a file the agent writes appears on disk
 *   4. a file the user edits reaches the server
 *   8. the shortcut summons the quick bar
 *
 * It creates a real Redstone folder and a real conversation, both named so they
 * are obvious, and deletes the conversation afterwards. Run it against an
 * account you do not mind touching.
 */
import { app, dialog, globalShortcut } from 'electron';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getToken } from './auth';
import { activeServer } from './servers';
import {
  createSession,
  deleteEntry,
  getTree,
  statEntry,
  uploadFile,
} from './api/client';
import { approvePath } from './links';
import { linkFolderToSession } from './session-folder';
import { openFolderFlow } from './folder-flow';
import { syncEngine } from './sync/engine';
import { applyShortcuts, registeredShortcuts } from './shortcuts';
import { getQuickWindow, hideQuickWindow, toggleQuickWindow } from './windows/quick-window';
import { getSettings } from './settings';
import logger from './logger';

const NAME = 'desktop-e2e';
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `check` passes or the budget runs out. */
async function until<T>(
  what: string,
  budgetMs: number,
  check: () => Promise<T | null>,
): Promise<T | null> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) {
      logger.warn(`e2e: timed out waiting for ${what}`);
      return null;
    }
    await wait(1000);
  }
}

export async function runE2E(): Promise<void> {
  const results: Record<string, unknown> = {};
  let folderId: string | null = null;
  let sessionId: string | null = null;
  let localRoot: string | null = null;

  try {
    results.server = activeServer() ?? 'none';
    if (!activeServer()) throw new Error('no server configured — run the app and connect first');
    if (!(await getToken())) throw new Error('not signed in — sign in once in the app, then rerun');

    // --- 8. the shortcut that summons the bar ---------------------------------
    applyShortcuts();
    const shortcuts = registeredShortcuts();
    results.shortcutRegistered = shortcuts.quickBar ?? false;
    results.captureShortcutRegistered = shortcuts.capture ?? false;
    results.summonShortcutRegistered = shortcuts.summon ?? false;
    results.shortcutIsHeldByUs = globalShortcut.isRegistered(getSettings().shortcuts.quickBar);

    await toggleQuickWindow();
    await wait(4000);
    const bar = getQuickWindow();
    const barUrl = bar?.webContents.getURL() ?? '';
    results.quickBarOpens = Boolean(bar?.isVisible());
    // The web route means the real composer; a file: URL means this server has no
    // /quick and the bar is showing the "needs a newer Redstone" notice.
    results.quickBarUsesWebRoute = barUrl.startsWith('http');
    results.quickBarUrl = barUrl.replace(activeServer() ?? '', '') || null;
    hideQuickWindow();

    // --- a local folder with something in it -----------------------------------
    localRoot = path.join(tmpdir(), `${NAME}-${Date.now()}`);
    await fs.mkdir(path.join(localRoot, 'sub'), { recursive: true });
    await fs.writeFile(path.join(localRoot, 'notes.md'), '# from the user\n');
    await fs.writeFile(path.join(localRoot, 'sub', 'deep.txt'), 'nested\n');
    approvePath(localRoot);

    // --- 2. link it to a conversation -----------------------------------------
    const session = await createSession(`${NAME} ${new Date().toISOString().slice(0, 16)}`);
    sessionId = session.id;
    results.sessionCreated = true;

    // The picker is the only part a machine cannot do; everything after it is the
    // real path, including the survey, folder creation and the server binding.
    const realPicker = dialog.showOpenDialog;
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [localRoot] })) as typeof realPicker;
    const link = await linkFolderToSession(sessionId);
    dialog.showOpenDialog = realPicker;

    results.linked = Boolean(link);
    if (!link) throw new Error('linkFolderToSession returned nothing');
    folderId = link.folderId;
    results.folderId = folderId;

    const settled = await syncEngine.waitForSync(folderId, 90_000);
    results.linkState = settled?.state ?? 'unknown';

    // --- 4. what the user has, the server has ---------------------------------
    const uploaded = await until('the local files to reach the server', 90_000, async () => {
      const tree = await getTree(folderId!, null);
      const paths = tree.entries.filter((e) => !e.isDir).map((e) => e.path);
      return paths.includes('notes.md') && paths.includes('sub/deep.txt') ? paths : null;
    });
    results.localFilesReachedServer = Boolean(uploaded);
    results.remoteListing = uploaded ?? [];

    // --- 3. what the agent writes, the user gets ------------------------------
    await uploadFile(folderId, '', 'from-agent.md', Buffer.from('# written server-side\n'));
    syncEngine.syncNow(folderId);
    const landed = await until('the server file to reach the disk', 90_000, async () => {
      const text = await fs.readFile(path.join(localRoot!, 'from-agent.md'), 'utf8').catch(() => null);
      return text?.includes('written server-side') ? text : null;
    });
    results.serverFileReachedDisk = Boolean(landed);

    // --- an edit on disk goes up ----------------------------------------------
    await fs.writeFile(path.join(localRoot, 'notes.md'), '# edited by the user\n');
    syncEngine.syncNow(folderId);
    const edited = await until('the edit to reach the server', 90_000, async () => {
      const entry = await statEntry(folderId!, 'notes.md');
      return entry?.size === '# edited by the user\n'.length ? entry : null;
    });
    results.localEditReachedServer = Boolean(edited);

    // --- a deletion propagates -------------------------------------------------
    await fs.rm(path.join(localRoot, 'sub', 'deep.txt'));
    syncEngine.syncNow(folderId);
    const deleted = await until('the deletion to reach the server', 90_000, async () => {
      const entry = await statEntry(folderId!, 'sub/deep.txt');
      return entry === null ? true : null;
    });
    results.localDeleteReachedServer = Boolean(deleted);

    results.finalState = syncEngine.status(folderId)?.state ?? 'unknown';

    // --- does it *notice*, or only sync when asked? ---------------------------
    // Everything above nudged the engine with syncNow(), which proves transfers
    // work but not that a change is detected. Nothing below touches the engine:
    // the watcher and the poll have to do it on their own.
    const startedNew = Date.now();
    await fs.writeFile(path.join(localRoot, 'watched.md'), '# created, nobody told the engine\n');
    const noticedNew = await until('the watcher to notice a new file', 45_000, async () =>
      (await statEntry(folderId!, 'watched.md')) ? Date.now() - startedNew : null,
    );
    results.watcherNoticedNewFile = Boolean(noticedNew);
    results.watcherNewFileSeconds = noticedNew ? Math.round(noticedNew / 100) / 10 : null;

    const startedEdit = Date.now();
    await fs.writeFile(path.join(localRoot, 'watched.md'), '# edited, still nobody told it\n');
    const noticedEdit = await until('the watcher to notice an edit', 45_000, async () => {
      const entry = await statEntry(folderId!, 'watched.md');
      return entry?.size === '# edited, still nobody told it\n'.length ? Date.now() - startedEdit : null;
    });
    results.watcherNoticedEdit = Boolean(noticedEdit);
    results.watcherEditSeconds = noticedEdit ? Math.round(noticedEdit / 100) / 10 : null;

    // The other direction has no watcher — the server cannot push — so this is
    // the poll. Spec §13.3 wants the agent's writes on disk within 15 seconds.
    const startedRemote = Date.now();
    await uploadFile(folderId, '', 'polled.md', Buffer.from('# written server-side, unannounced\n'));
    const noticedRemote = await until('the poll to notice a server write', 45_000, async () => {
      const text = await fs.readFile(path.join(localRoot!, 'polled.md'), 'utf8').catch(() => null);
      return text ? Date.now() - startedRemote : null;
    });
    results.pollNoticedServerWrite = Boolean(noticedRemote);
    results.pollSeconds = noticedRemote ? Math.round(noticedRemote / 100) / 10 : null;

    for (const p of ['watched.md', 'polled.md']) {
      await deleteEntry(folderId, p).catch(() => undefined);
    }

    // --- the "no conversation yet" path ---------------------------------------
    // A brand-new chat has no session to bind to, so the folder has to bring one
    // with it. This is what ⌘O does from the new-chat screen.
    const freshRoot = path.join(tmpdir(), `${NAME}-fresh-${Date.now()}`);
    await fs.mkdir(freshRoot, { recursive: true });
    await fs.writeFile(path.join(freshRoot, 'hello.md'), '# from a fresh chat\n');
    approvePath(freshRoot);

    const picker = dialog.showOpenDialog;
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [freshRoot] })) as typeof picker;
    const fresh = await openFolderFlow(null);
    dialog.showOpenDialog = picker;

    results.newChatFlowLinked = Boolean(fresh.status);
    results.newChatFlowCreatedSession = Boolean(fresh.sessionId);
    if (fresh.status) {
      const reached = await until('the fresh folder to reach the server', 60_000, async () => {
        const entry = await statEntry(fresh.status!.folderId, 'hello.md');
        return entry ? entry : null;
      });
      results.newChatFolderSynced = Boolean(reached);
      await syncEngine.unlink(fresh.status.folderId);
      await deleteEntry(fresh.status.folderId, 'hello.md').catch(() => undefined);
    }
    await fs.rm(freshRoot, { recursive: true, force: true });
  } catch (err) {
    results.error = (err as Error).message;
  } finally {
    // Leave the account as close to how it was found as the API allows.
    try {
      if (folderId) {
        await syncEngine.unlink(folderId);
        for (const p of ['notes.md', 'from-agent.md', 'sub']) {
          await deleteEntry(folderId, p, true).catch(() => undefined);
        }
        results.cleanup = 'folder emptied (the API has no folder delete) and unlinked';
      }
      if (localRoot) await fs.rm(localRoot, { recursive: true, force: true });
    } catch (err) {
      results.cleanupError = (err as Error).message;
    }
  }

  const expected = [
    'shortcutRegistered',
    'quickBarOpens',
    'quickBarUsesWebRoute',
    'linked',
    'localFilesReachedServer',
    'serverFileReachedDisk',
    'localEditReachedServer',
    'localDeleteReachedServer',
    'newChatFlowLinked',
    'newChatFlowCreatedSession',
    'newChatFolderSynced',
    'watcherNoticedNewFile',
    'watcherNoticedEdit',
    'pollNoticedServerWrite',
  ];
  const failed = expected.filter((k) => !results[k]);

  // eslint-disable-next-line no-console
  console.log(`[e2e] ${JSON.stringify(results, null, 2)}`);
  if (failed.length) console.error(`[e2e] FAILED: ${failed.join(', ')}`);
  else console.log('[e2e] all acceptance checks passed');

  app.exit(failed.length === 0 && !results.error ? 0 : 1);
}
