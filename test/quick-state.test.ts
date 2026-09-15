/**
 * What the quick bar opens with.
 *
 * Asked for directly: summoning the bar should continue the conversation it was
 * last in, the way a phone assistant does, and it should reopen on the model the
 * user picked rather than making them pick again.
 *
 * The bar renders the web app's own `/quick` route, so the page owns the
 * conversation and the picker. The shell owns memory and the handoff — which is
 * what is tested here: what ends up in the URL the bar is opened with.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuickQuery } from '../src/main/quick-state';

const params = (q: Record<string, string>): URLSearchParams => new URLSearchParams(q);

test('a first-ever summon carries nothing but the client hint', () => {
  const q = buildQuickQuery({ sessionId: null, model: '', continueLastSession: true });
  assert.deepEqual(q, { client: 'desktop' });
});

test('a remembered conversation and model are handed to the page', () => {
  const q = buildQuickQuery({ sessionId: 'conv-42', model: 'redstone-gpt', continueLastSession: true });
  assert.equal(params(q).get('session'), 'conv-42');
  assert.equal(params(q).get('model'), 'redstone-gpt');
  assert.equal(params(q).get('client'), 'desktop');
});

test('the model is remembered even when conversations are not', () => {
  // Turning continuation off means "start fresh", not "forget my model too" —
  // re-picking a model every summon is the annoyance being fixed.
  const q = buildQuickQuery({ sessionId: null, model: 'redstone-gpt', continueLastSession: false });
  assert.equal(params(q).get('session'), null);
  assert.equal(params(q).get('model'), 'redstone-gpt');
});

test('an empty model is omitted rather than sent blank', () => {
  const q = buildQuickQuery({ sessionId: 'conv-42', model: '', continueLastSession: true });
  assert.equal('model' in q, false);
});
