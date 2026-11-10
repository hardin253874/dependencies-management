import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { babelParser, fileRole, type ParsedFile, type ParsedImport } from '@/core/graph/parse';
import { parseImports, packageNameFromSpecifier } from '@/lib/scanners/code';
import { GRAPH_FIXTURES_ROOT } from '../helpers/graphFixture';

function parse(src: string, rel = 'src/x.tsx'): ParsedFile {
  return babelParser.parse(src, rel);
}

async function parseFixture(fixture: string, rel: string): Promise<ParsedFile> {
  const src = await fs.readFile(path.join(GRAPH_FIXTURES_ROOT, fixture, ...rel.split('/')), 'utf8');
  return babelParser.parse(src, rel);
}

function bySpec(p: ParsedFile, spec: string): ParsedImport[] {
  return p.imports.filter((i) => i.specifier === spec);
}

describe('babel parser adapter (3a.4)', () => {
  it('identifies itself with the pinned version', () => {
    expect(babelParser.id).toBe('babel@7.24.7');
  });

  it('classifies every import kind', () => {
    const src = [
      "import def, { a as b, c } from 'static-pkg';",
      "import * as ns from 'ns-pkg';",
      "import type { T } from 'type-pkg';",
      "import { type U, v } from 'mixed-pkg';",
      "import 'side-pkg';",
      "const r = require('req-pkg');",
      "const { x, y: z } = require('destr-pkg');",
      "import eq = require('eq-pkg');",
      "const lazy = import('dyn-pkg');",
      'const tpl = import(`tpl-pkg`);',
      'const expr = import(`./locale/${lang}`);',
      'const expr2 = require(name);',
      "export { e1, e2 as e3 } from 'exp-pkg';",
      "export * from 'star-pkg';",
      "export * as starNs from 'starns-pkg';",
      "export type { TT } from 'exptype-pkg';",
      "type M = typeof import('typeof-pkg');"
    ].join('\n');
    const p = parse(src, 'src/kinds.ts');
    expect(p.parseError).toBeNull();
    const kind = (s: string) => bySpec(p, s).map((i) => i.kind);
    expect(kind('static-pkg')).toEqual(['static']);
    expect(kind('ns-pkg')).toEqual(['static']);
    expect(kind('type-pkg')).toEqual(['type-only']);
    expect(kind('mixed-pkg')).toEqual(['static']);
    expect(kind('side-pkg')).toEqual(['side-effect']);
    expect(kind('req-pkg')).toEqual(['require']);
    expect(kind('destr-pkg')).toEqual(['require']);
    expect(kind('eq-pkg')).toEqual(['require']);
    expect(kind('dyn-pkg')).toEqual(['dynamic-literal']);
    expect(kind('tpl-pkg')).toEqual(['dynamic-literal']);
    expect(kind('exp-pkg')).toEqual(['export-from']);
    expect(kind('star-pkg')).toEqual(['export-from']);
    expect(kind('starns-pkg')).toEqual(['export-from']);
    expect(kind('exptype-pkg')).toEqual(['type-only']);
    expect(kind('typeof-pkg')).toEqual(['type-only']);
    const dyn = p.imports.filter((i) => i.kind === 'dynamic-expr');
    expect(dyn).toHaveLength(2);
    expect(dyn[0]!.specifier).toBeNull();
    expect(dyn.map((d) => d.line)).toEqual([11, 12]);
  });

  it('records bindings with imported/local names and type flags', () => {
    const p = parse(
      "import def, { a as b } from 'p';\nimport * as ns from 'q';\nimport { type U, v } from 'm';\nconst { x, y: z } = require('d');\nconst r = require('r');\nimport eq = require('e');\n"
    );
    expect(bySpec(p, 'p')[0]!.bindings).toEqual([
      { local: 'def', imported: 'default', isType: false },
      { local: 'b', imported: 'a', isType: false }
    ]);
    expect(bySpec(p, 'q')[0]!.bindings).toEqual([{ local: 'ns', imported: '*', isType: false }]);
    expect(bySpec(p, 'm')[0]!.bindings).toEqual([
      { local: 'U', imported: 'U', isType: true },
      { local: 'v', imported: 'v', isType: false }
    ]);
    expect(bySpec(p, 'd')[0]!.bindings).toEqual([
      { local: 'x', imported: 'x', isType: false },
      { local: 'z', imported: 'y', isType: false }
    ]);
    expect(bySpec(p, 'r')[0]!.bindings).toEqual([{ local: 'r', imported: 'default', isType: false }]);
    expect(bySpec(p, 'e')[0]!.bindings).toEqual([{ local: 'eq', imported: 'default', isType: false }]);
  });

  it('records line, col and a trimmed snippet', () => {
    const p = parse("\n   import { a } from 'pkg';   \n");
    expect(bySpec(p, 'pkg')[0]).toMatchObject({ line: 2, col: 3, snippet: "import { a } from 'pkg';" });
  });

  it('records local exports, default and every re-export form', () => {
    const p = parse(
      [
        "import moment from 'moment';",
        "import * as all from 'all-pkg';",
        'export const one = 1;',
        'export function two() {}',
        'export class Three {}',
        'const four = 4;',
        'export { four as fourth };',
        "export { x as y } from './a';",
        "export * from './b';",
        "export * as nsb from './c';",
        'export { moment };',
        'export { all as everything };',
        'export default moment;'
      ].join('\n'),
      'src/barrel.ts'
    );
    expect(p.exports).toEqual(expect.arrayContaining(['one', 'two', 'Three', 'fourth']));
    expect(p.exports).not.toContain('moment');
    const re = p.reexports.map((r) => ({ spec: p.imports[r.importIndex]!.specifier, exported: r.exported, imported: r.imported }));
    expect(re).toEqual(
      expect.arrayContaining([
        { spec: './a', exported: 'y', imported: 'x' },
        { spec: './b', exported: '*', imported: '*' },
        { spec: './c', exported: 'nsb', imported: '*' },
        { spec: 'moment', exported: 'moment', imported: 'default' },
        { spec: 'all-pkg', exported: 'everything', imported: '*' },
        { spec: 'moment', exported: 'default', imported: 'default' }
      ])
    );
    expect(re).toHaveLength(6);
    expect(p.hasExports).toBe(true);
  });

  it('treats CommonJS module.exports / exports.x as exports', () => {
    expect(parse('module.exports = { a: 1 };', 'src/a.js').hasExports).toBe(true);
    expect(parse('exports.b = 2;', 'src/b.js').hasExports).toBe(true);
    expect(parse("const x = require('x');\nx();", 'src/c.js').hasExports).toBe(false);
  });

  it('excludes shadowed names from usages (fixture shadowed-binding)', async () => {
    const p = await parseFixture('shadowed-binding', 'src/a.ts');
    expect(p.usages).toHaveLength(1);
    expect(p.usages[0]).toMatchObject({ local: 'moment', imported: 'default', member: 'locale', kind: 'call', line: 8 });
    expect(p.usages[0]!.snippet).toBe('export const lang = moment.locale();');
  });

  it('classifies call, new, member, jsx and value usages', () => {
    const p = parse(
      [
        "import moment from 'moment';",
        "import { Button } from 'antd';",
        "import Foo from 'foo';",
        "import * as UI from 'ui';",
        "import cfg from 'cfg';",
        'moment();',
        'moment.locale("en");',
        'moment.version;',
        '<Button />;',
        '<UI.Card />;',
        'new Foo();',
        'use(cfg);'
      ].join('\n')
    );
    const u = p.usages.map((x) => `${x.local}:${x.kind}:${x.member ?? ''}`);
    expect(u).toEqual([
      'moment:call:',
      'moment:call:locale',
      'moment:member:version',
      'Button:jsx:',
      'UI:jsx:Card',
      'Foo:new:',
      'cfg:value:'
    ]);
  });

  it('caps usage snippets at 200 chars', () => {
    const long = `import a from 'a';\na(${'"x",'.repeat(100)});`;
    const p = parse(long);
    expect(p.usages[0]!.snippet.length).toBeLessThanOrEqual(200);
  });

  it('a syntax error gives parse_error and an empty result, never a throw', () => {
    const p = parse("import { from 'x'\nconst = ;", 'src/bad.ts');
    expect(p.parseError).toMatch(/Unexpected token/);
    expect(p.imports).toEqual([]);
    expect(p.usages).toEqual([]);
    expect(p.exports).toEqual([]);
  });

  it('parses the cjs-esm-mix fixture', async () => {
    const server = await parseFixture('cjs-esm-mix', 'src/server.js');
    expect(server.imports.map((i) => [i.specifier, i.kind])).toEqual([
      ['express', 'require'],
      ['lodash', 'require'],
      ['./util.mjs', 'require']
    ]);
    expect(server.hasExports).toBe(true);
    expect(server.usages.map((x) => `${x.local}:${x.kind}:${x.member ?? ''}`)).toEqual([
      'express:call:',
      'chunk:call:',
      'lmap:call:',
      'util:member:red'
    ]);
    const idx = await parseFixture('cjs-esm-mix', 'src/index.cjs');
    expect(idx.imports.map((i) => [i.specifier, i.kind])).toEqual([
      ['./server', 'side-effect'],
      ['./util.mjs', 'dynamic-literal']
    ]);
    const legacy = await parseFixture('cjs-esm-mix', 'src/legacy.ts');
    expect(legacy.imports.map((i) => [i.specifier, i.kind])).toEqual([
      ['fs', 'require'],
      ['node:path', 'static']
    ]);
  });

  it('parity: finds the same package names as v1 parseImports', () => {
    const inputs = [
      "import React from 'react';\nimport { foo } from '@scope/pkg';\nimport './local';\n",
      "const lodash = require('lodash');\nconst foo = require('./foo');\n",
      "const modName = 'foo';\nconst dyn = require(modName);\n",
      "const m = 'lodash';\nimport(m).then(() => {});\n",
      "export * from 'react';\nexport { useState } from 'react-dom';\n",
      "import React from 'react';\nimport ReactDOM from 'react-dom';\n",
      "import 'real';",
      "require('victim')",
      "const m = 'foo';\nconst dyn = require(m);\nimport(m).then(() => {});\n",
      "import x from 'a/sub';\nimport('b').then(() => 1);\nimport type { T } from '@types/c';\n"
    ];
    for (const src of inputs) {
      const v1 = new Set(parseImports(src, 'src/x.ts').staticImports.map((s) => s.packageName));
      const v2 = new Set(
        parse(src, 'src/x.ts')
          .imports.filter((i) => i.specifier !== null && i.viaTypeQuery !== true)
          .map((i) => packageNameFromSpecifier(i.specifier!))
          .filter((n): n is string => n !== null)
      );
      expect([...v2].sort(), src).toEqual([...v1].sort());
    }
  });
});

describe('fileRole (3a.4)', () => {
  const entries = ['lib/main.js'];
  it.each([
    ['app/page.tsx', 'page'],
    ['app/layout.tsx', 'layout'],
    ['app/api/hello/route.ts', 'route'],
    ['app/dashboard/loading.tsx', 'loading'],
    ['app/not-found.tsx', 'not-found'],
    ['src/app/(group)/settings/template.jsx', 'template'],
    ['app/error.js', 'error'],
    ['app/@modal/default.tsx', 'default'],
    ['pages/about.tsx', 'page'],
    ['src/pages/index.jsx', 'page'],
    ['pages/api/legacy.ts', 'api-route'],
    ['middleware.ts', 'middleware'],
    ['src/middleware.js', 'middleware'],
    ['lib/main.js', 'entry'],
    ['components/Header.tsx', null],
    ['app/components/Button.tsx', null],
    ['styles/app/page.css', null]
  ])('%s → %s', (rel, role) => {
    expect(fileRole(rel, entries)).toBe(role);
  });
});
