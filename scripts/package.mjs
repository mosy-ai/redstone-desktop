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

const child = spawn('npx', ['electron-builder', ...args], { cwd: root, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
