import { defineConfig } from 'vitest/config';

// Release tests start the deployed release trees named by KS_RELEASE_DIR against a real
// PostgreSQL server named by KS_TEST_DATABASE_URL. They run in the CI `build` job only.
const conditions = ['@knowscroll/source', 'module', 'node', 'development|production'];

export default defineConfig({
  resolve: { conditions },
  // Workspace packages are always processed by Vite (never handed to Node), including in
  // global setup, so they resolve to sources without a prior build.
  ssr: { resolve: { conditions, externalConditions: ['@knowscroll/source', 'node'] }, noExternal: [/^@knowscroll\//] },
  test: {
    server: { deps: { inline: [/^@knowscroll\//] } },
    include: ['release/**/*.test.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
