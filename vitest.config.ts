import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Vitest 5: `environmentMatchGlobs` is gone; environments are chosen per
// project. Projects inherit everything below (`extends` defaults to true):
// plugins, alias, globals, setupFiles, exclude. Every test file must live under
// tests/backend or tests/frontend — tests/backend/vitest-projects.test.ts
// guards that, so no file silently runs in neither project.
// tests/frontend/*.test.ts (non-JSX) intentionally run in jsdom, as before.
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    projects: [
      {
        extends: true,
        test: {
          name: 'backend',
          include: ['tests/backend/**/*.test.{ts,tsx}'],
          environment: 'node'
        }
      },
      {
        extends: true,
        test: {
          name: 'frontend',
          include: ['tests/frontend/**/*.test.{ts,tsx}'],
          environment: 'jsdom'
        }
      }
    ]
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  }
});
