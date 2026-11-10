import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { createSandbox, type Sandbox } from '../helpers/sandbox';
import { copyGraphFixture, writeProjectFile } from '../helpers/graphFixture';
import { buildGraph } from '@/core/graph/build';
import { openGraphReader, type GraphDriver } from '@/core/graph/store';
import {
  filesUsingPackage,
  symbolsUsed,
  usageSites,
  dependents,
  affectedEntryPoints,
  testsCovering,
  wrappers,
  unresolved,
  graphInfo,
  importStatements,
  dynamicImports,
  skippedFiles
} from '@/core/graph/query';

let sandbox: Sandbox;
const dbs: Record<string, GraphDriver> = {};
const lock = <T>(_key: string, fn: () => Promise<T>): Promise<T> => fn();

async function build(name: string, prepare?: (root: string) => Promise<void>, fixture = name): Promise<void> {
  const { projectRoot, dbPath } = await copyGraphFixture(sandbox, fixture, name);
  if (prepare !== undefined) await prepare(projectRoot);
  await buildGraph({ projectRoot, dbPath, mode: 'full', lock });
  dbs[name] = openGraphReader(dbPath);
}

beforeAll(async () => {
  sandbox = await createSandbox('graph-query');
  await build('wrapper-module');
  await build('barrel-reexport');
  await build('next-app-router');
  await build('index-files');
  await build('dynamic-import');
  await build('oversized', async (root) => {
    await writeProjectFile(root, 'src/huge.ts', 'x'.repeat(2 * 1024 * 1024 + 1));
    await writeProjectFile(root, 'src/huge.css', 'a{}'.repeat(700 * 1024));
  }, 'index-files');
  await build('cycle', async (root) => {
    await writeProjectFile(root, 'src/a.ts', "import { b } from './b';\nexport const a = () => b;\n");
    await writeProjectFile(root, 'src/b.ts', "import { c } from './c';\nexport const b = () => c;\n");
    await writeProjectFile(root, 'src/c.ts', "import { a } from './a';\nexport const c = () => a;\n");
    await writeProjectFile(root, 'src/d.ts', "import { a } from './a';\nexport const d = a;\n");
  }, 'index-files');
}, 60_000);

afterAll(async () => {
  for (const db of Object.values(dbs)) db.close();
  await sandbox.dispose();
});

describe('filesUsingPackage (3a.9)', () => {
  it('wrapper-module: direct + wrapper hits, path-sorted, with confidence', () => {
    expect(filesUsingPackage(dbs['wrapper-module']!, 'axios')).toEqual([
      { path: 'src/components/Avatar.tsx', category: 'prod', role: null, via: 'wrapper', depth: 1, viaPath: ['src/lib/http.ts'], confidence: 'medium' },
      { path: 'src/features/posts.ts', category: 'prod', role: null, via: 'wrapper', depth: 1, viaPath: ['src/lib/http.ts'], confidence: 'medium' },
      { path: 'src/features/users.ts', category: 'prod', role: null, via: 'wrapper', depth: 1, viaPath: ['src/lib/http.ts'], confidence: 'medium' },
      { path: 'src/lib/http.ts', category: 'prod', role: null, via: 'direct', depth: 0, viaPath: [], confidence: 'medium' }
    ]);
  });

  it('transitive: false and wrapperDepth: 0 restrict the hits', () => {
    const db = dbs['wrapper-module']!;
    expect(filesUsingPackage(db, 'axios', { transitive: false }).map((h) => h.path)).toEqual(['src/lib/http.ts']);
    expect(filesUsingPackage(db, 'axios', { wrapperDepth: 0 }).map((h) => h.path)).toEqual(['src/lib/http.ts']);
  });

  it('wrapperDepth: 2 follows one more exporting layer, viaPath runs from the hit towards the package', () => {
    const hits = filesUsingPackage(dbs['wrapper-module']!, 'axios', { wrapperDepth: 2 });
    expect(hits.find((h) => h.path === 'src/features/__tests__/users.test.ts')).toEqual({
      path: 'src/features/__tests__/users.test.ts',
      category: 'test',
      role: null,
      via: 'wrapper',
      depth: 2,
      viaPath: ['src/features/users.ts', 'src/lib/http.ts'],
      confidence: 'medium'
    });
  });

  it('barrel-reexport: one hit per file, best via wins (direct > reexport > wrapper)', () => {
    const hits = filesUsingPackage(dbs['barrel-reexport']!, 'antd');
    expect(hits.map((h) => `${h.path}:${h.via}:${h.depth}`)).toEqual([
      'src/app/Local.tsx:reexport:1',
      'src/app/Ns.tsx:reexport:2',
      'src/app/Page.tsx:reexport:3',
      'src/ui/Button.tsx:direct:0',
      'src/ui/index.ts:wrapper:1'
    ]);
  });

  it('categories and kinds filters', () => {
    const db = dbs['wrapper-module']!;
    expect(filesUsingPackage(db, 'axios', { categories: ['test'], wrapperDepth: 2 }).map((h) => h.path)).toEqual([
      'src/features/__tests__/users.test.ts'
    ]);
    expect(filesUsingPackage(db, 'axios', { kinds: ['require'] })).toEqual([]);
    expect(filesUsingPackage(db, 'axios', { kinds: ['static'], transitive: false }).map((h) => h.path)).toEqual(['src/lib/http.ts']);
  });

  it('an unknown package gives an empty result', () => {
    expect(filesUsingPackage(dbs['wrapper-module']!, 'not-a-dep')).toEqual([]);
    expect(filesUsingPackage(dbs['wrapper-module']!, '')).toEqual([]);
  });
});

