import { defineConfig } from 'vitest/config';

// Release tests start the deployed release trees named by KS_RELEASE_DIR against a real
// PostgreSQL server named by KS_TEST_DATABASE_URL. They run in the CI `build` job only.
const conditions = ['@knowscroll/source', 'module', 'node', 'development|production'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    include: ['release/**/*.test.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
