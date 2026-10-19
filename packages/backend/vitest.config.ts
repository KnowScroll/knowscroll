import { defineConfig } from 'vitest/config';

// Workspace packages resolve to their TypeScript sources; the rest are Vite's server defaults.
const conditions = ['@knowscroll/source', 'module', 'node', 'development|production'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/modules/content/adapters/cutroom/wire-v1/**'],
  },
});
