import { defineConfig } from 'vitest/config';
import { workspaceSources } from '../../vitest.workspace-sources.js';

export default defineConfig({
  plugins: [workspaceSources()],
  test: {
    include: ['src/**/*.test.ts'],
    // Property tests validate generated documents, each simulation on a 256-point grid.
    testTimeout: 60_000,
  },
});
