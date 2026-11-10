/**
 * Guard for the Vitest `test.projects` split (v2 Stage 1.5).
 *
 * Vitest 5 runs a file only if a project's `include` matches it. The two
 * projects cover tests/backend (node) and tests/frontend (jsdom); a test file
 * anywhere else under tests/ would silently never run. e2e (Playwright) is
 * excluded on purpose.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const TESTS_ROOT = path.resolve(__dirname, '..');

async function listTestFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...(await listTestFiles(full)));
    } else if (/\.test\.tsx?$/.test(entry.name)) {
      out.push(path.relative(TESTS_ROOT, full).split(path.sep).join('/'));
    }
  }
  return out;
}

describe('vitest projects cover every unit test file', () => {
  it('every tests/**/*.test.{ts,tsx} (outside e2e) is under tests/backend or tests/frontend', async () => {
    const files = await listTestFiles(TESTS_ROOT);
    expect(files.length).toBeGreaterThan(100);
    const orphans = files.filter(
      (f) => !f.startsWith('e2e/') && !f.startsWith('backend/') && !f.startsWith('frontend/')
    );
    expect(orphans).toEqual([]);
  });

  it('runs this backend file in the node environment', () => {
    expect(typeof window).toBe('undefined');
  });
});
