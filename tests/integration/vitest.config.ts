import { defineConfig } from 'vitest/config';

// Workspace packages resolve to their TypeScript sources; the rest are Vite's server defaults.
const conditions = ['@knowscroll/source', 'module', 'node', 'development|production'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', 'release/**'],
    globalSetup: ['./support/global-setup.ts'],
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
