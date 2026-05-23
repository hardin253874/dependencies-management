import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    environmentMatchGlobs: [
      ['tests/backend/**', 'node'],
      ['tests/frontend/**', 'jsdom'],
      ['tests/**/*.test.tsx', 'jsdom'],
      ['tests/**/*.test.ts', 'node']
    ]
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  }
});
