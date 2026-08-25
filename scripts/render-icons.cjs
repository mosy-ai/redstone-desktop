/**
 * Electron entry for `npm run icons` — rasterises the hand-authored SVG marks.
 * Spawned by scripts/make-icons.mjs; see that file for why Chromium does the
 * rendering rather than a native image library.
 */
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync, mkdirSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

const JOBS = [
  // electron-builder derives .icns, .ico and the Linux sizes from this one file.
  { svg: 'build/icon.svg', out: 'build/icon.png', size: 1024 },
  // Rendered large and downsampled: a 32px mark with hairline serifs needs the
  // extra samples or the stem of the "r" goes ragged — and Chromium will not
  // hand out a window small enough to capture 32px directly anyway.
  { svg: 'build/tray.svg', out: 'src/renderer/tray/tray.png', size: 32, renderAt: 512 },
];

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');

/**
 * One window, reused across jobs. A *second* transparent BrowserWindow in the
 * same run fails its first load with ERR_FAILED on macOS, so the window is
 * created once and resized between renders.
 */
async function render(win, job) {
  const px = job.renderAt ?? job.size;
  const svg = readFileSync(path.join(root, job.svg), 'utf8');

  win.setContentSize(px, px);

  const html =
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'html,body{margin:0;padding:0;background:transparent;overflow:hidden}' +
    `svg{display:block;width:${px}px;height:${px}px}` +
    '</style></head><body>' +
    svg +
    '</body></html>';

  // A temp file rather than a data: URL: Chromium refuses data: documents past
  // a certain size, which the 1024px mark is comfortably over.
  const page = path.join(os.tmpdir(), `redstone-icon-${process.pid}-${job.size}.html`);
  writeFileSync(page, html, 'utf8');
  try {
    await win.loadFile(page);
  } finally {
    rmSync(page, { force: true });
  }
  await new Promise((resolve) => setTimeout(resolve, 250));

  // capturePage returns pixels at the display's scale factor, so a Retina host
  // would otherwise silently emit a 2048px "1024px" icon.
  const shot = await win.webContents.capturePage();
  const image =
    shot.getSize().width === job.size
      ? shot
      : shot.resize({ width: job.size, height: job.size, quality: 'best' });

  const target = path.isAbsolute(job.out) ? job.out : path.join(root, job.out);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, image.toPNG());

  const { width, height } = image.getSize();
  console.log(`[icons] ${job.out} (${width}x${height})`);
}

app
  .whenReady()
  .then(async () => {
    const largest = Math.max(...JOBS.map((j) => j.renderAt ?? j.size));
    const win = new BrowserWindow({
      width: largest,
      height: largest,
      show: false,
      frame: false,
      // Transparent window + no page background, so the PNG keeps the SVG's own
      // alpha — which is what makes the tray image usable as a macOS template.
      transparent: true,
      backgroundColor: '#00000000',
      useContentSize: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    for (const job of JOBS) await render(win, job);
    win.destroy();
    app.exit(0);
  })
  .catch((err) => {
    console.error('[icons] failed', err);
    app.exit(1);
  });
