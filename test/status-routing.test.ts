/**
 * Who is told about a folder's sync progress.
 *
 * The bug this pins: the shell sent every folder's status to every window,
 * several times a second while syncing. The web app's chat screen rendered that
 * stream directly, so whichever of the machine's folders ticked last appeared in
 * whatever chat was open — including a brand-new chat that owns no folder — and
 * was repainted on the next tick. The user saw a folder "randomly attach" itself
 * and flash.
 *
 * `LinkStatus` cannot carry a conversation id to filter on: a folder here is a
 * space, shared by many conversations. So the filtering belongs on this side.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { wantsStatus } from '../src/main/ipc';

const SHELL = true;
const WEB_APP = false;

test("the shell's own windows see every folder — that is what they are for", () => {
  assert.equal(wantsStatus(SHELL, 'folder-a', 'folder-b'), true);
  assert.equal(wantsStatus(SHELL, 'folder-a', null), true);
});

test('the web app sees the open conversation’s folder', () => {
  assert.equal(wantsStatus(WEB_APP, 'folder-a', 'folder-a'), true);
});

test('the web app is not told about the machine’s other folders', () => {
  assert.equal(wantsStatus(WEB_APP, 'folder-b', 'folder-a'), false);
});

test('a chat with no conversation open is told nothing at all', () => {
  // The reported bug in one line: a new chat owns no folder, so no folder's
  // progress belongs on its screen.
  assert.equal(wantsStatus(WEB_APP, 'folder-a', null), false);
});
