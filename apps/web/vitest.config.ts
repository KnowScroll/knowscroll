import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/unit/setup.ts'],
    include: ['test/unit/**/*.test.{ts,tsx}'],
    css: false,
  },
});
