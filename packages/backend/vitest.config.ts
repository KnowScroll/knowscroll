import { defineConfig } from 'vitest/config';

// Workspace packages resolve to their TypeScript sources; the rest are Vite's server defaults.
const conditions = ['@knowscroll/source', 'module', 'node', 'development|production'];

export default defineConfig({
  resolve: { conditions },
  // Workspace packages are always processed by Vite (never handed to Node), including in
  // global setup, so they resolve to sources without a prior build.
  ssr: { resolve: { conditions, externalConditions: ['@knowscroll/source', 'node'] }, noExternal: [/^@knowscroll\//] },
  test: {
    server: { deps: { inline: [/^@knowscroll\//] } },
    include: ['src/**/*.test.ts'],
    exclude: ['src/modules/content/adapters/cutroom/wire-v1/**'],
  },
});
