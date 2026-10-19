import { defineConfig } from 'vitest/config';
import { workspaceSources } from '../../vitest.workspace-sources.js';

// Release tests start the deployed release trees named by KS_RELEASE_DIR against a real
// PostgreSQL server named by KS_TEST_DATABASE_URL. They run in the CI `build` job only.

export default defineConfig({
  plugins: [workspaceSources()],
  test: {
    include: ['release/**/*.test.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
