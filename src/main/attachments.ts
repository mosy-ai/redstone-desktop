/**
 * Local files into a chat (spec §6).
 *
 * The shell uploads and hands back `attachment_id`s. It never sends the message
 * — the web app owns composing, streaming and rendering.
 */
import { dialog, BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AttachmentRef } from '../shared/types';
import { uploadAttachment, uploadConstraints } from './api/client';
import logger, { relPathHint } from './logger';

/** The conversation the web app last told us about (via setTurnActive/setActiveSession). */
let activeSessionId: string | null = null;
/** True once the web app has told us itself, rather than us reading the URL. */
let webAppReports = false;

export type SessionSource = 'web-app' | 'url' | 'shell';

/**
 * Sources, and why the distinction matters:
 *
 *   'web-app' — the page told us through the bridge. Authoritative, and it
 *               retires the URL guess for good.
 *   'url'     — the shell read `/chat?s=…` because the web app has no bridge
 *               support on this deployment. A guess, applied only until the web
 *               app speaks.
 *   'shell'   — the shell's own bookkeeping (switching servers, the quick bar).
 *               It sets the value but claims nothing about who is reporting.
 *
 * The default is deliberately NOT 'web-app': an internal `setActiveSession(null)`
 * defaulting to that once convinced the shell the web app was driving, which
 * disabled the URL guess and left every session-scoped action with nothing to
 * act on.
 */
export function setActiveSession(sessionId: string | null, source: SessionSource = 'shell'): void {
  if (source === 'url' && webAppReports) return;
  if (source === 'web-app' && !webAppReports) {
    webAppReports = true;
    logger.info('web app reports the active session — no longer reading it from the URL');
  }
  if (sessionId === activeSessionId) return;
  activeSessionId = sessionId;
  logger.info(`active session changed (${source})`);
}

/** Whether the web app drives session tracking on this deployment. */
export function webAppDrivesSession(): boolean {
  return webAppReports;
}

export function getActiveSession(): string | null {
  return activeSessionId;
}

/**
 * The quick bar's own conversation, which is not the main window's.
 *
 * The bar creates a session on first send, so between "summoned" and "sent" it
 * has none — and a screenshot taken in that gap would otherwise land in whatever
 * chat the main window happens to be showing. Tracked separately so the shell
 * can hold the capture instead.
 */
let quickSessionId: string | null = null;

export function setQuickSession(sessionId: string | null): void {
  if (quickSessionId === sessionId) return;
  quickSessionId = sessionId;
  logger.info(`quick bar session ${sessionId ? 'claimed' : 'cleared'}`);
}

export function getQuickSession(): string | null {
  return quickSessionId;
}

export class NoActiveSessionError extends Error {
  constructor() {
    super('Open a conversation first, then attach the file.');
    this.name = 'NoActiveSessionError';
  }
}

export interface AttachOptions {
  sessionId?: string;
  /** Shown in the rejection dialog when a file is refused. */
  parent?: BrowserWindow | null;
}

/**
 * Upload paths in order, enforcing the server's own limits client-side so a
 * 2 GB file is refused here rather than after the bytes are on the wire.
 */
export async function uploadPaths(paths: string[], opts: AttachOptions = {}): Promise<AttachmentRef[]> {
  const sessionId = opts.sessionId ?? activeSessionId;
  if (!sessionId) throw new NoActiveSessionError();

  const limits = await uploadConstraints();
  const accepted: string[] = [];
  const rejected: string[] = [];

  for (const filePath of paths) {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile()) {
      rejected.push(`${path.basename(filePath)} — not a file`);
      continue;
    }
    if (stat.size > limits.maxFileBytes) {
      rejected.push(
        `${path.basename(filePath)} — over the ${Math.round(limits.maxFileBytes / (1024 * 1024))} MB limit`,
      );
      continue;
    }
    if (accepted.length >= limits.maxFilesPerBatch) {
      rejected.push(`${path.basename(filePath)} — over the ${limits.maxFilesPerBatch} file batch limit`);
      continue;
    }
    accepted.push(filePath);
  }

  if (rejected.length) {
    await dialog.showMessageBox({
      type: 'warning',
      title: 'Some files were not attached',
      message: `${rejected.length} file(s) could not be attached`,
      detail: rejected.join('\n'),
      buttons: ['OK'],
    });
  }

  const refs: AttachmentRef[] = [];
  for (const filePath of accepted) {
    const contents = await fs.readFile(filePath);
    const ref = await uploadAttachment(sessionId, path.basename(filePath), contents);
    logger.info('attachment uploaded', { file: relPathHint(path.basename(filePath)), bytes: contents.byteLength });
    refs.push(ref);
  }
  return refs;
}

/** Native picker (spec §6). */
export async function pickAndUpload(
  opts: AttachOptions & { multiple?: boolean } = {},
): Promise<AttachmentRef[]> {
  const parent = opts.parent ?? BrowserWindow.getFocusedWindow();
  const options: Electron.OpenDialogOptions = {
    title: 'Attach files to this conversation',
    buttonLabel: 'Attach',
    properties: opts.multiple === false ? ['openFile'] : ['openFile', 'multiSelections'],
  };
  // The parent-window overload is a different signature: passing `undefined`
  // into it makes Electron read the options as the window.
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return [];
  return uploadPaths(result.filePaths, opts);
}

/** Upload an in-memory buffer (screen captures). */
export async function uploadBuffer(
  filename: string,
  contents: Buffer,
  opts: AttachOptions = {},
): Promise<AttachmentRef> {
  const sessionId = opts.sessionId ?? activeSessionId;
  if (!sessionId) throw new NoActiveSessionError();
  return uploadAttachment(sessionId, filename, contents);
}
