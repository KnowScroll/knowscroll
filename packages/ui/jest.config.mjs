/**
 * Two projects: the native preset (iOS platform files, React Native host components) for the
 * component tests, and the web preset (jsdom, `.web.ts` platform files, React Native Web) for the
 * web-only modules: link and ARIA semantics, the `:focus-visible` stylesheet and overlay history.
 */
export default {
  projects: [
    {
      displayName: 'native',
      preset: 'jest-expo',
      rootDir: '.',
      testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/src/**/*.test.tsx'],
      testPathIgnorePatterns: ['/node_modules/', '\\.web\\.test\\.tsx?$'],
      setupFiles: ['<rootDir>/jest.setup.js'],
    },
    {
      displayName: 'web',
      preset: 'jest-expo/web',
      rootDir: '.',
      testMatch: ['<rootDir>/src/**/*.web.test.ts', '<rootDir>/src/**/*.web.test.tsx'],
    },
  ],
};
