import expoPreset from 'jest-expo/jest-preset.js';

/**
 * jest-expo with three additions for workspace code:
 * - `@knowscroll/contracts` resolves to its TypeScript sources (tests never need a build; its
 *   `.js` import specifiers name `.ts` files), like Vitest and tsc do through `@knowscroll/source`;
 * - oRPC ships ES modules only (`.mjs`), so they go through jest-expo's own Babel transform.
 */
const babelTransform = expoPreset.transform['\\.[jt]sx?$'];
const [nodeModulesPattern, ...otherIgnorePatterns] = expoPreset.transformIgnorePatterns;

export default {
  preset: 'jest-expo',
  testMatch: [
    '<rootDir>/features/**/*.test.{ts,tsx}',
    '<rootDir>/theme/**/*.test.ts',
    '<rootDir>/navigation/**/*.test.tsx',
  ],
  setupFiles: ['<rootDir>/jest.setup.js'],
  moduleNameMapper: {
    '^@knowscroll/contracts$': '<rootDir>/../../packages/contracts/src/index.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: { '\\.mjs$': babelTransform },
  transformIgnorePatterns: [nodeModulesPattern.replace('(?!(.pnpm|', '(?!(.pnpm|@orpc|'), ...otherIgnorePatterns],
};
