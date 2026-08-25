/**
 * The sync classification table, exercised directly.
 *
 * Every case here maps to a row of docs/folder-sync-api.md §4 or to one of the
 * three rules that outrank tidiness: hashes decide, `truncated` never means
 * deleted, conflicts keep both.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planCycle, conflictCopyPath, orderOps } from '../src/main/sync/plan';
import type { FileRecord, LocalEntry, Op, RemoteRecord } from '../src/main/sync/types';

const record = (relPath: string, localHash: string, remoteHash = localHash): FileRecord => ({
  relPath,
  localHash,
  localMtimeMs: 1_000,
  localSize: 10,
  remoteHash,
  remoteSize: 10,
  remoteMtime: '2026-08-11T10:00:00',
  state: 'synced',
});

const local = (relPath: string, hash: string): LocalEntry => ({
  relPath,
  size: 10,
  mtimeMs: 2_000,
  hash,
});

const remote = (path: string, hash: string): RemoteRecord => ({
  path,
  isDir: false,
  size: 10,
  modified: '2026-08-11T11:00:00',
  hash,
});

interface Scenario {
  records?: FileRecord[];
  localFiles?: LocalEntry[];
  remoteFiles?: RemoteRecord[];
  localDirs?: string[];
  remoteDirs?: string[];
  truncated?: boolean;
  isParked?: (op: Op) => boolean;
}

const plan = (scenario: Scenario): Op[] =>
  planCycle({
    records: new Map((scenario.records ?? []).map((r) => [r.relPath, r])),
    localFiles: new Map((scenario.localFiles ?? []).map((f) => [f.relPath, f])),
    remoteFiles: new Map((scenario.remoteFiles ?? []).map((f) => [f.path, f])),
    localDirs: new Set(scenario.localDirs ?? []),
    remoteDirs: new Set(scenario.remoteDirs ?? []),
    truncated: scenario.truncated ?? false,
    isParked: scenario.isParked,
  });

const kinds = (ops: Op[]): string[] => ops.map((o) => o.kind);

test('a file only on disk is uploaded', () => {
  const ops = plan({ localFiles: [local('notes.md', 'aaa')] });
  assert.deepEqual(kinds(ops), ['upload']);
});

test('a file only on the server is downloaded', () => {
  const ops = plan({ remoteFiles: [remote('notes.md', 'bbb')] });
  assert.deepEqual(kinds(ops), ['download']);
});

test('identical new files on both sides are just recorded', () => {
  const ops = plan({
    localFiles: [local('notes.md', 'same')],
    remoteFiles: [remote('notes.md', 'same')],
  });
  assert.deepEqual(kinds(ops), ['settle']);
});

test('local changed, remote unchanged → upload', () => {
  const ops = plan({
    records: [record('notes.md', 'v1')],
    localFiles: [local('notes.md', 'v2')],
    remoteFiles: [remote('notes.md', 'v1')],
  });
  assert.deepEqual(kinds(ops), ['upload']);
});

test('remote changed, local unchanged → download', () => {
  const ops = plan({
    records: [record('notes.md', 'v1')],
    localFiles: [local('notes.md', 'v1')],
    remoteFiles: [remote('notes.md', 'v2')],
  });
  assert.deepEqual(kinds(ops), ['download']);
});

test('both changed → conflict, never a silent overwrite', () => {
  const ops = plan({
    records: [record('notes.md', 'v1')],
    localFiles: [local('notes.md', 'mine')],
    remoteFiles: [remote('notes.md', 'theirs')],
  });
  assert.deepEqual(kinds(ops), ['conflict']);
});

test('both changed to the same bytes is convergence, not a conflict', () => {
  const ops = plan({
    records: [record('notes.md', 'v1')],
    localFiles: [local('notes.md', 'v2')],
    remoteFiles: [remote('notes.md', 'v2')],
  });
  assert.deepEqual(kinds(ops), ['settle']);
});

test('a hash mismatch with neither side changed keeps both copies', () => {
  // Reachable only when an earlier cycle died between writing and recording.
  const ops = plan({
    records: [record('notes.md', 'localv1', 'remotev1')],
    localFiles: [local('notes.md', 'localv1')],
    remoteFiles: [remote('notes.md', 'remotev1')],
  });
  assert.deepEqual(kinds(ops), ['conflict']);
});

test('local deletion propagates to the server', () => {
  const ops = plan({
    records: [record('notes.md', 'v1')],
    remoteFiles: [remote('notes.md', 'v1')],
  });
  assert.deepEqual(kinds(ops), ['delete-remote']);
});

test('remote deletion removes the local file', () => {
  const ops = plan({
    records: [record('notes.md', 'v1')],
    localFiles: [local('notes.md', 'v1')],
  });
  assert.deepEqual(kinds(ops), ['delete-local']);
});

test('deleted locally but edited remotely resurrects rather than loses', () => {
  const ops = plan({
    records: [record('notes.md', 'v1')],
    remoteFiles: [remote('notes.md', 'v2')],
  });
  assert.deepEqual(kinds(ops), ['download']);
});

test('deleted remotely but edited locally re-uploads rather than loses', () => {
  const ops = plan({
    records: [record('notes.md', 'v1')],
    localFiles: [local('notes.md', 'v2')],
  });
  assert.deepEqual(kinds(ops), ['upload']);
});

test('a truncated listing never means deletion', () => {
  const ops = plan({
    records: [record('notes.md', 'v1'), record('deep/file.md', 'v1')],
    localFiles: [local('notes.md', 'v1'), local('deep/file.md', 'v1')],
    truncated: true,
  });
  assert.deepEqual(ops, []);
});

test('a local rename becomes one move, not a delete plus a full upload', () => {
  const ops = plan({
    records: [record('notes.md', 'same')],
    localFiles: [local('docs/readme.md', 'same')],
    remoteFiles: [remote('notes.md', 'same')],
  });
  assert.deepEqual(kinds(ops), ['move-remote']);
  const move = ops[0] as Extract<Op, { kind: 'move-remote' }>;
  assert.equal(move.from, 'notes.md');
  assert.equal(move.to, 'docs/readme.md');
});

test('a remote rename moves the local file instead of re-downloading it', () => {
  const ops = plan({
    records: [record('notes.md', 'same')],
    localFiles: [local('notes.md', 'same')],
    remoteFiles: [remote('docs/readme.md', 'same')],
  });
  assert.deepEqual(kinds(ops), ['move-local']);
});

test('a rename is not claimed when the other side also changed', () => {
  // Same hash appears at a new path, but the old path's remote copy moved on —
  // treating it as a rename would discard the remote edit.
  const ops = plan({
    records: [record('notes.md', 'same')],
    localFiles: [local('copy.md', 'same')],
    remoteFiles: [remote('notes.md', 'edited')],
  });
  assert.ok(!kinds(ops).includes('move-remote'));
  assert.ok(kinds(ops).includes('upload')); // the new local file
  assert.ok(kinds(ops).includes('download')); // the remote edit at the old path
});

test('empty directories are mirrored, populated ones are not', () => {
  const ops = plan({
    localFiles: [local('src/main.ts', 'a')],
    localDirs: ['src', 'empty'],
    remoteFiles: [remote('src/main.ts', 'a')],
    remoteDirs: ['src'],
  });
  assert.deepEqual(kinds(ops), ['mkdir-remote', 'settle']);
  assert.equal((ops[0] as Extract<Op, { kind: 'mkdir-remote' }>).relPath, 'empty');
});

test('parked work is dropped from the plan', () => {
  const ops = plan({
    localFiles: [local('notes.md', 'aaa')],
    isParked: (op) => op.kind === 'upload',
  });
  assert.deepEqual(ops, []);
});

test('ordering: conflicts and downloads land before uploads', () => {
  const ops = orderOps([
    { kind: 'upload', relPath: 'a.md', local: local('a.md', '1') },
    { kind: 'download', relPath: 'b.md', remote: remote('b.md', '2') },
    { kind: 'conflict', relPath: 'c.md', remote: remote('c.md', '3'), local: local('c.md', '4') },
  ]);
  assert.deepEqual(kinds(ops), ['conflict', 'download', 'upload']);
});

test('ordering: directories are created before their contents', () => {
  const ops = orderOps([
    { kind: 'mkdir-local', relPath: 'a/b/c' },
    { kind: 'mkdir-local', relPath: 'a' },
  ]);
  assert.deepEqual(
    ops.map((o) => (o as Extract<Op, { kind: 'mkdir-local' }>).relPath),
    ['a', 'a/b/c'],
  );
});

test('ordering: deletions go children first', () => {
  const ops = orderOps([
    { kind: 'delete-remote', relPath: 'a' },
    { kind: 'delete-remote', relPath: 'a/b/c.md' },
  ]);
  assert.deepEqual(
    ops.map((o) => (o as Extract<Op, { kind: 'delete-remote' }>).relPath),
    ['a/b/c.md', 'a'],
  );
});

test('conflict copies are named exactly as the spec says', () => {
  const when = new Date(2026, 7, 11, 10, 43);
  assert.equal(conflictCopyPath('notes.md', when), "notes (Redstone's copy 2026-08-11 1043).md");
  assert.equal(
    conflictCopyPath('src/deep/report.final.docx', when),
    "src/deep/report.final (Redstone's copy 2026-08-11 1043).docx",
  );
  assert.equal(conflictCopyPath('Makefile', when), "Makefile (Redstone's copy 2026-08-11 1043)");
  // A dotfile keeps its leading dot rather than being read as an extension.
  assert.equal(conflictCopyPath('.eslintrc', when), ".eslintrc (Redstone's copy 2026-08-11 1043)");
});