describe('symbolsUsed / usageSites (3a.9)', () => {
  it('symbolsUsed counts symbol + member pairs, including through re-exports', () => {
    expect(symbolsUsed(dbs['wrapper-module']!, 'axios')).toEqual([
      { symbol: 'default', member: 'get', count: 1 },
      { symbol: 'default', member: 'post', count: 1 }
    ]);
    expect(symbolsUsed(dbs['barrel-reexport']!, 'antd')).toEqual([
      { symbol: 'Button', member: null, count: 2 },
      { symbol: 'Button', member: 'Button', count: 1 }
    ]);
    expect(symbolsUsed(dbs['wrapper-module']!, 'nope')).toEqual([]);
  });

  it('usageSites lists call sites with snippets, filtered and paginated', () => {
    const db = dbs['wrapper-module']!;
    expect(usageSites(db, 'axios')).toEqual([
      { path: 'src/lib/http.ts', line: 3, col: 36, kind: 'call', symbol: 'default', member: 'get', snippet: 'export const get = (url: string) => axios.get(url);', confidence: 'medium' },
      {
        path: 'src/lib/http.ts',
        line: 4,
        col: 52,
        kind: 'call',
        symbol: 'default',
        member: 'post',
        snippet: 'export const post = (url: string, body: unknown) => axios.post(url, body);',
        confidence: 'medium'
      }
    ]);
    expect(usageSites(db, 'axios', 'default', 'post').map((u) => u.line)).toEqual([4]);
    expect(usageSites(db, 'axios', undefined, undefined, { limit: 1, offset: 1 }).map((u) => u.line)).toEqual([4]);
    const barrel = usageSites(dbs['barrel-reexport']!, 'antd', 'Button');
    expect(barrel.map((u) => `${u.path}:${u.kind}:${u.confidence}`)).toEqual([
      'src/app/Local.tsx:jsx:medium',
      'src/app/Ns.tsx:jsx:medium',
      'src/app/Page.tsx:jsx:medium'
    ]);
  });
});

describe('dependents / affectedEntryPoints / testsCovering / wrappers (3a.9)', () => {
  it('dependents: reverse closure with distance, cycle-safe', () => {
    expect(dependents(dbs['cycle']!, 'src/a.ts')).toEqual([
      { path: 'src/b.ts', category: 'prod', role: null, depth: 2 },
      { path: 'src/c.ts', category: 'prod', role: null, depth: 1 },
      { path: 'src/d.ts', category: 'prod', role: null, depth: 1 }
    ]);
    expect(dependents(dbs['cycle']!, 'src/a.ts', { depth: 1 }).map((d) => d.path)).toEqual(['src/c.ts', 'src/d.ts']);
    expect(dependents(dbs['cycle']!, 'src/missing.ts')).toEqual([]);
  });

  it('affectedEntryPoints: page/route files reached from a file or a package', () => {
    const db = dbs['next-app-router']!;
    expect(affectedEntryPoints(db, { file: 'components/Header.tsx' })).toEqual([
      { path: 'app/page.tsx', role: 'page', depth: 1 },
      { path: 'pages/about.tsx', role: 'page', depth: 1 }
    ]);
    expect(affectedEntryPoints(db, { file: 'lib/main.js' })).toEqual([
      { path: 'app/api/hello/route.ts', role: 'route', depth: 1 },
      { path: 'lib/main.js', role: 'entry', depth: 0 }
    ]);
    expect(affectedEntryPoints(db, 'react').map((e) => `${e.path}:${e.role}:${e.depth}`)).toEqual([
      'app/layout.tsx:layout:0',
      'app/page.tsx:page:1',
      'pages/about.tsx:page:1'
    ]);
  });

  it('testsCovering returns test files whose forward closure reaches an input', () => {
    expect(testsCovering(dbs['wrapper-module']!, ['src/lib/http.ts'])).toEqual([
      { path: 'src/features/__tests__/users.test.ts', category: 'test', role: null, depth: 2 }
    ]);
    expect(testsCovering(dbs['next-app-router']!, ['components/Header.tsx']).map((t) => t.path)).toEqual(['__tests__/Header.test.tsx']);
    expect(testsCovering(dbs['wrapper-module']!, ['src/components/Avatar.tsx'])).toEqual([]);
  });

  it('wrappers lists exporting files with a direct edge to the package', () => {
    expect(wrappers(dbs['wrapper-module']!, 'axios').map((w) => `${w.path}:${w.via}`)).toEqual(['src/lib/http.ts:direct']);
  });
});

