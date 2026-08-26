/**
 * The Redstone REST surface the shell uses, and nothing else.
 *
 * Contract: docs/folder-sync-api.md (tree/cursor, delete, move, stat, upload)
 * plus the two endpoints from the build spec — session creation and the
 * *proxied* attachment upload (`/attachments/upload`, never the presigned
 * variant: spec §6 says clients outside the server network cannot always reach
 * the storage host).
 *
 * Every call reads the token fresh (spec §4) and maps failures onto typed
 * errors the sync engine can act on.
 */
import { createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { getToken, reportUnauthorized } from '../auth';
import { apiBase } from '../settings';
import logger from '../logger';
import type { AttachmentRef, FolderListing, RemoteFolder, UploadConstraints } from '../../shared/types';
import { DEFAULT_UPLOAD_CONSTRAINTS } from '../../shared/constants';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
    message?: string,
  ) {
    super(message ?? `${endpoint} failed with ${status}`);
    this.name = 'ApiError';
  }
  get isAuth(): boolean {
    return this.status === 401;
  }
  get isMissing(): boolean {
    return this.status === 404;
  }
  get isConflict(): boolean {
    return this.status === 409;
  }
  /** 5xx, 429 and transport failures are worth retrying; 4xx are not. */
  get isRetryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export class SignedOutError extends ApiError {
  constructor(endpoint: string) {
    super(401, endpoint, 'not signed in');
    this.name = 'SignedOutError';
  }
}

export interface TreeEntry {
  path: string;
  isDir: boolean;
  size: number | null;
  modified: string | null;
  /** Bare sha256 hex (the `sha256:` prefix is stripped), null for directories. */
  hash: string | null;
}

export interface TreeResponse {
  cursor: string | null;
  unchanged: boolean;
  truncated: boolean;
  entries: TreeEntry[];
}

export interface UploadedEntry {
  name: string;
  isDir: boolean;
  size: number | null;
  modified: string | null;
}

interface RequestOptions {
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  body?: BodyInit;
  /** Endpoints that legitimately answer 404/409 handle it themselves. */
  expect?: number[];
  signal?: AbortSignal;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

async function request(endpoint: string, opts: RequestOptions = {}): Promise<Response> {
  const token = await getToken();
  if (!token) throw new SignedOutError(endpoint);

  const url = new URL(apiBase() + endpoint);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  let body = opts.body;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }

  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  let res: Response;
  try {
    res = await fetch(url, { method: opts.method ?? 'GET', headers, body, signal });
  } catch (err) {
    // Offline, DNS failure, TLS failure, timeout — all retryable.
    throw new ApiError(0, endpoint, (err as Error).message);
  }

  if (res.ok || opts.expect?.includes(res.status)) return res;

  if (res.status === 401) reportUnauthorized();
  let detail = '';
  try {
    detail = (await res.text()).slice(0, 2_000);
  } catch {
    /* body already consumed or empty */
  }
  throw new ApiError(res.status, endpoint, summariseErrorBody(detail, res.status, endpoint));
}

/**
 * What to put in the error, given a body that may not be from Redstone at all.
 *
 * A request that never reaches the server still comes back with a body: a
 * proxy's HTML error page. Using it verbatim buries the one fact worth having —
 * the status — under a screenful of markup, in the log and in anything the user
 * is shown. So HTML is reduced to its title and labelled as coming from
 * somewhere in between, and only a real API message is passed through.
 */
export function summariseErrorBody(body: string, status: number, endpoint: string): string {
  const text = body.trim();
  if (!text) return `${endpoint} failed with ${status}`;

  if (/^<(?:!doctype|html|\?xml)/i.test(text)) {
    const title = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(text)?.[1]?.trim();
    const where = title ? `: ${title}` : '';
    // Cloudflare and friends answer for the origin when it is slow or the body
    // is too big — worth saying, because "the server said no" would send the
    // user to the wrong place.
    return `${endpoint} failed with ${status} — an HTML error page from a proxy or gateway${where}`;
  }

  // JSON error envelopes are already short and specific; anything else is
  // capped so one runaway response cannot fill the log.
  return text.slice(0, 300);
}

const stripHash = (h: string | null | undefined): string | null =>
  h ? h.replace(/^sha256:/i, '') : null;

// --- folders -----------------------------------------------------------------

export async function listFolders(): Promise<FolderListing> {
  const res = await request('/folders');
  const data = (await res.json()) as {
    mount_ready?: boolean;
    items?: Array<{ id: string; name: string; created_at?: string; updated_at?: string }>;
  };
  return {
    mountReady: data.mount_ready !== false,
    items: (data.items ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      createdAt: f.created_at,
      updatedAt: f.updated_at,
    })),
  };
}

