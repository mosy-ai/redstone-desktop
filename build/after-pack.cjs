/**
 * Ad-hoc signs the macOS bundle *before* it is put into a dmg or zip.
 *
 * Signing afterwards — which is what a manual `codesign` on the built .app does
 * — leaves the shipped artifacts containing the unsigned copy, so everyone but
 * the person who built it gets an app with no entitlements: no microphone, and
 * on Apple Silicon a bundle macOS is entitled to refuse outright.
 *
 * When a real Developer ID is configured (CI), electron-builder signs properly
 * and this hook stays out of the way.
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const hasRealIdentity =
    process.env.CSC_LINK || process.env.CSC_NAME || process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'true';
  if (hasRealIdentity) return;

  const app = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  const entitlements = path.join(__dirname, 'entitlements.mac.plist');

  execFileSync('codesign', [
    '--force',
    '--deep',
    '--options', 'runtime',
    '--entitlements', entitlements,
    '--sign', '-',
    app,
  ]);
  execFileSync('codesign', ['--verify', '--deep', '--strict', app]);
  console.log(`  • ad-hoc signed with entitlements  ${path.basename(app)}`);
};
