/**
 * Babel for Metro (every platform) and Jest: Expo's own preset, which Expo uses without this file, plus one
 * transform. Hermes' compiler (`hermesc`, run by the Android release build on the finished bundle) rejects a rest
 * parameter that is a pattern with a default, as in `async (...[input, options = {}]) => {}` in @orpc/client
 * ("invalid destructuring target"). babel-preset-expo's Hermes profile leaves parameters alone, so the release
 * build failed. Lowering parameters turns that into `arguments` plus an ordinary destructuring, which Hermes
 * compiles. See docs/v2/engineering/native-lane.md.
 *
 * @param {{ cache: (forever: boolean) => void }} api
 */
module.exports = function babelConfig(api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['@babel/plugin-transform-parameters'],
  };
};
