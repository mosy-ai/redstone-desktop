/**
 * Folder linking, scoped to a conversation.
 *
 * A link is not an app-level setting — it belongs to the chat you are in. The
 * server owns the binding (a session works inside a Redstone folder); the shell
 * owns the second half of it, mapping that folder to a directory on this
 * machine. Both halves have to agree, and both survive a restart:
 *
 *   chat session ──(server: session.folder_id)──> Redstone folder
 *                                                      │
 *                          (local: links.json)         ▼
 *                                            ~/Projects/q3-report
 *
 * So the shell always resolves in that order — ask the server what folder this
 * conversation uses, then look for a local link to it. A link recorded against a
 * session id is only a fallback for when the server cannot answer.
 */
import { BrowserWindow, dialog } from 'electron';
import path from 'node:path';
import type { LinkStatus, SessionFolderState } from '../shared/types';
import { SYNC } from '../shared/constants';
import {
  bindFolderToSession,
  createFolder,
  createSession,
  getSession,
  listFolders,
  unbindFolderFromSession,
} from './api/client';
import { getLinkForPath, listLinks } from './links';
import { rememberFolderControl, serverRendersFolderControl } from './servers';
import { syncEngine } from './sync/engine';
import { confirmSurvey, pickFolder } from './folder-flow';
import { loadApp } from './windows/main-window';
import { ROUTES } from '../shared/constants';
import logger from './logger';

// The shape is shared with the preload and the renderer — one definition, in
// shared/types.ts, or the two drift and only the renderer notices.
export type { SessionFolderState } from '../shared/types';

const EMPTY: SessionFolderState = {
  sessionId: null,
  onChatRoute: false,
  folderId: null,
  folderName: null,
  link: null,
  webAppRendersFolderControl: false,
};

/**
 * Set the first time the web app asks about a conversation's folder, which it
 * only does if it is rendering a control of its own. The shell's chrome bar
 * hides its duplicate the moment this flips — two "Link a folder" buttons on one
 * screen is worse than either alone.
 */
let webAppRendersFolderControl = false;

export function noteWebAppRendersFolderControl(): boolean {
  if (webAppRendersFolderControl || serverRendersFolderControl()) {
    webAppRendersFolderControl = true;
    return false;
  }
  webAppRendersFolderControl = true;
  logger.info('the web app renders its own folder control — the shell will stop showing one');
  void rememberFolderControl();
  return true;
}

export function webAppOwnsFolderControl(): boolean {
  return webAppRendersFolderControl || serverRendersFolderControl();
}

/** Short cache so navigating around a conversation does not re-ask every time. */
const cache = new Map<string, { at: number; folderId: string | null; folderName: string | null }>();
const CACHE_MS = 15_000;

export function forgetSessionFolder(sessionId: string): void {
  cache.delete(sessionId);
}

async function resolveFolder(
  sessionId: string,
): Promise<{ folderId: string | null; folderName: string | null }> {
  const hit = cache.get(sessionId);
  if (hit && Date.now() - hit.at < CACHE_MS) return { folderId: hit.folderId, folderName: hit.folderName };

  let folderId: string | null = null;
  try {
    folderId = (await getSession(sessionId))?.folderId ?? null;
  } catch (err) {
    logger.warn('could not read the session', err);
  }

  // The server did not say (older deployment, or the field is not exposed yet):
  // fall back to what this machine recorded when the link was made.
  if (!folderId) {
    folderId = listLinks().find((l) => l.sessionId === sessionId)?.folderId ?? null;
  }

  let folderName: string | null = null;
  if (folderId) {
    folderName =
      listLinks().find((l) => l.folderId === folderId)?.folderName ??
      (await listFolders()
        .then(({ items }) => items.find((f) => f.id === folderId)?.name ?? null)
        .catch(() => null));
  }

  cache.set(sessionId, { at: Date.now(), folderId, folderName });
  return { folderId, folderName };
}

/** What the chat's folder control should show right now. */
export async function sessionFolderState(sessionId: string | null): Promise<SessionFolderState> {
  if (!sessionId) return EMPTY;
  const { folderId, folderName } = await resolveFolder(sessionId);
  const link = folderId ? (syncEngine.status(folderId) ?? null) : null;
  return {
    sessionId,
    onChatRoute: true,
    folderId,
    folderName,
    link,
    webAppRendersFolderControl: webAppOwnsFolderControl(),
  };
}

