/**
 * Noticing that the app is holding an unreasonable amount of memory.
 *
 * Reported as "11.88 GB" in Activity Monitor with nothing in the log to say when
 * it began or which process held it. The numbers were always available; only the
 * noticing was missing. This is the part worth testing — the alternative is
 * allocating gigabytes to find out.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextMemoryMilestone } from '../src/main/render-health';

test('an ordinary chat window reports nothing', () => {
  assert.equal(nextMemoryMilestone(340, new Set()), null);
  assert.equal(nextMemoryMilestone(999, new Set()), null);
});

test('crossing a milestone reports it once', () => {
  const reported = new Set<number>();
  const first = nextMemoryMilestone(1_200, reported);
  assert.equal(first, 1_000);
  reported.add(first!);
  // Still above the same step a sample later: already said.
  assert.equal(nextMemoryMilestone(1_400, reported), null);
});

test('a worse reading reports the worse number', () => {
  const reported = new Set([1_000]);
  assert.equal(nextMemoryMilestone(4_500, reported), 4_000);
});

test('an app already enormous when first sampled says so straight away', () => {
  // The reported case: 11.88 GB. Reporting "1 GB" here and waiting for the next
  // step would describe a problem the user has long since noticed.
  assert.equal(nextMemoryMilestone(11_880, new Set()), 8_000);
  assert.equal(nextMemoryMilestone(12_500, new Set()), 12_000);
});
