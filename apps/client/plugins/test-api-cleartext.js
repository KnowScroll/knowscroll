// @ts-check
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Expo loads config plugins as CommonJS
const { withAndroidManifest } = require('expo/config-plugins');

/**
 * A build made for a test API (`EXPO_PUBLIC_KS_TEST_API=1`, the native lane's journeys) talks to
 * an API on the emulator's host over plain HTTP, which Android refuses unless the application
 * allows cleartext traffic. Every other build keeps Android's default (HTTPS only), and the client
 * refuses a plain-HTTP origin there too (`platform/api.ts`).
 *
 * @param {import('expo/config-plugins').ExportedConfig} config
 */
module.exports = function withTestApiCleartext(config) {
  if (process.env.EXPO_PUBLIC_KS_TEST_API !== '1') return config;
  return withAndroidManifest(config, (modified) => {
    const application = modified.modResults.manifest.application?.[0];
    if (application !== undefined) application.$['android:usesCleartextTraffic'] = 'true';
    return modified;
  });
};