/**
 * Link a directory on this machine to the conversation the user is in.
 *
 * Reuses the session's existing folder when it has one — that is the case where
 * the agent already has a working directory and we are only adding the local
 * mirror. Otherwise a folder is created and bound to this conversation.
 */
export async function linkFolderToSession(
  sessionId: string,
  parent?: BrowserWindow | null,
): Promise<LinkStatus | null> {
  const localPath = await pickFolder(parent);
  if (!localPath) return null;

  const already = getLinkForPath(localPath);
  if (already) {
    syncEngine.syncNow(already.folderId);
    return syncEngine.status(already.folderId) ?? null;
  }

  if (!(await confirmSurvey(localPath))) return null;

  const { mountReady } = await listFolders();
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

  const existing = await resolveFolder(sessionId);
  let folderId = existing.folderId;
  let folderName = existing.folderName ?? path.basename(localPath);

  if (folderId) {
    // The conversation already works in a folder — mirror that one rather than
    // creating a second, which would leave the agent looking at the wrong files.
    const { response } = await dialog.showMessageBox({
      type: 'question',
      title: 'Mirror this conversation’s folder?',
      message: `This chat already works in “${folderName}”`,
      detail:
        `Keep “${path.basename(localPath)}” on this Mac in sync with it? Files from both sides are ` +
        'merged, and a conflict keeps both copies.',
      buttons: ['Sync with this folder', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return null;
  } else {
    const created = await createFolder(path.basename(localPath));
    folderId = created.id;
    folderName = created.name;

    const bound = await bindFolderToSession(sessionId, folderId);
    if (bound === 'unsupported') {
      forgetSessionFolder(sessionId);
      return offerBoundChatInstead(folderId, folderName, localPath);
    }
  }

  forgetSessionFolder(sessionId);
  const status = await syncEngine.link(folderId, folderName, localPath, sessionId);
  logger.info('folder linked to session');
  return status;
}

/**
 * The backend cannot bind a folder to an existing conversation yet
 * (docs/integration/01-bind-folder-to-session.md). Rather than fail, offer the one path the
 * documented API does support: a new conversation created against the folder.
 */
async function offerBoundChatInstead(
  folderId: string,
  folderName: string,
  localPath: string,
): Promise<LinkStatus | null> {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: 'This chat cannot take a folder yet',
    message: 'Redstone cannot attach a folder to a conversation that already exists',
    detail:
      'The server only supports binding a folder when the conversation is created. Redstone can ' +
      `start a new chat that works in “${folderName}” and keep it in sync with ` +
      `“${path.basename(localPath)}” on this Mac.`,
    buttons: ['Start a new chat in this folder', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return null;

  const session = await createSession(folderName, folderId);
  const status = await syncEngine.link(folderId, folderName, localPath, session.id);
  await syncEngine.waitForSync(folderId);
  await loadApp(ROUTES.chat, { s: session.id });
  return status;
}

/** Stop mirroring the folder this conversation uses. Local files are untouched. */
export async function unlinkSessionFolder(sessionId: string): Promise<void> {
  const { folderId } = await resolveFolder(sessionId);
  if (!folderId) return;
  const link = listLinks().find((l) => l.folderId === folderId);
  if (!link) return;

  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: 'Stop syncing this folder?',
    message: `Stop syncing “${link.folderName}” with this Mac?`,
    detail:
      `Your files in “${link.localPath}” stay exactly where they are, and so do the files in ` +
      'Redstone. Choose whether this conversation should keep working in that folder.',
    buttons: ['Stop syncing', 'Stop syncing and detach the folder', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
  });
  if (response === 2) return;

  await syncEngine.unlink(folderId);

  if (response === 1) {
    // The server takes an explicit null to unbind; absent would leave it alone.
    const detached = await unbindFolderFromSession(sessionId).catch(() => false);
    if (!detached) {
      await dialog.showMessageBox({
        type: 'warning',
        title: 'Syncing stopped',
        message: 'Syncing stopped, but the conversation still uses that folder',
        detail: 'The server did not accept the change. The agent will keep working in it.',
        buttons: ['OK'],
      });
    }
  }
  forgetSessionFolder(sessionId);
}

export const SURVEY_LIMITS = SYNC;
