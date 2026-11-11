#!/usr/bin/env node
/**
 * `electron-builder`, with an output directory it can actually write to.
 *
 * electron-builder shells out for several steps (codesign, hdiutil, fpm), and a
 * repository path containing a shell metacharacter — an apostrophe is the one
 * that turns up in real life, as in `/Volumes/Na's Mac Data` — breaks those
 * commands rather than the JavaScript around them. The failure arrives late, in
 * the middle of signing, and reads as a quoting error from a tool nobody
 * invoked directly.
 *
 * So: when the checkout sits on such a path, artifacts are written somewhere
 * plain and the location is printed. Everywhere else this is exactly
 * `electron-builder` with the arguments given, writing to `release/` as before.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Characters that survive Node's argv but not a shell round-trip. */
const AWKWARD = /['"`$\\!*?()[\]{}<>|;&]/;

const args = process.argv.slice(2);
const needsPlainPath = AWKWARD.test(root);

if (needsPlainPath) {
  const out = path.join(os.tmpdir(), 'redstone-release');
  args.push(`--config.directories.output=${out}`);
  console.log(`[package] the checkout path contains a character electron-builder cannot shell-quote`);
  console.log(`[package] writing artifacts to ${out}`);
}

/**
 * The certificate this project ships under, by name.
 *
 * Left to itself electron-builder signs with whichever Developer ID it finds
 * first in the keychain, and this machine holds more than one. Signing with the
 * wrong one is not a cosmetic mistake: Squirrel.Mac refuses an update whose
 * identity differs from the installed app's, so a mis-signed release reaches
 * nobody and cannot be fixed by re-releasing under the same version.
 *
 * Not a secret — it is printed inside every signed binary. CI sets CSC_NAME
 * from its own certificate and is left alone.
 */
const SIGN_IDENTITY = 'Developer ID Application: Anh Nguyen Ngoc (A3W6G8FQ2L)';

const env = { ...process.env };
if (!env.CSC_NAME && !env.CSC_LINK) {
  env.CSC_NAME = SIGN_IDENTITY;
  console.log(`[package] signing as ${SIGN_IDENTITY}`);
}

const child = spawn('npx', ['electron-builder', ...args], { cwd: root, stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 1));
