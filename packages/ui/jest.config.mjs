/**
 * Two projects: the native preset (iOS platform files, React Native host components) for the
 * component tests, and the web preset (jsdom, `.web.ts` platform files, React Native Web) for the
 * web-only modules: link and ARIA semantics, the `:focus-visible` stylesheet and overlay history.
 *
 * `@knowscroll/scroll-model` resolves to its TypeScript sources (tests never need a build; its
 * `.js` import specifiers name `.ts` files), like Vitest and tsc do through `@knowscroll/source`.
 */
const shared = {
  rootDir: '.',
  moduleNameMapper: {
    '^@knowscroll/scroll-model$': '<rootDir>/../scroll-model/src/index.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};

export default {
  projects: [
    {
      ...shared,
      displayName: 'native',
      preset: 'jest-expo',
      testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/src/**/*.test.tsx'],
      testPathIgnorePatterns: ['/node_modules/', '\\.web\\.test\\.tsx?$'],
      setupFiles: ['<rootDir>/jest.setup.js'],
    },
    {
      ...shared,
      displayName: 'web',
      preset: 'jest-expo/web',
      testMatch: ['<rootDir>/src/**/*.web.test.ts', '<rootDir>/src/**/*.web.test.tsx'],
    },
  ],
};
