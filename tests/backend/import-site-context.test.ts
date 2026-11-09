/**
 * Tests for the CVE impact analyzer's import + use-site context extractor
 * (v0.6, `src/lib/scanners/importSiteContext.ts`).
 *
 * The extractor reads source files (read-only), finds the import declaration
 * + use-sites referencing imported bindings, and emits ±N-line windows with
 * line metadata so the LLM can cite "file:line-range" precisely.
 *
 * These tests use an in-memory `readFile` seam so they exercise the regex /
 * window-building logic without filesystem I/O.
 */
import { describe, it, expect } from 'vitest';
import {
  extractImportSiteContext,
  extractBindings
} from '@/lib/scanners/importSiteContext';

function memoryReader(files: Record<string, string>): (abs: string) => Promise<string> {
  return async (abs) => {
    // Test seam — we pass paths the extractor will resolve via path.resolve.
    // Match by basename to keep the test fixtures simple.
    const basename = abs.replace(/\\/g, '/').split('/').pop() ?? abs;
    if (basename in files) return files[basename]!;
    // Match by suffix as fallback (project-relative paths).
    for (const [k, v] of Object.entries(files)) {
      if (abs.replace(/\\/g, '/').endsWith(k)) return v;
    }
    throw new Error(`memoryReader miss: ${abs}`);
  };
}

describe('extractBindings', () => {
  it('extracts default import', () => {
    expect(extractBindings(`import React from 'react'`)).toEqual(['React']);
  });

  it('extracts namespace import', () => {
    expect(extractBindings(`import * as _ from 'lodash'`)).toEqual(['_']);
  });

  it('extracts named imports with aliases', () => {
    expect(extractBindings(`import { map, filter as f } from 'lodash'`).sort()).toEqual(['f', 'map']);
  });

  it('extracts default + named together', () => {
    const got = extractBindings(`import lodash, { map, filter } from 'lodash'`).sort();
    expect(got).toEqual(['filter', 'lodash', 'map']);
  });

  it('extracts CJS default require', () => {
    expect(extractBindings(`const _ = require('lodash')`)).toEqual(['_']);
  });

  it('extracts CJS destructured require', () => {
    expect(extractBindings(`const { map, filter } = require('lodash')`).sort()).toEqual(['filter', 'map']);
  });

  it('returns empty for a non-import line', () => {
    expect(extractBindings(`const x = _.map(arr, fn)`)).toEqual([]);
  });
});

describe('extractImportSiteContext', () => {
  it('emits a single window covering the import line when no other use sites exist', async () => {
    const src = [
      'import { unused } from "lodash";',
      'const x = 1;',
      'const y = 2;'
    ].join('\n');
    const result = await extractImportSiteContext({
      projectRoot: '/p',
      depName: 'lodash',
      importingFiles: ['src/a.ts'],
      contextRadius: 1,
      readFile: memoryReader({ 'src/a.ts': src })
    });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.windows).toHaveLength(1);
    expect(result.files[0]!.windows[0]!.startLine).toBe(1);
    // The import line was 1, plus the binding "unused" matches line 1 only
    // (lines 2-3 don't mention it). With radius=1, window is lines 1-2.
    expect(result.files[0]!.windows[0]!.endLine).toBe(2);
  });

  it('coalesces overlapping windows around the import + a nearby use site', async () => {
    const src = [
      '// header',
      'import _ from "lodash";',
      '',
      'export function go(arr) {',
      '  return _.template(arr);',
      '}'
    ].join('\n');
    const result = await extractImportSiteContext({
      projectRoot: '/p',
      depName: 'lodash',
      importingFiles: ['src/go.ts'],
      contextRadius: 3,
      readFile: memoryReader({ 'src/go.ts': src })
    });
    expect(result.files).toHaveLength(1);
    // Lines 2 (import) and 5 (use) are within ±3 of each other → single coalesced window.
    expect(result.files[0]!.windows).toHaveLength(1);
    const w = result.files[0]!.windows[0]!;
    expect(w.startLine).toBeLessThanOrEqual(2);
    expect(w.endLine).toBeGreaterThanOrEqual(5);
    expect(w.code).toContain('_.template(arr)');
  });

  it('produces separate windows when import and use are far apart', async () => {
    // 50 blank lines between import and use; radius 5 → two separate windows.
    const lines = ['import _ from "lodash";'];
    for (let i = 0; i < 50; i += 1) lines.push('');
    lines.push('export const x = _.map([], y => y);');
    const result = await extractImportSiteContext({
      projectRoot: '/p',
      depName: 'lodash',
      importingFiles: ['src/far.ts'],
      contextRadius: 5,
      readFile: memoryReader({ 'src/far.ts': lines.join('\n') })
    });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.windows.length).toBeGreaterThanOrEqual(2);
  });

  it('skips files that cannot be read (e.g. deleted since the usage cache was written)', async () => {
    const result = await extractImportSiteContext({
      projectRoot: '/p',
      depName: 'lodash',
      importingFiles: ['src/missing.ts'],
      contextRadius: 5,
      readFile: async () => {
        throw new Error('ENOENT');
      }
    });
    expect(result.files).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('skips files that import the dep per the usage cache but no longer contain a matching import line', async () => {
    // Stale cache scenario: file used to import the dep, now doesn't.
    const src = `console.log('no imports anymore');`;
    const result = await extractImportSiteContext({
      projectRoot: '/p',
      depName: 'lodash',
      importingFiles: ['src/stale.ts'],
      readFile: memoryReader({ 'src/stale.ts': src })
    });
    expect(result.files).toEqual([]);
  });

  it('flips `truncated` to true when total chars exceed the cap', async () => {
    const huge = Array(2000)
      .fill(0)
      .map((_, i) => (i === 0 ? `import _ from "lodash";` : `const v${i} = _.map([${i}], x => x);`))
      .join('\n');
    const result = await extractImportSiteContext({
      projectRoot: '/p',
      depName: 'lodash',
      importingFiles: ['a.ts', 'b.ts'],
      contextRadius: 20,
      maxTotalChars: 5000, // small cap to force truncation
      readFile: memoryReader({ 'a.ts': huge, 'b.ts': huge })
    });
    expect(result.truncated).toBe(true);
    // First file may fit, second is dropped — OR first itself is dropped if it exceeds cap.
    expect(result.files.length).toBeLessThanOrEqual(1);
  });

  it('respects scoped dep names like @types/node', async () => {
    const src = [
      `import type { Buffer } from '@types/node';`,
      `const b: Buffer = Buffer.alloc(0);`
    ].join('\n');
    const result = await extractImportSiteContext({
      projectRoot: '/p',
      depName: '@types/node',
      importingFiles: ['src/buf.ts'],
      contextRadius: 1,
      readFile: memoryReader({ 'src/buf.ts': src })
    });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.windows[0]!.code).toContain('Buffer');
  });

  it('approxTokens estimate scales with extracted char count', async () => {
    const src = `import _ from "lodash";\n${'_.map([], x => x);\n'.repeat(20)}`;
    const result = await extractImportSiteContext({
      projectRoot: '/p',
      depName: 'lodash',
      importingFiles: ['src/many.ts'],
      contextRadius: 2,
      readFile: memoryReader({ 'src/many.ts': src })
    });
    expect(result.approxTokens).toBeGreaterThan(0);
    const expected = Math.ceil(result.files[0]!.charCount / 4);
    expect(result.approxTokens).toBe(expected);
  });
});
