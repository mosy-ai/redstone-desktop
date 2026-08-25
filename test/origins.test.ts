/**
 * The renderer runs remote code, so the origin allowlist is the boundary that
 * decides what that code can reach. These cases are the ones that would be
 * expensive to get wrong.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedUrl, siblingSuffix } from '../src/shared/origins';

const APP = 'https://redstone-agent.yitec.dev';
const allowed = [APP, siblingSuffix(APP) as string];

test('the app origin is allowed', () => {
  assert.ok(isAllowedUrl(`${APP}/chat?s=1`, allowed));
  assert.ok(isAllowedUrl(`${APP}/api/v1/folders`, allowed));
});

test('sibling hosts on the same domain are allowed (the storage host)', () => {
  assert.ok(isAllowedUrl('https://storage.yitec.dev/bucket/key.png', allowed));
  assert.ok(isAllowedUrl('https://cdn.assets.yitec.dev/x.js', allowed));
});

test('everything else is blocked', () => {
  assert.ok(!isAllowedUrl('https://evil.example.com/steal', allowed));
  assert.ok(!isAllowedUrl('https://yitec.dev.evil.com/', allowed));
  assert.ok(!isAllowedUrl('https://notyitec.dev/', allowed));
});

test('the scheme is part of the match', () => {
  assert.ok(!isAllowedUrl('http://storage.yitec.dev/x', allowed));
  assert.ok(!isAllowedUrl('ftp://storage.yitec.dev/x', allowed));
  assert.ok(!isAllowedUrl('javascript:alert(1)', allowed));
});

test('the app may open a WebSocket to its own origin', () => {
  // The web app reconnects for live updates; blocking wss left it retrying
  // forever with no visible error. A socket to an allowed origin is the same
  // trust decision as https to it.
  assert.ok(isAllowedUrl('wss://redstone-agent.yitec.dev/ws', allowed));
  assert.ok(isAllowedUrl('wss://storage.yitec.dev/live', allowed));
});

test('WebSockets elsewhere are still blocked, and ws is not a downgrade route', () => {
  assert.ok(!isAllowedUrl('wss://evil.example.com/ws', allowed));
  // `ws:` maps to http:, which this https-only allowlist does not permit.
  assert.ok(!isAllowedUrl('ws://redstone-agent.yitec.dev/ws', allowed));
  // …but a plain-http dev deployment can use a plain-ws socket.
  assert.ok(isAllowedUrl('ws://localhost:3070/ws', ['http://localhost:3070']));
});

test('locally served schemes are always allowed', () => {
  assert.ok(isAllowedUrl('file:///Applications/Redstone.app/renderer/quick.html', allowed));
  assert.ok(isAllowedUrl('devtools://devtools/bundled/inspector.html', allowed));
  assert.ok(isAllowedUrl('data:image/png;base64,AAAA', allowed));
  assert.ok(isAllowedUrl('about:blank', allowed));
});

test('garbage is not allowed', () => {
  assert.ok(!isAllowedUrl('', allowed));
  assert.ok(!isAllowedUrl('not a url', allowed));
  assert.ok(!isAllowedUrl('//evil.com', allowed));
});

test('no wildcard is derived where it would be dangerous', () => {
  // A public suffix as parent would hand over an entire country.
  assert.equal(siblingSuffix('https://app.co.uk'), null);
  assert.equal(siblingSuffix('https://app.com.vn'), null);
  // …and there is nothing to widen for these either.
  assert.equal(siblingSuffix('http://localhost:3070'), null);
  assert.equal(siblingSuffix('https://example.com'), null);
  assert.equal(siblingSuffix('https://10.0.0.5:8080'), null);
  assert.equal(siblingSuffix('nonsense'), null);
});

test('a deep host still widens only one level', () => {
  assert.equal(siblingSuffix('https://a.b.example.com'), 'https://.b.example.com');
  assert.ok(!isAllowedUrl('https://c.example.com/', ['https://.b.example.com']));
});

test('a localhost deployment allows only itself', () => {
  const dev = ['http://localhost:3070'];
  assert.ok(isAllowedUrl('http://localhost:3070/chat', dev));
  assert.ok(!isAllowedUrl('http://localhost:9000/minio', dev));
  assert.ok(!isAllowedUrl('http://127.0.0.1:3070/', dev));
});
