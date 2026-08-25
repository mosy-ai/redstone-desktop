/**
 * The registry of folder links, and the path allowlist that goes with it.
 *
 * Spec §8 trust boundary: the renderer runs remote code, so a `localPath` is
 * only ever accepted if a native dialog in *this* session produced it. Paths
 * restored from disk are trusted because a dialog produced them in an earlier
 * session and the user has not unlinked them since.
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { JsonStore, userDataFile } from './store';
import logger from './logger';

export interface FolderLink {
  folderId: string;
  folderName: string;
  localPath: string;
  createdAt: string;
  paused: boolean;
  /**
   * The Redstone instance this link belongs to. A folder id means nothing on
   * another server, so a link is only ever synced while its own server is the
   * active one (spec §5: one Redstone folder ↔ one local directory).
   */
  serverOrigin: string;
  /**
   * The conversation this link was created from. The server's
   * `session.folder_id` is the authority; this is the fallback for deployments
   * that do not expose it yet.
   */
  sessionId?: string;
}

interface LinkFile {
  version: 1;
  links: FolderLink[];
}

let store: JsonStore<LinkFile> | null = null;

/** Paths a native dialog returned during this run. */
const dialogApproved = new Set<string>();

export async function initLinks(): Promise<void> {
  store = await JsonStore.open<LinkFile>(userDataFile('links.json'), { version: 1, links: [] });
  for (const link of listLinks()) dialogApproved.add(normalise(link.localPath));
}

export function normalise(p: string): string {
  const resolved = path.resolve(p);
  // Windows paths are case-insensitive; comparing raw strings would let
  // `C:\Users\x` and `c:\users\x` disagree about the same folder.
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function approvePath(p: string): void {
  dialogApproved.add(normalise(p));
}

export function isApproved(p: string): boolean {
  return dialogApproved.has(normalise(p));
}

export function listLinks(): FolderLink[] {
  return store ? [...store.get().links] : [];
}

/** Links belonging to one server — what the sync engine actually runs. */
export function linksForServer(origin: string | null): FolderLink[] {
  if (!origin) return [];
  return listLinks().filter((l) => l.serverOrigin === origin);
}

export function getLink(folderId: string): FolderLink | undefined {
  return listLinks().find((l) => l.folderId === folderId);
}

export function getLinkForPath(localPath: string): FolderLink | undefined {
  const key = normalise(localPath);
  return listLinks().find((l) => normalise(l.localPath) === key);
}

export async function addLink(
  link: Omit<FolderLink, 'createdAt' | 'paused'>,
): Promise<FolderLink> {
  if (!store) throw new Error('links not initialised');
  if (!isApproved(link.localPath)) {
    throw new Error('that folder was not chosen through a Redstone file dialog');
  }
  const stat = await fs.stat(link.localPath).catch(() => null);
  if (!stat?.isDirectory()) throw new Error('that path is not a directory');

  const existing = getLink(link.folderId);
  if (existing && normalise(existing.localPath) !== normalise(link.localPath)) {
    throw new Error('that Redstone folder is already linked to a different directory');
  }
  const clash = getLinkForPath(link.localPath);
  if (clash && clash.folderId !== link.folderId) {
    throw new Error('that directory is already linked to a different Redstone folder');
  }

  const record: FolderLink = {
    ...link,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    paused: existing?.paused ?? false,
  };
  store.update((draft) => {
    draft.links = draft.links.filter((l) => l.folderId !== link.folderId);
    draft.links.push(record);
  });
  await store.flush();
  logger.info('link added', { folderId: record.folderId });
  return record;
}

/** Correct a link's display name — used to repair links saved with a raw id. */
export async function setLinkName(folderId: string, folderName: string): Promise<void> {
  if (!store) return;
  store.update((draft) => {
    const link = draft.links.find((l) => l.folderId === folderId);
    if (link) link.folderName = folderName;
  });
  await store.flush();
}

export async function removeLink(folderId: string): Promise<void> {
  if (!store) return;
  store.update((draft) => {
    draft.links = draft.links.filter((l) => l.folderId !== folderId);
  });
  await store.flush();
  logger.info('link removed', { folderId });
}

export async function setPaused(folderId: string, paused: boolean): Promise<void> {
  if (!store) return;
  store.update((draft) => {
    const link = draft.links.find((l) => l.folderId === folderId);
    if (link) link.paused = paused;
  });
  await store.flush();
}

/**
 * Resolve `relPath` inside a link root, refusing anything that escapes it.
 * `..`, absolute paths and symlinked parents all end here.
 */
export function resolveInside(root: string, relPath: string): string | null {
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, relPath);
  const rel = path.relative(rootResolved, target);
  if (rel === '') return target;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}

export function flushLinks(): Promise<void> {
  return store ? store.flush() : Promise.resolve();
}
