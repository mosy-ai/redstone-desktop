#!/usr/bin/env node
/**
 * Bundles the three JS surfaces of the shell with esbuild:
 *
 *   main     — Node/CJS bundle for the main process. `electron`, `electron-log`
 *              and `electron-updater` stay external (they are real runtime
 *              dependencies that electron-builder packages from node_modules);
 *              everything else (chokidar, ignore, our code) is inlined so the
 *              packaged app has no resolution surprises and no native modules.
 *   preload  — CJS, sandbox-safe. Only `electron` is external.
 *   renderer — the shell's own small local pages (quick bar fallback, sync
 *              status, capture picker). IIFE, no Node.
 *
 * Static assets (html/css) are copied verbatim.
 */
import { build, context } from 'esbuild';
import { cp, mkdir, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

const common = {
  bundle: true,
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
};

/** @type {import('esbuild').BuildOptions[]} */
const builds = [
  {
    ...common,
    entryPoints: [path.join(root, 'src/main/index.ts')],
    outfile: path.join(root, 'dist/main/index.js'),
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron', 'electron-log', 'electron-updater'],
  },
  {
    ...common,
    entryPoints: [path.join(root, 'src/preload/index.ts')],
    outfile: path.join(root, 'dist/preload/index.js'),
    platform: 'browser',
    format: 'cjs',
    target: 'chrome120',
    external: ['electron'],
  },
  {
    ...common,
    // Explicit `out` names keep the bundles beside the flattened html/css, so a
    // page can load "./quick.js" whether it came from src/renderer/quick/ or not.
    entryPoints: [
      { in: path.join(root, 'src/renderer/status/status.ts'), out: 'status' },
      { in: path.join(root, 'src/renderer/capture/capture.ts'), out: 'capture' },
      { in: path.join(root, 'src/renderer/server/server.ts'), out: 'server' },
      { in: path.join(root, 'src/renderer/chrome/chrome.ts'), out: 'chrome' },
      { in: path.join(root, 'src/renderer/preferences/preferences.ts'), out: 'preferences' },
    ],
    outdir: path.join(root, 'dist/renderer'),
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
  },
];

async function copyStatic() {
  const src = path.join(root, 'src/renderer');
  const out = path.join(root, 'dist/renderer');
  await mkdir(out, { recursive: true });
  for (const dir of await readdir(src, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const file of await readdir(path.join(src, dir.name))) {
      if (!/\.(html|css|svg|png)$/.test(file)) continue;
      await cp(path.join(src, dir.name, file), path.join(out, file));
    }
  }
}

async function main() {
  if (!watch && existsSync(path.join(root, 'dist'))) {
    await rm(path.join(root, 'dist'), { recursive: true, force: true });
  }
  await copyStatic();
  if (watch) {
    const ctxs = await Promise.all(builds.map((b) => context(b)));
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log('[build] watching…');
  } else {
    await Promise.all(builds.map((b) => build(b)));
    console.log('[build] done');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
