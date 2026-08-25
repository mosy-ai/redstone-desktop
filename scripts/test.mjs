#!/usr/bin/env node
/**
 * Bundles `test/*.test.ts` with esbuild, then runs them under `node --test`.
 *
 * Going through esbuild rather than Node's type stripping keeps the test files
 * written like the rest of the source (extensionless imports, path aliases) and
 * costs about 20ms.
 */
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(root, 'dist-test');

const entries = (await readdir(path.join(root, 'test')))
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => path.join(root, 'test', f));

if (!entries.length) {
  console.log('[test] no test files');
  process.exit(0);
}

await rm(outdir, { recursive: true, force: true });
await build({
  entryPoints: entries,
  outdir,
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: 'inline',
  logLevel: 'warning',
  external: ['electron', 'electron-log', 'electron-updater'],
});

const compiled = (await readdir(outdir))
  .filter((f) => f.endsWith('.cjs'))
  .map((f) => path.join(outdir, f));

const child = spawn(process.execPath, ['--test', ...compiled], { cwd: root, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
