import { defineConfig } from 'vitest/config';

// `@knowscroll/source` resolves workspace packages to their TypeScript sources, so tests never
// depend on a previous build. The remaining entries are Vite's default server conditions.
const conditions = ['@knowscroll/source', 'module', 'node', 'development|production'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
