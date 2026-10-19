// @ts-check
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Expo loads config plugins as CommonJS
const { withAndroidManifest } = require('expo/config-plugins');

/**
 * Lets the Android activity handle text-size (font scale) and display-size changes itself instead
 * of being recreated. React Native then reports the new font scale and the type scale re-resolves
 * in place; recreating the activity left a blank screen with two navigation containers (seen on
 * the API 36 emulator in S1.4, #227).
 *
 * @param {import('expo/config-plugins').ExportedConfig} config
 */
module.exports = function withFontScaleConfigChanges(config) {
  return withAndroidManifest(config, (modified) => {
    const application = modified.modResults.manifest.application?.[0];
    const activity = application?.activity?.find((entry) => entry.$['android:name'] === '.MainActivity');
    if (activity !== undefined) {
      const changes = new Set((activity.$['android:configChanges'] ?? '').split('|').filter(Boolean));
      changes.add('fontScale');
      changes.add('density');
      activity.$['android:configChanges'] = [...changes].join('|');
    }
    return modified;
  });
};
