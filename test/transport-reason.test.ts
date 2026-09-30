/**
 * Naming the reason a request never reached the server.
 *
 * The bug this guards: eight minutes of failing folder sync produced eight
 * minutes of `ApiError: fetch failed` in the log and nothing else. Node puts
 * every transport failure behind that one phrase and keeps the real reason in
 * `cause`, so the log could not distinguish a dropped Wi-Fi from a dead
 * resolver from a gateway closing the socket — and those have three different
 * owners. Each case below is the shape Node actually throws.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { transportReason } from '../src/main/api/client';

/** What `fetch` rejects with: a bare wrapper, the reason one level down. */
const nodeFetchFailure = (cause: Error): TypeError => {
  const err = new TypeError('fetch failed');
  (err as { cause?: unknown }).cause = cause;
  return err;
};

const withCode = (message: string, code: string): Error => {
  const err = new Error(message);
  (err as { code?: string }).code = code;
  return err;
};

test('the reason survives the wrapper', () => {
  const reset = nodeFetchFailure(withCode('read ECONNRESET', 'ECONNRESET'));
  const dns = nodeFetchFailure(withCode('getaddrinfo EAI_AGAIN chatredstone.com', 'EAI_AGAIN'));
  const closed = nodeFetchFailure(new Error('other side closed'));

  // The old code reported `err.message`, which is this for all three.
  assert.equal(reset.message, 'fetch failed');
  assert.equal(dns.message, 'fetch failed');
  assert.equal(closed.message, 'fetch failed');

  const told = [reset, dns, closed].map(transportReason);
  assert.ok(told[0]!.includes('ECONNRESET'), told[0]);
  assert.ok(told[1]!.includes('EAI_AGAIN'), told[1]);
  assert.ok(told[2]!.includes('other side closed'), told[2]);
  assert.equal(new Set(told).size, 3, `three failures must read differently: ${told.join(' / ')}`);
});

test('a reason nested two deep is still found', () => {
  const inner = withCode('Client network socket disconnected', 'ECONNRESET');
  const middle = new Error('fetch failed');
  (middle as { cause?: unknown }).cause = inner;
  assert.ok(transportReason(nodeFetchFailure(middle)).includes('socket disconnected'));
});

test('a code is not repeated when the message already carries it', () => {
  const told = transportReason(nodeFetchFailure(withCode('read ECONNRESET', 'ECONNRESET')));
  assert.equal(told.match(/ECONNRESET/g)?.length, 1, told);
});

test('a wrapper with nothing under it still reads as a failure', () => {
  assert.equal(transportReason(new TypeError('fetch failed')), 'fetch failed');
});

test('a cause cycle does not hang', () => {
  const a = new Error('fetch failed');
  const b = withCode('socket hang up', 'ECONNRESET');
  (a as { cause?: unknown }).cause = b;
  (b as { cause?: unknown }).cause = a;
  assert.ok(transportReason(a).includes('socket hang up'));
});
