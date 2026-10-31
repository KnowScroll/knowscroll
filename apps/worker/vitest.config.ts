import { defineConfig } from 'vitest/config';
import { workspaceSources } from '../../vitest.workspace-sources.js';

export default defineConfig({
  plugins: [workspaceSources()],
  test: {
    include: ['src/**/*.test.ts'],
  },
});
