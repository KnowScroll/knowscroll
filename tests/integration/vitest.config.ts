import { defineConfig } from 'vitest/config';
import { workspaceSources } from '../../vitest.workspace-sources.js';

// Two Vitest projects over the same real-PostgreSQL support code (`pnpm --filter
// @knowscroll/integration-tests test` runs both; `--project role-evaluation` runs one):
// - `integration`: the module and infrastructure tests, one template-derived database per file;
// - `role-evaluation` (blueprint §15): labelled synthetic contexts run through the reasoning
//   harness with the labelled fixture model, asserting harness behaviours, never content quality.
const shared = {
  globalSetup: ['./support/global-setup.ts'],
  pool: 'forks' as const,
  testTimeout: 30_000,
  hookTimeout: 60_000,
};

export default defineConfig({
  plugins: [workspaceSources()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          ...shared,
          name: 'integration',
          include: ['**/*.test.ts'],
          exclude: ['**/node_modules/**', 'release/**', 'evaluation/**'],
        },
      },
      {
        extends: true,
        test: { ...shared, name: 'role-evaluation', include: ['evaluation/**/*.test.ts'] },
      },
    ],
  },
});
