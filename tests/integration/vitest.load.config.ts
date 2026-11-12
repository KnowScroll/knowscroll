import { defineConfig } from 'vitest/config';
import { workspaceSources } from '../../vitest.workspace-sources.js';

// The load test (#674, slice 4.4): the design target on a disposable database, with the numbers written to
// docs/v2/operations/load-test-674.md. It is not part of `test`, `test:simulation` or any CI job: it takes tens of minutes
// and a database of several gigabytes. `pnpm --filter @knowscroll/integration-tests test:load` runs it; see load/README.md.
export default defineConfig({
  plugins: [workspaceSources()],
  test: {
    globalSetup: ['./support/global-setup.ts'],
    pool: 'forks',
    fileParallelism: false,
    include: ['load/**/*.test.ts'],
    testTimeout: 3_600_000,
    hookTimeout: 3_600_000,
  },
});
