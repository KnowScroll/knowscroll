import { defineConfig } from 'vitest/config';
import { workspaceSources } from '../../vitest.workspace-sources.js';

// Three Vitest projects over the same real-PostgreSQL support code (`pnpm --filter
// @knowscroll/integration-tests test` runs the first two; `--project <name>` runs one):
// - `integration`: the module and infrastructure tests, one template-derived database per file;
// - `role-evaluation` (blueprint §15): labelled synthetic contexts run through the reasoning
//   harness with the labelled fixture model, asserting harness behaviours, never content quality;
// - `simulation` (#674): synthetic readers drive the real recommendation, formation and supply
//   modules and assert product invariants. It has its own script and CI job (`test:simulation`) and
//   is left out of `test`, so the backend job does not run it twice. See simulation/README.md.
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
          exclude: ['**/node_modules/**', 'release/**', 'evaluation/**', 'simulation/**'],
        },
      },
      {
        extends: true,
        test: { ...shared, name: 'role-evaluation', include: ['evaluation/**/*.test.ts'] },
      },
      {
        extends: true,
        // A lab run drives hundreds of real encounters; its files set their own larger timeouts.
        test: {
          ...shared,
          name: 'simulation',
          globalSetup: [...shared.globalSetup, './simulation/aggregate.ts'],
          include: ['simulation/**/*.test.ts'],
          testTimeout: 240_000,
        },
      },
    ],
  },
});
