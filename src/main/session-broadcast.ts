/**
 * Tells every window which conversation is open, and what its folder looks like.
 *
 * Kept apart from `ipc.ts` so the window layer can announce a navigation without
 * importing the whole IPC surface (and the cycle that would come with it).
 */
import { webContents } from 'electron';
import { IPC } from '../shared/types';
import { sessionFolderState } from './session-folder';
import logger from './logger';

export async function announceSession(
  sessionId: string | null,
  onChatRoute = false,
): Promise<void> {
  let state;
  try {
    state = { ...(await sessionFolderState(sessionId)), onChatRoute };
  } catch (err) {
    logger.warn('could not resolve the session folder', err);
    state = {
      sessionId,
      onChatRoute,
      folderId: null,
      folderName: null,
      link: null,
      webAppRendersFolderControl: false,
    };
  }
  for (const contents of webContents.getAllWebContents()) {
    if (!contents.isDestroyed()) contents.send(IPC.sessionChanged, state);
  }
}
