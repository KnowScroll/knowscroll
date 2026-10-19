import { defineConfig } from 'vitest/config';
import { workspaceSources } from '../../vitest.workspace-sources.js';

export default defineConfig({
  plugins: [workspaceSources()],
  test: {
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', 'release/**'],
    globalSetup: ['./support/global-setup.ts'],
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
