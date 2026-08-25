/**
 * "Open a folder" — the flow behind the menu item and the bridge (spec §5.2).
 *
 *   pick → survey and warn → create or attach a Redstone folder → link →
 *   first sync → create a chat bound to it → navigate the main window there.
 *
 * The warnings are the interesting part: the common accident is linking a whole
 * home directory, so a `.git`, a `node_modules` or more than 5,000 files needs an
 * explicit confirmation, and 20,000 files is refused outright because the tree
 * endpoint truncates above that and correct mirroring stops being possible.
 */
import { BrowserWindow, dialog, shell } from 'electron';
import path from 'node:path';
import type { LinkStatus } from '../shared/types';
import { SYNC } from '../shared/constants';
import { approvePath, getLinkForPath, listLinks, resolveInside } from './links';
import { IgnoreRules } from './sync/ignore';
import { surveyDirectory } from './sync/scan';
import { syncEngine } from './sync/engine';
import { hasServer } from './servers';
import { showServerWindow } from './windows/server-window';
import { createFolder, createSession, listFolders } from './api/client';
import { loadApp, showMainWindow } from './windows/main-window';
import { ROUTES } from '../shared/constants';
import logger from './logger';

/** Native directory picker. The returned path is what the allowlist trusts. */
export async function pickFolder(parent?: BrowserWindow | null): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'Choose a folder to link with Redstone',
    buttonLabel: 'Link folder',
    properties: ['openDirectory', 'createDirectory'],
  };
  // `showOpenDialog(undefined, options)` is not the parentless overload — it
  // makes Electron try to read `undefined` as the window.
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);
  const chosen = result.canceled ? undefined : result.filePaths[0];
  if (!chosen) return null;
  approvePath(chosen);
  return chosen;
}

/**
 * Guard against the common accident — linking a whole home directory or a
 * checkout. Shared with the per-session flow in session-folder.ts.
 */
export async function confirmSurvey(localPath: string): Promise<boolean> {
  const rules = await IgnoreRules.load(localPath);
  const survey = await surveyDirectory(localPath, rules, SYNC.refuseFileCount + 1);

  if (survey.count > SYNC.refuseFileCount) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Folder is too large',
      message: 'That folder has more than 20,000 files',
      detail:
        'Redstone cannot mirror a folder this large: the server stops listing above 20,000 entries, ' +
        'and a partial listing cannot be synced safely. Pick a smaller folder, or exclude parts of ' +
        'it with a .redstoneignore file.',
      buttons: ['OK'],
    });
    return false;
  }

  const warnings: string[] = [];
  if (survey.hasGit) warnings.push('• it contains a .git directory');
  if (survey.hasNodeModules) warnings.push('• it contains node_modules');
  if (survey.count > SYNC.warnFileCount) warnings.push(`• it contains ${survey.count.toLocaleString()} files`);
  if (warnings.length === 0) return true;

  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: 'Link this folder?',
    message: `Link “${path.basename(localPath)}” anyway?`,
    detail:
      `${warnings.join('\n')}\n\n` +
      'Redstone skips .git, node_modules and similar scaffolding, but a folder this size takes a ' +
      'while to sync. Linking a whole home directory is usually a mistake.',
    buttons: ['Link folder', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  return response === 0;
}

/**
 * Decide which Redstone folder a local directory should attach to: an existing
 * one with the same name, or a new one.
 */
async function chooseRemoteFolder(localPath: string): Promise<{ id: string; name: string } | null> {
  const name = path.basename(localPath);
  const { mountReady, items } = await listFolders();
  if (!mountReady) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Folder storage unavailable',
      message: 'Redstone cannot reach folder storage right now',
      detail: 'Try again in a few minutes. Nothing has been uploaded.',
      buttons: ['OK'],
    });
    return null;
  }

  const match = items.find((f) => f.name.toLowerCase() === name.toLowerCase());
  if (match) {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      title: 'Attach to existing folder?',
      message: `A Redstone folder called “${match.name}” already exists`,
      detail:
        'Attach this directory to it (files from both sides are merged, conflicts keep both copies), ' +
        'or create a separate folder.',
      buttons: ['Attach to existing', 'Create a new folder', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 2) return null;
    if (response === 0) return { id: match.id, name: match.name };
  }

  const created = await createFolder(name);
  return { id: created.id, name: created.name };
}

export interface OpenFolderResult {
  status: LinkStatus | null;
  sessionId?: string;
}

/** The whole flow, start to finish. Safe to call from a menu or the bridge. */
export async function openFolderFlow(
  parent?: BrowserWindow | null,
  opts: { createSessionAfter?: boolean } = {},
): Promise<OpenFolderResult> {
  if (!hasServer()) {
    showServerWindow();
    return { status: null };
  }
  const localPath = await pickFolder(parent);
  if (!localPath) return { status: null };

  const already = getLinkForPath(localPath);
  if (already) {
    syncEngine.syncNow(already.folderId);
    return { status: syncEngine.status(already.folderId) ?? null };
  }

  if (!(await confirmSurvey(localPath))) return { status: null };

  const remote = await chooseRemoteFolder(localPath);
  if (!remote) return { status: null };

  const linked = await syncEngine.link(remote.id, remote.name, localPath);
  logger.info('folder linked', { folderId: remote.id });

  if (opts.createSessionAfter === false) return { status: linked };

  // Sync once before the chat opens so the agent does not land in an empty
  // directory (sync API §6). A slow first sync should not block forever, so this
  // gives up after a while and opens the chat anyway.
  const status = (await syncEngine.waitForSync(remote.id)) ?? linked;

  const session = await createSession(remote.name, remote.id).catch((err) => {
    logger.warn('could not create a session for the new folder', err);
    return null;
  });
  if (session) {
    showMainWindow();
    await loadApp(ROUTES.chat, { s: session.id });
    return { status, sessionId: session.id };
  }
  return { status };
}

/** Open a linked folder (or a file inside it) in the OS file manager. */
export function revealInFileManager(folderId: string, relPath?: string): void {
  const link = listLinks().find((l) => l.folderId === folderId);
  if (!link) throw new Error('that folder is not linked');
  if (!relPath) {
    void shell.openPath(link.localPath);
    return;
  }
  const target = resolveInside(link.localPath, relPath);
  if (!target) throw new Error('that path is outside the linked folder');
  shell.showItemInFolder(target);
}
