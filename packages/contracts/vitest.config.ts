import { defineConfig } from 'vitest/config';

// `@knowscroll/source` resolves workspace packages to their TypeScript sources, so tests never
// depend on a previous build. The remaining entries are Vite's default server conditions.
const conditions = ['@knowscroll/source', 'module', 'node', 'development|production'];

export default defineConfig({
  resolve: { conditions },
  // Workspace packages are always processed by Vite (never handed to Node), including in
  // global setup, so they resolve to sources without a prior build.
  ssr: { resolve: { conditions, externalConditions: ['@knowscroll/source', 'node'] }, noExternal: [/^@knowscroll\//] },
  test: {
    server: { deps: { inline: [/^@knowscroll\//] } },
    include: ['src/**/*.test.ts'],
  },
});
