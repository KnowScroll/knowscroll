import expoPreset from 'jest-expo/jest-preset.js';

/*
 * jest-expo with two additions for workspace code:
 * - `@knowscroll/contracts` resolves to its TypeScript sources (tests never need a build; its
 *   `.js` import specifiers name `.ts` files), like Vitest and tsc do through `@knowscroll/source`;
 * - oRPC ships ES modules only (`.mjs`), so they go through jest-expo's own Babel transform.
 */
const babelTransform = expoPreset.transform['\\.[jt]sx?$'];
const [nodeModulesPattern, ...otherIgnorePatterns] = expoPreset.transformIgnorePatterns;

const shared = {
  rootDir: '.',
  moduleNameMapper: {
    '^@knowscroll/contracts$': '<rootDir>/../../packages/contracts/src/index.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: { '\\.mjs$': babelTransform },
  transformIgnorePatterns: [nodeModulesPattern.replace('(?!(.pnpm|', '(?!(.pnpm|@orpc|'), ...otherIgnorePatterns],
};

/**
 * Two projects: the native preset for the screens and the route tree, and the web preset (jsdom,
 * `.web.ts` platform files) for the web-only modules. The browser itself is covered by the
 * Playwright smoke over the production export (`e2e/`).
 */
export default {
  projects: [
    {
      ...shared,
      displayName: 'native',
      preset: 'jest-expo',
      testMatch: [
        '<rootDir>/features/**/*.test.{ts,tsx}',
        '<rootDir>/platform/**/*.test.{ts,tsx}',
        '<rootDir>/theme/**/*.test.ts',
      ],
      testPathIgnorePatterns: ['/node_modules/', '\\.web\\.test\\.tsx?$'],
      setupFiles: ['<rootDir>/jest.setup.js'],
    },
    {
      ...shared,
      displayName: 'web',
      preset: 'jest-expo/web',
      testMatch: ['<rootDir>/platform/**/*.web.test.{ts,tsx}'],
    },
  ],
};
