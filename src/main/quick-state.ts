/**
 * What the quick bar opens with: the conversation it was last in, and the model
 * the user last chose.
 *
 * The bar's contents are the web app's `/quick` route, so the shell renders
 * neither the conversation nor the model picker — and should not, or the desktop
 * grows a second chat UI that drifts from the real one. What the shell does own
 * is memory: it is the only part that survives the window being hidden, the app
 * being quit, and the machine being restarted.
 *
 * So the division is:
 *
 *   - the page tells the shell which conversation it is in (it already does,
 *     through `setActiveSession`) and which model the user picked;
 *   - the shell remembers both, and hands them back when the bar next opens —
 *     in the URL, so a page can honour them without any bridge code, and over
 *     the bridge, for a page that would rather ask.
 *
 * Remembering is per-instance. A conversation id from one Redstone means nothing
 * on another, so switching servers forgets it.
 */
import type { QuickState } from '../shared/types';
import { getSettings, updateSettings } from './settings';
import logger from './logger';

/** A model identifier the web app chose; the shell only stores it. */
const MODEL_MAX = 120;

export function quickState(): QuickState {
  const settings = getSettings();
  const continueLastSession = settings.quickBarContinuesLastSession;
  return {
    // Honouring the preference here rather than at the call sites means a page
    // that reads this cannot accidentally resume when the user asked not to.
    sessionId: continueLastSession ? (settings.lastQuickSessionId ?? null) : null,
    model: settings.quickModel ?? '',
    continueLastSession,
  };
}

/** The bar reports the conversation it is in. Ignored when continuation is off. */
export function rememberQuickSession(sessionId: string | null): void {
  if (!getSettings().quickBarContinuesLastSession) return;
  if (!sessionId) return; // hiding the bar is not "the conversation ended"
  if (getSettings().lastQuickSessionId === sessionId) return;
  updateSettings({ lastQuickSessionId: sessionId });
  logger.info('quick bar conversation remembered');
}

/** The bar reports the model the user picked. */
export function rememberQuickModel(model: string): void {
  const value = model.slice(0, MODEL_MAX);
  if (getSettings().quickModel === value) return;
  updateSettings({ quickModel: value });
  logger.info('quick bar model remembered');
}

/**
 * Start the next quick conversation fresh.
 *
 * Called when the instance changes, and available to the page for its own "new
 * chat" control — the shell has no opinion about when a conversation is over,
 * and guessing (a timeout, say) would throw away context the user still wanted.
 */
export function forgetQuickSession(): void {
  if (getSettings().lastQuickSessionId === null) return;
  updateSettings({ lastQuickSessionId: null });
  logger.info('quick bar conversation forgotten');
}

/** Everything the bar's URL should carry, ready for `appUrl`. */
export function quickQuery(): Record<string, string> {
  return buildQuickQuery(quickState());
}

/**
 * Pure half of the above, so what the page receives can be tested without a
 * settings store — the URL *is* the contract with the web app.
 */
export function buildQuickQuery(state: QuickState): Record<string, string> {
  const query: Record<string, string> = { client: 'desktop' };
  if (state.sessionId) query.session = state.sessionId;
  if (state.model) query.model = state.model;
  return query;
}
