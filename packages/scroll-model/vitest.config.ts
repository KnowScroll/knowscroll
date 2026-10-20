import { defineConfig } from 'vitest/config';
import { workspaceSources } from '../../vitest.workspace-sources.js';

export default defineConfig({
  plugins: [workspaceSources()],
  test: {
    include: ['src/**/*.test.ts'],
    // These suites assert wall-clock refusal bounds and admission/client CPU budgets. Running
    // their files together oversubscribes CI cores and turns elapsed time into scheduler delay.
    // checks.yml also runs this package separately from the other backend-job unit suites.
    fileParallelism: false,
    maxWorkers: 1,
    // Property tests validate generated documents, each simulation on a 256-point grid.
    testTimeout: 60_000,
  },
});
