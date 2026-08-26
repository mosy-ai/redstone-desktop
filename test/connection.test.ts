/**
 * Reconnection behaviour after a bad network.
 *
 * The bug these guard: on a weak connection the window reloaded on a fixed
 * timer, so it flashed between the web app and the error screen — and, because
 * the retry went through "open the main window", it stole focus every fifteen
 * seconds. Two properties stop that. The wait has to *grow*, and the message
 * has to say which failure this is, so the user knows whether to check their
 * Wi-Fi or wait for their admin.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelay, describeFailure } from '../src/main/connection';

test('the wait grows with every consecutive failure', () => {
  const delays = [1, 2, 3, 4, 5].map(backoffDelay);
  for (let i = 1; i < delays.length; i += 1) {
    assert.ok(
      delays[i]! > delays[i - 1]!,
      `attempt ${i + 1} (${delays[i]}ms) must wait longer than attempt ${i} (${delays[i - 1]}ms)`,
    );
  }
});

test('the first retry is quick — most drops last a second', () => {
  assert.ok(backoffDelay(1) <= 2_000);
});

test('the wait is capped, so recovery is never more than a minute late', () => {
  assert.equal(backoffDelay(50), backoffDelay(6));
  assert.ok(backoffDelay(50) <= 60_000);
});

test('a nonsense attempt count still yields a sane delay', () => {
  // Defensive: a delay of 0 here would be an unthrottled retry loop, which is
  // the failure this module exists to prevent.
  for (const attempts of [0, -1, Number.NaN]) {
    const delay = backoffDelay(attempts);
    assert.ok(delay >= 2_000 && delay <= 60_000, `attempts=${attempts} gave ${delay}ms`);
  }
});

test('each failure is described as something the user can act on', () => {
  assert.match(describeFailure('tls', 'redstone.acme.com'), /certificate/i);
  assert.match(describeFailure('server-error', 'redstone.acme.com'), /not answering/i);
  assert.match(describeFailure('not-redstone', 'redstone.acme.com'), /not a Redstone server/i);
  assert.match(describeFailure('unreachable', 'redstone.acme.com'), /reach/i);
});

test('the message names the server, and never blames a missing host', () => {
  assert.match(describeFailure('unreachable', 'redstone.acme.com'), /redstone\.acme\.com/);
  const noHost = describeFailure('unreachable', '');
  assert.doesNotMatch(noHost, /undefined|null|\s{2}/);
  assert.match(noHost, /the server/);
});
