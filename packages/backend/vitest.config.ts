import { defineConfig } from 'vitest/config';
import { workspaceSources } from '../../vitest.workspace-sources.js';

export default defineConfig({
  plugins: [workspaceSources()],
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/modules/content/adapters/cutroom/wire-v1/**'],
  },
});
