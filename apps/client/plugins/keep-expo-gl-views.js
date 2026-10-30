// @ts-check
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Expo loads config plugins as CommonJS
const fs = require('node:fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Expo loads config plugins as CommonJS
const path = require('node:path');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Expo loads config plugins as CommonJS
const { withDangerousMod } = require('expo/config-plugins');

/** The marker line that tells a repeated prebuild the rules are already in place. */
const MARKER = '# KnowScroll: keep the expo-gl view (D-100)';

/**
 * The release build shrinks and renames classes with R8. Expo modules find a native view's
 * constructor by reflection; with the names changed, creating a `GLView` crashes the app with
 * "Didn't find a correct constructor for class ...". This rule keeps the expo-gl classes (the view
 * and its native bridge) as they are.
 *
 * @param {import('expo/config-plugins').ExportedConfig} config
 */
module.exports = function withKeepExpoGlViews(config) {
  return withDangerousMod(config, [
    'android',
    async (modified) => {
      const rulesPath = path.join(modified.modRequest.platformProjectRoot, 'app', 'proguard-rules.pro');
      const existing = fs.existsSync(rulesPath) ? fs.readFileSync(rulesPath, 'utf8') : '';
      if (!existing.includes(MARKER)) {
        const rules = [MARKER, '-keep class expo.modules.gl.** { *; }', ''].join('\n');
        fs.writeFileSync(rulesPath, `${existing}${existing.endsWith('\n') || existing === '' ? '' : '\n'}${rules}`);
      }
      return modified;
    },
  ]);
};
