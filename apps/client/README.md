# @knowscroll/client

One Expo (SDK 58) application for Android, iOS and the web, with Expo Router. This first version
is a single screen that loads the bundled fonts from `packages/design-tokens/fonts/` and shows the
product name; it proves the Expo / React Native Web / jest-expo / web export toolchain.

- `app/`: routes only (Expo Router). Tests never live here (every file would become a route).
- `features/`: screens and their tests (`*.test.tsx`, jest-expo + React Native Testing Library).
- `theme/fonts.ts`: font families and assets; interim colour values until `packages/design-tokens`
  becomes a package.

`pnpm --filter @knowscroll/client build` runs `expo export --platform web` into `dist/`
(`web.output: "single"`: a static single-page app served by Caddy, D-008). Native builds are not
part of CI (CF-31).
