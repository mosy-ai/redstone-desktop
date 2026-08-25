#!/usr/bin/env node
/**
 * Boots the real main process headlessly and asserts the shell came up: settings
 * loaded, session hardened, IPC registered, a BrowserWindow created with the
 * production preload, and `window.redstone` exposed at the expected version.
 *
 * This is what makes "it compiles" mean something — a bundle can typecheck and
 * still fail at require time.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = require('electron');

// `npm run smoke -- --ui` drives the chrome bar's buttons instead of just booting.
const mode = process.argv.includes('--ui') ? '--ui-test' : '--smoke-test';
const args = ['.', mode];
// CI has no display; xvfb-run wraps this on Linux, but headless Chromium still
// needs the sandbox off in most containers.
if (process.platform === 'linux') args.push('--no-sandbox', '--disable-gpu');

// Piped rather than inherited on purpose: Chromium's helper processes inherit
// the child's stdio and can outlive the main process by a moment. With `inherit`
// they hold *our* stdout open, so a caller reading this command's output sees it
// hang long after the app exited cleanly.
const child = spawn(electron, args, {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    ...(mode === '--smoke-test' ? { REDSTONE_SMOKE_TEST: '1' } : {}),
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  },
});

child.stdout.on('data', (chunk) => process.stdout.write(chunk));
child.stderr.on('data', (chunk) => process.stderr.write(chunk));

const timeout = setTimeout(() => {
  console.error('[smoke] timed out after 90s');
  child.kill('SIGKILL');
  process.exit(1);
}, 90_000);

child.on('exit', (code, signal) => {
  clearTimeout(timeout);
  // Let go of the pipes the helpers may still hold, then leave.
  child.stdout.destroy();
  child.stderr.destroy();
  if (code === 0) {
    console.log(`[${mode === '--ui-test' ? 'ui-test' : 'smoke'}] ok`);
    process.exit(0);
  }
  console.error(`[smoke] failed (code=${code} signal=${signal})`);
  process.exit(code ?? 1);
});
