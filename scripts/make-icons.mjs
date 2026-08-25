#!/usr/bin/env node
/**
 * Renders the hand-authored SVG marks to the PNGs the build needs:
 *
 *   build/icon.svg  → build/icon.png             (1024×1024; electron-builder
 *                                                 derives .icns/.ico from it)
 *   build/tray.svg  → src/renderer/tray/tray.png (32×32 menu-bar mark)
 *
 * Rendering goes through Electron's own Chromium rather than a native image
 * library: the app already depends on it, so there is no image toolchain to
 * install on a contributor's machine or in CI, and the icon is rasterised by the
 * same engine that renders the product.
 *
 *   npm run icons
 *
 * The SVGs are the source of truth and are meant to be edited by hand — the
 * letterforms in them are real Fraunces outlines, extracted from the same font
 * the web app loads.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = require('electron');

// Piped, not inherited: Chromium's helpers can outlive the main process for a
// moment and would hold our stdout open long after the render finished.
// CI Linux runners ship Electron's chrome-sandbox without the setuid bit, which
// makes Chromium abort on start. This process only rasterises an SVG at build
// time and never loads remote content, so dropping the sandbox here is safe and
// does not affect the packaged app.
const rendererArgs = [path.join(root, 'scripts/render-icons.cjs')];
if (process.platform === 'linux') rendererArgs.push('--no-sandbox');

const child = spawn(electron, rendererArgs, {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
});

child.stdout.on('data', (chunk) => process.stdout.write(chunk));
child.stderr.on('data', (chunk) => process.stderr.write(chunk));

const timeout = setTimeout(() => {
  console.error('[icons] timed out after 120s');
  child.kill('SIGKILL');
  process.exit(1);
}, 120_000);

child.on('exit', (code) => {
  clearTimeout(timeout);
  child.stdout.destroy();
  child.stderr.destroy();
  process.exit(code ?? 1);
});