describe('unresolved / graphInfo (3a.9)', () => {
  it('lists every unresolved edge with a summary', () => {
    const res = unresolved(dbs['dynamic-import']!);
    expect(res.items).toEqual([
      { path: 'src/router.ts', line: 2, specifier: '', kind: 'dynamic-expr', reason: 'dynamic-expression', snippet: 'export const locale = (l: string) => import(`./locales/${l}.json`);' }
    ]);
    expect(res.summary).toEqual({ totalEdges: 3, unresolved: 1, pct: 1 / 3, byReason: { 'dynamic-expression': 1 } });
    const idx = unresolved(dbs['index-files']!, { limit: 10, offset: 0 });
    expect(idx.items.map((i) => `${i.path}:${i.specifier}:${i.reason}`)).toEqual(['src/app.ts:./missing:not-found']);
    expect(unresolved(dbs['index-files']!, { limit: 10, offset: 1 }).items).toEqual([]);
  });

  it('graphInfo returns meta and counts', () => {
    const info = graphInfo(dbs['wrapper-module']!);
    expect(info.meta.parser).toBe('babel@7.24.7');
    expect(info.counts).toEqual({ files: 6, packages: 1, edges: 5, unresolved: 0, usages: info.counts.usages, reach: 4 });
    expect(info.counts.usages).toBeGreaterThan(0);
  });
});

// Stage 3c (OQ-3b-A1): the reads view [C] needs, so src/lib/graph issues no SQL.
describe('importStatements / dynamicImports / skippedFiles', () => {
  it('importStatements: direct edges per file, path/line ordered', () => {
    const st = importStatements(dbs['wrapper-module']!, 'axios');
    expect(st.map((x) => `${x.path}:${x.line}:${x.via}:${x.snippet}`)).toEqual(["src/lib/http.ts:1:direct:import axios from 'axios';"]);
  });

  it('importStatements: barrel consumers get their importing line as reexport', () => {
    const st = importStatements(dbs['barrel-reexport']!, 'antd');
    const byFile = (p: string) => st.filter((x) => x.path === p).map((x) => x.via);
    expect(byFile('src/ui/Button.tsx')).toEqual(['direct']);
    expect(byFile('src/app/Page.tsx')).toEqual(['reexport']);
    expect(byFile('src/ui/index.ts')).toEqual([]);
    expect(st.map((x) => x.path)).toEqual([...st.map((x) => x.path)].sort());
  });

  it('importStatements: kinds filter applies to direct edges; unknown package is empty', () => {
    expect(importStatements(dbs['wrapper-module']!, 'axios', { kinds: ['require'] })).toEqual([]);
    expect(importStatements(dbs['wrapper-module']!, 'no-such-pkg')).toEqual([]);
  });

  it('dynamicImports lists dynamic-expression edges', () => {
    expect(dynamicImports(dbs['dynamic-import']!)).toEqual([
      { path: 'src/router.ts', line: 2, col: expect.any(Number), snippet: 'export const locale = (l: string) => import(`./locales/${l}.json`);' }
    ]);
    expect(dynamicImports(dbs['index-files']!)).toEqual([]);
  });

  it('skippedFiles filters by reason and file kind', () => {
    const db = dbs['oversized']!;
    expect(skippedFiles(db).map((f) => `${f.path}:${f.kind}:${f.reason}`)).toEqual(['src/huge.css:style:oversized', 'src/huge.ts:js:oversized']);
    expect(skippedFiles(db, { reason: 'oversized', kinds: ['js'] })).toEqual([
      { path: 'src/huge.ts', size: 2 * 1024 * 1024 + 1, kind: 'js', reason: 'oversized' }
    ]);
    expect(skippedFiles(db, { reason: 'minified' })).toEqual([]);
  });
});

describe('query module boundary', () => {
  it('lives in src/core and has no Next/React types', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(path.join(process.cwd(), 'src', 'core', 'graph', 'query.ts'), 'utf8');
    expect(src).not.toMatch(/from ['"](next|react)/);
  });
});
