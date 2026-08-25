/**
 * Acceptance criterion 11: "no token, file path, or file content appears in any
 * log the app writes". The logger routes every message through `scrub`, so
 * these cases are what that criterion actually rests on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, relPathHint, scrub } from '../src/shared/redact';

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';

test('JWTs are scrubbed, bare and in a header', () => {
  assert.equal(redact(JWT), '<token>');
  assert.equal(redact(`Authorization: Bearer ${JWT}`), 'Authorization: <token>');
  assert.ok(!redact(`token=${JWT} rest`).includes('eyJ'));
});

test('opaque bearer tokens are scrubbed even when they are not JWTs', () => {
  assert.equal(redact('Bearer sk-live-abc123def456ghi789'), '<token>');
});

test('filesystem paths become stable digests', () => {
  const line = redact('uploading /Users/anh/Documents/q3-report/salary.xlsx now');
  assert.ok(!line.includes('salary'));
  assert.ok(!line.includes('anh'));
  assert.match(line, /^uploading <path:[0-9a-f]{8}> now$/);
  // Stable within a run, so one file can be followed through a cycle.
  assert.equal(redact('/Users/anh/a.txt'), redact('/Users/anh/a.txt'));
  assert.notEqual(redact('/Users/anh/a.txt'), redact('/Users/anh/b.txt'));
});

test('Windows and UNC paths are scrubbed too', () => {
  assert.match(redact('C:\\Users\\Anh\\Desktop\\notes.md'), /^<path:[0-9a-f]{8}>$/);
  assert.match(redact('\\\\nas\\share\\payroll.xlsx'), /^<path:[0-9a-f]{8}>$/);
});

test('URL paths survive — they are useful and reveal nothing', () => {
  assert.equal(redact('GET /api/v1/folders/abc/tree'), 'GET /api/v1/folders/abc/tree');
  assert.equal(
    redact('https://redstone-agent.yitec.dev/api/v1/sessions'),
    'https://redstone-agent.yitec.dev/api/v1/sessions',
  );
});

test('sensitive object keys are dropped whatever they hold', () => {
  const scrubbed = scrub({
    token: JWT,
    Authorization: `Bearer ${JWT}`,
    cookie: 'rs_token=abc',
    password: 'hunter2',
    folderId: 'abc-123',
  }) as Record<string, unknown>;
  assert.equal(scrubbed.token, '<redacted>');
  assert.equal(scrubbed.Authorization, '<redacted>');
  assert.equal(scrubbed.cookie, '<redacted>');
  assert.equal(scrubbed.password, '<redacted>');
  assert.equal(scrubbed.folderId, 'abc-123', 'ids are not secrets and stay readable');
});

test('nested structures and errors are scrubbed', () => {
  const scrubbed = scrub({
    files: [{ path: '/Users/anh/secret-plan.md' }],
    err: new Error(`failed for /Volumes/Work/deal.docx with ${JWT}`),
  }) as { files: Array<{ path: string }>; err: Error };
  assert.match(scrubbed.files[0]!.path, /^<path:[0-9a-f]{8}>$/);
  assert.ok(!scrubbed.err.message.includes('deal.docx'));
  assert.ok(!scrubbed.err.message.includes('eyJ'));
});

test('deep nesting terminates rather than recursing forever', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.doesNotThrow(() => scrub(cyclic));
});

test('relPathHint keeps the extension and nothing else', () => {
  const hint = relPathHint('reports/2026/Q3 salary review.xlsx');
  assert.match(hint, /^<file:[0-9a-f]{8}\.xlsx>$/);
  assert.ok(!hint.includes('salary'));
});
