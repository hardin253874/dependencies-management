/**
 * Guard for the Vitest `test.projects` split (v2 Stage 1.5): non-JSX files
 * under tests/frontend (e.g. api-client.test.ts) must keep running in jsdom.
 */
import { describe, it, expect } from 'vitest';

describe('frontend project environment', () => {
  it('runs tests/frontend/*.test.ts in jsdom', () => {
    expect(typeof window).toBe('object');
    expect(typeof document.createElement).toBe('function');
  });
});