export async function createFolder(name: string): Promise<RemoteFolder> {
  const res = await request('/folders', { method: 'POST', json: { name } });
  const data = (await res.json()) as { id: string; name: string };
  return { id: data.id, name: data.name };
}

export async function renameFolder(folderId: string, name: string): Promise<void> {
  await request(`/folders/${encodeURIComponent(folderId)}`, { method: 'PATCH', json: { name } });
}

// --- tree / stat -------------------------------------------------------------

export async function getTree(
  folderId: string,
  cursor: string | null,
  opts: { hash?: boolean; signal?: AbortSignal } = {},
): Promise<TreeResponse> {
  const res = await request(`/folders/${encodeURIComponent(folderId)}/tree`, {
    query: { cursor: cursor ?? undefined, hash: opts.hash === false ? 'false' : 'true' },
    signal: opts.signal,
    timeoutMs: 120_000,
  });
  const data = (await res.json()) as {
    cursor?: string | null;
    unchanged?: boolean;
    truncated?: boolean;
    entries?: Array<{
      path: string;
      is_dir: boolean;
      size: number | null;
      modified: string | null;
      hash: string | null;
    }>;
  };
  return {
    cursor: data.cursor ?? null,
    unchanged: data.unchanged === true,
    truncated: data.truncated === true,
    entries: (data.entries ?? []).map((e) => ({
      path: e.path,
      isDir: e.is_dir,
      size: e.size ?? null,
      modified: e.modified ?? null,
      hash: stripHash(e.hash),
    })),
  };
}

export async function statEntry(folderId: string, relPath: string): Promise<TreeEntry | null> {
  const res = await request(`/folders/${encodeURIComponent(folderId)}/stat`, {
    query: { path: relPath },
    expect: [404],
  });
  if (res.status === 404) return null;
  const e = (await res.json()) as {
    path?: string;
    name?: string;
    is_dir: boolean;
    size: number | null;
    modified: string | null;
    hash: string | null;
  };
  return {
    path: e.path ?? relPath,
    isDir: e.is_dir,
    size: e.size ?? null,
    modified: e.modified ?? null,
    hash: stripHash(e.hash),
  };
}

// --- file transfer -----------------------------------------------------------

/** Streams to `destFile`; the caller renames it into place. */
export async function downloadFile(
  folderId: string,
  relPath: string,
  destFile: string,
  signal?: AbortSignal,
): Promise<void> {
  const res = await request(`/folders/${encodeURIComponent(folderId)}/download`, {
    query: { path: relPath },
    signal,
    timeoutMs: 15 * 60_000,
  });
  await fs.mkdir(path.dirname(destFile), { recursive: true });
  if (!res.body) {
    await fs.writeFile(destFile, Buffer.from(await res.arrayBuffer()));
    return;
  }
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(destFile));
}

/**
 * Upload one file into `dirPath` ('' for the root). The destination name comes
 * from the multipart filename, so a rename is *not* an upload — use `moveEntry`.
 */
export async function uploadFile(
  folderId: string,
  dirPath: string,
  filename: string,
  contents: Buffer,
  signal?: AbortSignal,
): Promise<UploadedEntry> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(contents)]), filename);
  const res = await request(`/folders/${encodeURIComponent(folderId)}/files`, {
    method: 'POST',
    query: { path: dirPath },
    body: form,
    signal,
    timeoutMs: 15 * 60_000,
  });
  const data = (await res.json().catch(() => ({}))) as {
    name?: string;
    is_dir?: boolean;
    size?: number | null;
    modified?: string | null;
  };
  return {
    name: data.name ?? filename,
    isDir: data.is_dir === true,
    size: data.size ?? contents.byteLength,
    modified: data.modified ?? null,
  };
}

export async function makeDirectory(folderId: string, parent: string, name: string): Promise<void> {
  await request(`/folders/${encodeURIComponent(folderId)}/mkdir`, {
    method: 'POST',
    json: { path: parent, name },
    // A directory that already exists is the outcome we wanted.
    expect: [409],
  });
}

export async function deleteEntry(
  folderId: string,
  relPath: string,
  recursive = false,
): Promise<'deleted' | 'missing' | 'not-empty'> {
  const res = await request(`/folders/${encodeURIComponent(folderId)}/files`, {
    method: 'DELETE',
    query: { path: relPath, recursive: recursive ? 'true' : undefined },
    expect: [404, 409],
  });
  if (res.status === 404) return 'missing';
  if (res.status === 409) return 'not-empty';
  return 'deleted';
}

export async function moveEntry(
  folderId: string,
  fromPath: string,
  toPath: string,
  overwrite = false,
): Promise<boolean> {
  const res = await request(`/folders/${encodeURIComponent(folderId)}/move`, {
    method: 'POST',
    json: { from_path: fromPath, to_path: toPath, overwrite },
    expect: [404, 409],
  });
  return res.ok;
}

// --- sessions and attachments ------------------------------------------------

