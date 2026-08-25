/**
 * Logging with redaction baked in.
 *
 * Acceptance criterion 11: no token, no file path and no file content may reach
 * a log file. The scrubbing itself lives in `src/shared/redact.ts` (pure, and
 * tested); what this file does is install it as a *transport hook*, so it
 * applies to every message from every call site — including the ones someone
 * adds in a hurry later — rather than depending on discipline.
 */
import log from 'electron-log/main';
import { app } from 'electron';
import { scrub } from '../shared/redact';

export { redact, relPathHint } from '../shared/redact';

let initialised = false;

export function initLogging(): void {
  if (initialised) return;
  initialised = true;

  log.transports.file.level = 'info';
  log.transports.console.level = app.isPackaged ? 'warn' : 'debug';
  log.transports.file.maxSize = 5 * 1024 * 1024;
  log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';

  // One hook, shared by every transport, so nothing slips past by picking a
  // different sink.
  log.hooks.push((message) => ({ ...message, data: message.data.map((d) => scrub(d)) }));

  log.errorHandler.startCatching({ showDialog: false });
  log.initialize();
}

export const logger = log.scope('redstone');
export default logger;
