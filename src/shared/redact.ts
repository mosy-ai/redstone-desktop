/**
 * Scrubbing for anything that might reach a log file.
 *
 * Acceptance criterion 11 is that no token, no file path and no file content
 * ends up in a log the app writes. Rather than trusting every call site, the
 * logger runs every argument of every message through here — see
 * `src/main/logger.ts`, and `test/redact.test.ts` for what that guarantees.
 *
 * Pure and dependency-free so it can be tested directly.
 */
import { createHash } from 'node:crypto';

const TOKEN_RE = /\b(?:Bearer\s+)?ey[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g;
const BEARER_RE = /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{8,}/g;

/**
 * Filesystem roots, as opposed to URL paths: `/api/v1/folders` in a log line is
 * useful and private to nobody, `/Users/anh/Documents/q3.md` is neither.
 */
const FS_ROOTS = [
  'Users',
  'home',
  'Volumes',
  'private',
  'tmp',
  'var',
  'mnt',
  'media',
  'opt',
  'srv',
  'root',
  'Applications',
  'Library',
  'System',
];

const POSIX_PATH_RE = new RegExp(
  String.raw`(?:file://)?/(?:${FS_ROOTS.join('|')})/[^\s"'()\[\],;]*`,
  'g',
);
// The lookbehind matters: without it the `s:/` inside `https://` reads as a
// drive letter and every URL in the log turns into a digest.
const WIN_PATH_RE = /(?:(?<![A-Za-z0-9])[A-Za-z]:[\\/]|\\\\)[^\s"'()[\],;]*/g;

/** Keys whose value is never worth logging, whatever it happens to hold. */
const SENSITIVE_KEY_RE = /token|secret|password|cookie|authorization/i;

const digest = (value: string): string =>
  createHash('sha1').update(value).digest('hex').slice(0, 8);

/**
 * Scrub one string: credentials become `<token>`, filesystem paths become
 * `<path:ab12cd34>`. The digest is stable, so one file can still be followed
 * through a sync cycle without its name being revealed.
 */
export function redact(input: string): string {
  return input
    .replace(TOKEN_RE, '<token>')
    .replace(BEARER_RE, '<token>')
    .replace(WIN_PATH_RE, (m) => `<path:${digest(m)}>`)
    .replace(POSIX_PATH_RE, (m) => `<path:${digest(m)}>`);
}

/** Recursively scrub anything a log call might carry. */
export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4) return '…';
  if (typeof value === 'string') return redact(value);
  if (value instanceof Error) {
    const err = new Error(redact(value.message));
    err.name = value.name;
    err.stack = value.stack ? redact(value.stack) : undefined;
    return err;
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? '<redacted>' : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** A safe way to mention a file in a log line: a stable digest plus extension. */
export function relPathHint(relPath: string): string {
  const dot = relPath.lastIndexOf('.');
  const ext = dot > 0 ? relPath.slice(dot) : '';
  return `<file:${digest(relPath)}${ext}>`;
}
