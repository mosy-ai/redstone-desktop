/**
 * Server-address handling. People type `acme.redstone.dev`, paste
 * `https://acme.redstone.dev/chat?s=123`, and add trailing slashes — all three
 * mean the same instance, and none of them should reach the rest of the app in
 * that shape.
 *
 * `normaliseOrigin` is imported from the module the main process uses; it
 * touches nothing but the URL parser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseOrigin } from '../src/main/servers';

test('a bare host becomes https', () => {
  assert.equal(normaliseOrigin('redstone.acme.com'), 'https://redstone.acme.com');
  assert.equal(normaliseOrigin('  redstone.acme.com  '), 'https://redstone.acme.com');
});

test('paths, queries and trailing slashes are dropped', () => {
  assert.equal(normaliseOrigin('https://redstone.acme.com/'), 'https://redstone.acme.com');
  assert.equal(normaliseOrigin('https://redstone.acme.com/chat?s=abc'), 'https://redstone.acme.com');
  assert.equal(normaliseOrigin('redstone.acme.com/login'), 'https://redstone.acme.com');
});

test('an explicit scheme is respected', () => {
  assert.equal(normaliseOrigin('http://localhost:3070'), 'http://localhost:3070');
  assert.equal(normaliseOrigin('https://localhost:3070'), 'https://localhost:3070');
});

test('ports and single-label hosts survive — self-hosting is the point', () => {
  assert.equal(normaliseOrigin('localhost:3070'), 'https://localhost:3070');
  assert.equal(normaliseOrigin('http://redstone:3071'), 'http://redstone:3071');
  assert.equal(normaliseOrigin('192.168.1.20:8080'), 'https://192.168.1.20:8080');
});

test('the default port is not spelled out', () => {
  assert.equal(normaliseOrigin('https://redstone.acme.com:443'), 'https://redstone.acme.com');
  assert.equal(normaliseOrigin('http://redstone.acme.com:80'), 'http://redstone.acme.com');
});

test('nonsense is rejected rather than guessed at', () => {
  assert.equal(normaliseOrigin(''), null);
  assert.equal(normaliseOrigin('   '), null);
  assert.equal(normaliseOrigin('file:///etc/passwd'), null);
  assert.equal(normaliseOrigin('javascript:alert(1)'), null);
  assert.equal(normaliseOrigin('ftp://redstone.acme.com'), null);
  assert.equal(normaliseOrigin('http://'), null);
});

test('case in the host does not create a second server', () => {
  assert.equal(normaliseOrigin('HTTPS://Redstone.ACME.com'), 'https://redstone.acme.com');
});
