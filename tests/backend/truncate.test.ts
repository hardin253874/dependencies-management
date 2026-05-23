/**
 * File-content truncation unit test (spec §11.4, plan Stage 3).
 *
 *  - In-budget content passes through untouched (truncated: false).
 *  - Strip-comments pass reduces size; preserves strings & template literals.
 *  - Smart-slice keeps imports + symbol-bearing lines + ±10 context lines.
 *  - Hard truncate sets `truncated: true` and inserts a TRUNCATED marker.
 */
import { describe, it, expect } from 'vitest';
import {
  truncateFileContent,
  stripCommentsAndCollapse,
  smartSlice
} from '@/lib/llm/prompts/truncate';

describe('truncateFileContent — in-budget passthrough', () => {
  it('returns content untouched when already small enough', () => {
    const content = "import x from 'x';\nconsole.log(x);";
    const r = truncateFileContent({
      content,
      maxInputTokens: 10_000,
      reservedTokens: 1_000,
      knownSymbols: ['x']
    });
    expect(r.truncated).toBe(false);
    expect(r.content).toBe(content);
  });
});

describe('stripCommentsAndCollapse', () => {
  it('removes // line comments', () => {
    const out = stripCommentsAndCollapse('let x = 1; // keep value\nconst y = 2;');
    expect(out).not.toContain('keep value');
    expect(out).toContain('let x = 1;');
    expect(out).toContain('const y = 2;');
  });

  it('removes /* block */ comments', () => {
    const out = stripCommentsAndCollapse('let x = 1; /* drop me */ const y = 2;');
    expect(out).not.toContain('drop me');
  });

  it('preserves comment-like substrings inside string literals', () => {
    const out = stripCommentsAndCollapse('const s = "// not a comment";');
    expect(out).toContain('"// not a comment"');
  });

  it('preserves template literals', () => {
    const out = stripCommentsAndCollapse("const s = `value: ${1 + 1}`;");
    expect(out).toContain('value:');
  });
});

describe('smartSlice', () => {
  const big = [
    "import React from 'react';",
    "import { useState } from 'react';",
    'function Header() {',
    '  return null;',
    '}',
    'function Footer() {',
    '  return null;',
    '}',
    '// unrelated code below',
    'const constant = 1;',
    'export default Header;'
  ].join('\n');

  it('keeps all import statements', () => {
    const sliced = smartSlice(big, ['react']);
    expect(sliced).toContain("import React from 'react';");
    expect(sliced).toContain("import { useState } from 'react';");
  });

  it('keeps symbol-bearing lines and ±10 lines of context', () => {
    const huge = Array.from({ length: 200 }, (_, i) =>
      i === 100 ? 'foo(react);' : `line${i};`
    ).join('\n');
    const sliced = smartSlice(huge, ['react']);
    // The line at index 100 is the symbol-bearing one. Context band is ±10.
    expect(sliced).toContain('foo(react);');
    expect(sliced).toContain('line90;');
    expect(sliced).toContain('line110;');
    // Far-away lines should be dropped.
    expect(sliced).not.toContain('line50;');
    expect(sliced).not.toContain('line150;');
  });

  it('inserts an "omitted" hint between kept ranges', () => {
    const huge = Array.from({ length: 200 }, (_, i) =>
      i === 0 || i === 100 ? `react.use${i};` : `line${i};`
    ).join('\n');
    const sliced = smartSlice(huge, ['react']);
    expect(sliced).toMatch(/omitted/);
  });
});

describe('truncateFileContent — three-stage pipeline', () => {
  it('strips comments and reports truncated:true when comment strip is enough', () => {
    const noisy = Array.from({ length: 50 }, () => '/* big block comment */ line').join('\n');
    const r = truncateFileContent({
      content: noisy + '\nconst keep = 1;',
      maxInputTokens: 100,
      reservedTokens: 10,
      knownSymbols: ['keep']
    });
    // Result is comment-stripped; not necessarily smart-sliced.
    expect(r.truncated).toBe(true);
    expect(r.content).toContain('const keep = 1;');
    expect(r.content).not.toContain('big block comment');
  });

  it('falls through to smart-slice for huge files', () => {
    const lines: string[] = [];
    lines.push("import React from 'react';");
    for (let i = 0; i < 5000; i += 1) lines.push(`const noiseLine${i} = ${i};`);
    lines.push('useReact(react);');
    const huge = lines.join('\n');
    const r = truncateFileContent({
      content: huge,
      maxInputTokens: 1_000,
      reservedTokens: 100,
      knownSymbols: ['react']
    });
    expect(r.truncated).toBe(true);
    // Imports survive.
    expect(r.content).toContain("import React from 'react';");
    // The symbol line survives.
    expect(r.content).toContain('useReact(react)');
  });

  it('falls through to hard truncate when even smart-slice is too big', () => {
    // Symbol-bearing on EVERY line keeps the whole file flagged → smart-slice
    // can't reduce it. Force the hard cut.
    const huge = Array.from({ length: 20_000 }, (_, i) => `react_${i}_;`).join('\n');
    const r = truncateFileContent({
      content: huge,
      maxInputTokens: 1_000,
      reservedTokens: 100,
      knownSymbols: ['react']
    });
    expect(r.truncated).toBe(true);
    expect(r.content).toMatch(/TRUNCATED/);
  });
});
