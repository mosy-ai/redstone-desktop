/**
 * The notification flood.
 *
 * The bug these guard, straight from the user's log: four linked folders, one
 * dropped connection, and three alerts stamped with the *same second* —
 *
 *   2026-11-12 18:34:38  sync cycle failed (5)
 *   2026-11-12 18:34:38  sync cycle failed (5)
 *   2026-11-12 18:34:38  sync cycle failed (5)
 *
 * repeated every time the connection flapped, nineteen times across two days.
 * Nothing in the notification path had a limit of any kind.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { NotifyGate, COOLOFF_MS, BURST_WINDOW_MS, BURST_LIMIT } from '../src/main/notify-gate';
import { cycleFailureAudience } from '../src/main/sync/link-sync';
import { ApiError } from '../src/main/api/client';

test('the same message twice in a row is shown once', () => {
  const gate = new NotifyGate();
  const t = 1_000_000;
  assert.equal(gate.decide('sync problem', t).show, true);
  assert.equal(gate.decide('sync problem', t + 1_000).show, false);
  assert.equal(gate.decide('sync problem', t + COOLOFF_MS - 1).show, false);
  // Still failing much later is news again.
  assert.equal(gate.decide('sync problem', t + COOLOFF_MS).show, true);
});

test('one outage across many folders does not become many alerts', () => {
  const gate = new NotifyGate();
  const t = 1_000_000;
  // Distinct wording per folder, so the duplicate rule alone cannot catch it.
  const folders = ['Reports', 'Designs', 'Vietnam Information', 'Shared'];
  const shown = folders.filter((f) => gate.decide(`Sync problem in ${f}`, t).show).length;
  assert.ok(shown <= BURST_LIMIT, `${shown} alerts in one second`);
  assert.ok(shown >= 1, 'the user must still be told something');
});

test('a connection failure is told once, not once per folder', () => {
  // Every transport failure the client can produce carries status 0.
  for (const message of ['fetch failed', 'read ECONNRESET (ECONNRESET)', 'getaddrinfo EAI_AGAIN']) {
    assert.equal(cycleFailureAudience(new ApiError(0, '/tree', message)), 'connection', message);
  }
});

test('a problem with one folder still names that folder', () => {
  assert.equal(cycleFailureAudience(new ApiError(404, '/folders/x', 'gone')), 'folder');
  assert.equal(cycleFailureAudience(new ApiError(403, '/folders/x', 'denied')), 'folder');
  assert.equal(cycleFailureAudience(new ApiError(500, '/tree', 'server error')), 'folder');
  assert.equal(cycleFailureAudience(new Error('something local broke')), 'folder');
});

test('the logged flood produces no per-folder alerts at all', () => {
  // The real shape: four linked folders, six outages, every link failing the
  // same cycle. The old code raised one alert per folder per outage.
  const folders = ['Reports', 'Designs', 'Vietnam Information', 'Shared'];
  let folderAlerts = 0;
  for (let outage = 0; outage < 6; outage += 1) {
    for (const _ of folders) {
      if (cycleFailureAudience(new ApiError(0, '/tree', 'fetch failed')) === 'folder') {
        folderAlerts += 1;
      }
    }
  }
  assert.equal(folderAlerts, 0, `${folderAlerts} of the old 24 alerts remain`);
});

test('what was held back is reported, not silently dropped', () => {
  const gate = new NotifyGate();
  const t = 1_000_000;
  for (let i = 0; i < BURST_LIMIT; i += 1) assert.equal(gate.decide(`msg ${i}`, t).show, true);
  // These are over the cap.
  assert.equal(gate.decide('msg over-1', t).show, false);
  assert.equal(gate.decide('msg over-2', t).show, false);

  const next = gate.decide('msg later', t + BURST_WINDOW_MS);
  assert.equal(next.show, true);
  assert.equal(next.show && next.alsoSuppressed, 2);
});

test('a genuinely different problem later still gets through', () => {
  const gate = new NotifyGate();
  const t = 1_000_000;
  assert.equal(gate.decide('Sync problem in Reports', t).show, true);
  // A conflict is not the same news as a sync failure.
  assert.equal(gate.decide('Conflict in Reports', t + 2_000).show, true);
});

test('the record of past messages does not grow without bound', () => {
  const gate = new NotifyGate();
  for (let i = 0; i < 1_000; i += 1) {
    // Spread far enough apart that the burst cap never applies.
    gate.decide(`unique message ${i}`, i * BURST_WINDOW_MS);
  }
  const map = (gate as unknown as { lastShownAt: Map<string, number> }).lastShownAt;
  assert.ok(map.size <= 400, `remembered ${map.size} messages`);
});
