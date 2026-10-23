/**
 * Deleting a folder in Finder must not bring it straight back.
 *
 * The bug this guards: directories had no sync record. Files did, so a file
 * that vanished from disk was read correctly as "the user deleted this" — but a
 * *directory* that vanished was indistinguishable from one that had simply
 * never been created here, and the planner's only answer to "on the server,
 * missing on disk" was `mkdir-local`. So the folder reappeared on the very next
 * cycle, every time, for as long as the link existed.
 *
 * `knownDirs` is the missing memory: the directories both sides agreed on at
 * the end of the last cycle. With it, gone-from-disk means deleted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planCycle } from '../src/main/sync/plan';
import type { FileRecord, LocalEntry, Op, RemoteRecord } from '../src/main/sync/types';

interface Scene {
  records?: FileRecord[];
  localFiles?: LocalEntry[];
  remoteFiles?: RemoteRecord[];
  localDirs?: string[];
  remoteDirs?: string[];
  knownDirs?: string[];
  truncated?: boolean;
}

const plan = (s: Scene): Op[] =>
  planCycle({
    records: new Map((s.records ?? []).map((r) => [r.relPath, r])),
    localFiles: new Map((s.localFiles ?? []).map((f) => [f.relPath, f])),
    remoteFiles: new Map((s.remoteFiles ?? []).map((f) => [f.path, f])),
    localDirs: new Set(s.localDirs ?? []),
    remoteDirs: new Set(s.remoteDirs ?? []),
    knownDirs: new Set(s.knownDirs ?? []),
    truncated: s.truncated ?? false,
  });

const kinds = (ops: Op[]): string[] => ops.map((o) => o.kind);

const remoteFile = (path: string, hash: string): RemoteRecord => ({
  path,
  isDir: false,
  size: 10,
  modified: '2026-10-23T10:00:00',
  hash,
});

const synced = (relPath: string, hash: string): FileRecord => ({
  relPath,
  localHash: hash,
  localMtimeMs: 1_000,
  localSize: 10,
  remoteHash: hash,
  remoteSize: 10,
  remoteMtime: '2026-10-23T10:00:00',
  state: 'synced',
});

test('a folder deleted in Finder is removed on the server, not recreated', () => {
  const ops = plan({
    // 'Reports' was in sync at the end of the last cycle; now it is gone from disk.
    knownDirs: ['Reports'],
    remoteDirs: ['Reports'],
  });
  assert.deepEqual(kinds(ops), ['rmdir-remote'], `got ${JSON.stringify(ops)}`);
});

test('a folder the server has and we have never seen is still created on disk', () => {
  const ops = plan({ remoteDirs: ['Shared'] });
  assert.deepEqual(kinds(ops), ['mkdir-local']);
});

test('a folder deleted on the server is removed from disk, not re-uploaded', () => {
  const ops = plan({ knownDirs: ['Reports'], localDirs: ['Reports'] });
  assert.deepEqual(kinds(ops), ['rmdir-local']);
});

test('a new local folder is still created on the server', () => {
  const ops = plan({ localDirs: ['Drafts'] });
  assert.deepEqual(kinds(ops), ['mkdir-remote']);
});

test('deleting a folder with files in it takes the files with it', () => {
  const ops = plan({
    knownDirs: ['Reports'],
    records: [synced('Reports/q3.pdf', 'aaa')],
    remoteDirs: ['Reports'],
    remoteFiles: [remoteFile('Reports/q3.pdf', 'aaa')],
  });
  // The file goes, and the folder with it — deepest path first, so the
  // directory is already empty by the time the server is asked to drop it.
  assert.deepEqual(kinds(ops), ['delete-remote', 'rmdir-remote']);
  assert.equal((ops[0] as { relPath: string }).relPath, 'Reports/q3.pdf');
});

test('a folder still holding a file on disk is not deleted locally', () => {
  const ops = plan({
    knownDirs: ['Reports'],
    localDirs: ['Reports'],
    // An ignored or brand-new file the server does not have: the folder is not
    // empty, so removing it would destroy something the user can see.
    localFiles: [{ relPath: 'Reports/notes.txt', size: 10, mtimeMs: 2_000, hash: 'bbb' }],
  });
  assert.ok(!kinds(ops).includes('rmdir-local'), `got ${JSON.stringify(kinds(ops))}`);
});

test('a folder both sides already have is recorded so the next delete is seen', () => {
  const ops = plan({ localDirs: ['Reports'], remoteDirs: ['Reports'] });
  assert.deepEqual(kinds(ops), ['settle-dir']);
});

test('a truncated listing is never read as a deleted folder', () => {
  const ops = plan({ knownDirs: ['Reports'], localDirs: ['Reports'], truncated: true });
  assert.deepEqual(kinds(ops), []);
});

test('and it stays gone on the cycle after that', () => {
  // Cycle 1: deleted in Finder, so the server copy goes.
  const first = plan({ knownDirs: ['Reports'], remoteDirs: ['Reports'] });
  assert.deepEqual(kinds(first), ['rmdir-remote']);

  // Applying `rmdir-remote` drops both the remote entry and the record, so the
  // next cycle sees a folder on neither side and has nothing left to say. The
  // old code reached `mkdir-local` here, and again, and again.
  const second = plan({});
  assert.deepEqual(kinds(second), []);
});

test('a folder gone from both sides stops being remembered', () => {
  const ops = plan({ knownDirs: ['Reports'] });
  assert.deepEqual(kinds(ops), ['forget-dir']);
});
