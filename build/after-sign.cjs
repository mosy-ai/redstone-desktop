/**
 * Notarizes the macOS bundle, between signing and packaging.
 *
 * Order matters as much as it did for signing: Apple has to see the *signed*
 * app, and the ticket has to be stapled onto it *before* the dmg and zip are
 * built from it — otherwise the artifacts people download carry an unstapled
 * app and Gatekeeper falls back to an online check, or refuses when offline.
 *
 * Opt-in: only runs when REDSTONE_NOTARY_PROFILE names a `notarytool
 * store-credentials` profile, so ordinary local builds stay fast and offline.
 */
const path = require('node:path');

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const profile = process.env.REDSTONE_NOTARY_PROFILE;
  if (!profile) return;

  const { notarize } = require('@electron/notarize');
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );

  console.log(`  • notarizing with profile "${profile}" — this takes a few minutes`);
  await notarize({ tool: 'notarytool', appPath, keychainProfile: profile });
  console.log('  • notarized and stapled');
};
