/**
 * D1 / D23 boundary: `src/core/**` must not import Next.js, React or app/UI
 * code, and uses relative imports only (`npm run eval` runs under vite-node,
 * which does not resolve the `@/` alias). Enforced by `no-restricted-imports`
 * in eslint.config.mjs; this test drives ESLint's Node API so the rule cannot
 * silently disappear from the config.
 */
import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';

async function restrictedImportErrors(code: string, filePath: string): Promise<number> {
  const eslint = new ESLint({ cwd: process.cwd() });
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-imports').length;
}

describe('src/core import boundary (D1/D23)', () => {
  it.each([
    ["import { NextResponse } from 'next/server';\nexport const x = NextResponse;\n"],
    ["import React from 'react';\nexport const x = React;\n"],
    ["import { libraryRoot } from '@/lib/paths';\nexport const x = libraryRoot;\n"],
    ["import { createRoot } from 'react-dom/client';\nexport const x = createRoot;\n"],
    ["import { x as y } from '@/components/Foo';\nexport const x = y;\n"]
  ])('rejects a forbidden import in src/core: %s', async (code) => {
    expect(await restrictedImportErrors(code, 'src/core/graph/x.ts')).toBeGreaterThan(0);
  });

  it.each([
    ["import path from 'node:path';\nexport const x = path;\n"],
    ["import { buildIgnoreMatcher } from '../../lib/scanners/gitignore';\nexport const x = buildIgnoreMatcher;\n"]
  ])('allows node builtins and relative imports in src/core: %s', async (code) => {
    expect(await restrictedImportErrors(code, 'src/core/graph/x.ts')).toBe(0);
  });

  it('does not apply the rule outside src/core', async () => {
    const code = "import { NextResponse } from 'next/server';\nexport const x = NextResponse;\n";
    expect(await restrictedImportErrors(code, 'src/lib/x.ts')).toBe(0);
  });
});
