/**
 * Auth is the web app's job. The shell only *reads* the access token the web app
 * puts in the `rs_token` cookie on the shared partition (spec §4).
 *
 * Rules encoded here:
 *   - re-read before every request batch (the web app refreshes it),
 *   - never persist it, never log it,
 *   - never try to refresh it — on 401 we pause and surface "sign in again".
 */
import { session } from 'electron';
import { EventEmitter } from 'node:events';
import { SESSION_PARTITION, TOKEN_COOKIE } from '../shared/constants';
import { getSettings } from './settings';
import logger from './logger';

export const authEvents = new EventEmitter();

let lastKnownSignedIn: boolean | null = null;

export function redstoneSession(): Electron.Session {
  return session.fromPartition(SESSION_PARTITION);
}

/** The current access token, or null when the user is signed out. */
export async function getToken(): Promise<string | null> {
  try {
    const cookies = await redstoneSession().cookies.get({
      url: getSettings().appOrigin,
      name: TOKEN_COOKIE,
    });
    const value = cookies[0]?.value?.trim();
    const token = value && value.length > 0 ? value : null;
    announce(Boolean(token));
    return token;
  } catch (err) {
    logger.warn('could not read auth cookie', err);
    return null;
  }
}

/** Called when a request comes back 401: the token is dead, the web app owns the fix. */
export function reportUnauthorized(): void {
  announce(false);
}

function announce(signedIn: boolean): void {
  if (lastKnownSignedIn === signedIn) return;
  lastKnownSignedIn = signedIn;
  authEvents.emit(signedIn ? 'signed-in' : 'signed-out');
  logger.info(`auth: ${signedIn ? 'token present' : 'no token'}`);
}

export function isKnownSignedIn(): boolean {
  return lastKnownSignedIn === true;
}
