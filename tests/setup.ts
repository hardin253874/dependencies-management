import { afterEach, beforeEach, vi } from 'vitest';

const isJsdom = typeof window !== 'undefined';

if (isJsdom) {
  await import('@testing-library/jest-dom/vitest');
  const { cleanup } = await import('@testing-library/react');
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    window.localStorage.clear();
  });
} else {
  afterEach(() => {
    vi.restoreAllMocks();
  });
}