export interface SessionDetail {
  id: string;
  name?: string;
  /** The Redstone folder this conversation works in, if it has one. */
  folderId: string | null;
}

export async function getSession(sessionId: string): Promise<SessionDetail | null> {
  const res = await request(`/sessions/${encodeURIComponent(sessionId)}`, { expect: [404] });
  if (res.status === 404) return null;
  const data = (await res.json()) as { id?: string; name?: string; folder_id?: string | null };
  return { id: data.id ?? sessionId, name: data.name, folderId: data.folder_id ?? null };
}

/**
 * Bind a folder to a conversation that already exists.
 *
 * The build spec only documents binding at creation time
 * (`POST /sessions {name, folder_id}`), and the deployed API has no documented
 * way to bind afterwards — so this probes the two shapes that would be natural
 * (`PATCH /sessions/{id}` like a rename, `PUT /sessions/{id}/folder` like the
 * existing knowledge-pinning route) and reports honestly when neither exists.
 * See docs/integration/01-bind-folder-to-session.md.
 */
export async function bindFolderToSession(
  sessionId: string,
  folderId: string,
): Promise<'ok' | 'unsupported'> {
  const id = encodeURIComponent(sessionId);
  const attempts: Array<{ endpoint: string; method: string }> = [
    { endpoint: `/sessions/${id}`, method: 'PATCH' },
    { endpoint: `/sessions/${id}/folder`, method: 'PUT' },
  ];
  for (const attempt of attempts) {
    const res = await request(attempt.endpoint, {
      method: attempt.method,
      json: { folder_id: folderId },
      expect: [404, 405, 422],
    });
    if (res.ok) {
      // A 200 from a rename-only PATCH would silently ignore folder_id, so the
      // response has to actually show the binding.
      const data = (await res.json().catch(() => ({}))) as { folder_id?: string | null };
      if (data.folder_id === folderId) return 'ok';
      continue;
    }
  }
  return 'unsupported';
}

/**
 * Detach the folder from a conversation. `PATCH` applies only the fields sent,
 * so an explicit `null` unbinds where an absent field would leave it alone.
 */
export async function unbindFolderFromSession(sessionId: string): Promise<boolean> {
  const res = await request(`/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    json: { folder_id: null },
    expect: [404, 405, 422],
  });
  if (!res.ok) return false;
  const data = (await res.json().catch(() => ({}))) as { folder_id?: string | null };
  return data.folder_id === null || data.folder_id === undefined;
}

export async function createSession(name: string, folderId?: string): Promise<{ id: string }> {
  const res = await request('/sessions', {
    method: 'POST',
    json: folderId ? { name, folder_id: folderId } : { name },
  });
  const data = (await res.json()) as { id?: string; session_id?: string };
  const id = data.id ?? data.session_id;
  if (!id) throw new ApiError(500, '/sessions', 'session response had no id');
  return { id };
}

export async function uploadAttachment(
  sessionId: string,
  filename: string,
  contents: Buffer,
  signal?: AbortSignal,
): Promise<AttachmentRef> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(contents)]), filename);
  const res = await request(`/sessions/${encodeURIComponent(sessionId)}/attachments/upload`, {
    method: 'POST',
    body: form,
    signal,
    timeoutMs: 15 * 60_000,
  });
  const data = (await res.json()) as {
    attachment_id?: string;
    id?: string;
    file_id?: string;
    filename?: string;
    size_bytes?: number;
  };
  const attachmentId = data.attachment_id ?? data.id;
  if (!attachmentId) {
    throw new ApiError(500, '/attachments/upload', 'upload response had no attachment id');
  }
  return {
    attachmentId,
    filename: data.filename ?? filename,
    sizeBytes: data.size_bytes ?? contents.byteLength,
  };
}

let constraintsCache: { at: number; value: UploadConstraints } | null = null;

/** Spec §6: read the limits at runtime rather than hardcoding them. */
export async function uploadConstraints(): Promise<UploadConstraints> {
  if (constraintsCache && Date.now() - constraintsCache.at < 30 * 60_000) {
    return constraintsCache.value;
  }
  try {
    const res = await request('/files/upload-constraints');
    const data = (await res.json()) as {
      max_file_bytes?: number;
      max_files_per_batch?: number;
    };
    const value: UploadConstraints = {
      maxFileBytes: data.max_file_bytes ?? DEFAULT_UPLOAD_CONSTRAINTS.maxFileBytes,
      maxFilesPerBatch: data.max_files_per_batch ?? DEFAULT_UPLOAD_CONSTRAINTS.maxFilesPerBatch,
    };
    constraintsCache = { at: Date.now(), value };
    return value;
  } catch (err) {
    logger.warn('upload-constraints unavailable, using defaults', err);
    return { ...DEFAULT_UPLOAD_CONSTRAINTS };
  }
}
