import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSandbox, type Sandbox } from '../helpers/sandbox';
import { buildAgentFixture, type BuiltFixture } from '../helpers/agentFixture';
import { createToolRegistry, type ToolRegistry } from '@/core/agent/registry';
import { graphTools } from '@/core/agent/tools/graph';

let sandbox: Sandbox;
let reg: ToolRegistry;
const fx: Record<string, BuiltFixture> = {};

async function call(fixture: string, tool: string, input: Record<string, unknown>) {
  const r = await reg.call(tool, input, fx[fixture]!.ctx());
  if (r.isError) throw new Error(r.content);
  expect(Buffer.byteLength(r.content, 'utf8')).toBeLessThanOrEqual(16 * 1024);
  return JSON.parse(r.content) as Record<string, unknown> & { items: Array<Record<string, unknown>>; total: number; nextOffset: number | null };
}

beforeAll(async () => {
  sandbox = await createSandbox('agent-tools-graph');
  reg = createToolRegistry(graphTools());
  fx['wrapper-module'] = await buildAgentFixture(sandbox, 'wrapper-module');
  fx['barrel-reexport'] = await buildAgentFixture(sandbox, 'barrel-reexport');
  fx['next-app-router'] = await buildAgentFixture(sandbox, 'next-app-router');
}, 60_000);

afterAll(async () => {
  for (const f of Object.values(fx)) f.graph.close();
  await sandbox.dispose();
});

describe('graph tools (4a.2)', () => {
  it('registers every spec tool, all read-only', () => {
    expect(reg.tools.map((t) => t.name)).toEqual([
      'affected_entry_points',
      'dependents',
      'files_using_package',
      'graph_summary',
      'symbols_used',
      'tests_covering',
      'unresolved_imports',
      'usage_sites',
      'wrappers'
    ]);
    expect(reg.tools.every((t) => t.capability === 'read')).toBe(true);
  });

  it('graph_summary counts files and lists entry points', async () => {
    const s = await call('next-app-router', 'graph_summary', {});
    expect(s.files).toBeGreaterThan(5);
    expect(typeof s.builtAt).toBe('string');
    const eps = (s.entryPoints as Array<{ path: string }>).map((e) => e.path);
    expect(eps).toContain('app/page.tsx');
    expect(eps).toEqual([...eps].sort());
    expect((s.filesByCategory as Record<string, number>).test).toBe(1);
  });

  it('files_using_package: via, viaPath and confidence on every hit', async () => {
    const r = await call('wrapper-module', 'files_using_package', { pkg: 'axios' });
    expect(r.total).toBe(4);
    expect(r.nextOffset).toBeNull();
    expect(r.items.map((h) => `${h.path}:${h.via}:${h.confidence}`)).toEqual([
      'src/components/Avatar.tsx:wrapper:medium',
      'src/features/posts.ts:wrapper:medium',
      'src/features/users.ts:wrapper:medium',
      'src/lib/http.ts:direct:medium'
    ]);
    expect(r.items[0]!.viaPath).toEqual(['src/lib/http.ts']);
    const direct = await call('wrapper-module', 'files_using_package', { pkg: 'axios', transitive: false });
    expect(direct.items.map((h) => h.path)).toEqual(['src/lib/http.ts']);
    const deep = await call('wrapper-module', 'files_using_package', { pkg: 'axios', wrapper_depth: 2 });
    expect(deep.items.map((h) => h.path)).toContain('src/features/__tests__/users.test.ts');
  });

  it('files_using_package pagination: nextOffset correct, last page null', async () => {
    const p1 = await call('wrapper-module', 'files_using_package', { pkg: 'axios', limit: 3 });
    expect(p1.items).toHaveLength(3);
    expect(p1.nextOffset).toBe(3);
    const p2 = await call('wrapper-module', 'files_using_package', { pkg: 'axios', limit: 3, offset: 3 });
    expect(p2.items.map((h) => h.path)).toEqual(['src/lib/http.ts']);
    expect(p2.nextOffset).toBeNull();
  });

  it('barrel-reexport: reexport hits carry their hop count', async () => {
    const r = await call('barrel-reexport', 'files_using_package', { pkg: 'antd' });
    expect(r.items.map((h) => `${h.path}:${h.via}:${h.depth}`)).toEqual([
      'src/app/Local.tsx:reexport:1',
      'src/app/Ns.tsx:reexport:2',
      'src/app/Page.tsx:reexport:3',
      'src/ui/Button.tsx:direct:0',
      'src/ui/index.ts:wrapper:1'
    ]);
  });

  it('symbols_used and usage_sites', async () => {
    const s = await call('wrapper-module', 'symbols_used', { pkg: 'axios' });
    expect(s.items).toEqual([
      { symbol: 'default', member: 'get', count: 1 },
      { symbol: 'default', member: 'post', count: 1 }
    ]);
    const u = await call('wrapper-module', 'usage_sites', { pkg: 'axios', symbol: 'default', member: 'post' });
    expect(u.items).toEqual([
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
    const p = await call('wrapper-module', 'usage_sites', { pkg: 'axios', limit: 1 });
    expect(p.total).toBe(2);
    expect(p.nextOffset).toBe(1);
  });

  it('dependents, tests_covering, wrappers, affected_entry_points', async () => {
    const d = await call('wrapper-module', 'dependents', { file: 'src/lib/http.ts', depth: 1 });
    expect(d.items.map((h) => h.path)).toEqual(['src/components/Avatar.tsx', 'src/features/posts.ts', 'src/features/users.ts']);
    const d2 = await call('wrapper-module', 'dependents', { file: 'src/lib/http.ts' });
    expect(d2.items.map((h) => h.path)).toContain('src/features/__tests__/users.test.ts');
    const t = await call('wrapper-module', 'tests_covering', { files: ['src/lib/http.ts'] });
    expect(t.items.map((h) => h.path)).toEqual(['src/features/__tests__/users.test.ts']);
    const w = await call('wrapper-module', 'wrappers', { pkg: 'axios' });
    expect(w.items.map((h) => h.path)).toEqual(['src/lib/http.ts']);
    const e = await call('next-app-router', 'affected_entry_points', { file: 'components/Header.tsx' });
    expect(e.items.length).toBeGreaterThan(0);
    expect(e.items.every((x) => typeof x.role === 'string')).toBe(true);
  });

  it('unresolved_imports returns items plus summary', async () => {
    const r = await call('wrapper-module', 'unresolved_imports', {});
    expect(r.summary).toMatchObject({ unresolved: r.total });
    expect(r.nextOffset).toBeNull();
  });

  it('unknown package / file → empty result, not an error', async () => {
    for (const [tool, input] of [
      ['files_using_package', { pkg: 'not-a-dep' }],
      ['symbols_used', { pkg: 'not-a-dep' }],
      ['usage_sites', { pkg: 'not-a-dep' }],
      ['wrappers', { pkg: 'not-a-dep' }],
      ['dependents', { file: 'nope.ts' }],
      ['tests_covering', { files: ['nope.ts'] }],
      ['affected_entry_points', { pkg: 'not-a-dep' }]
    ] as const) {
      const r = await call('wrapper-module', tool, input);
      expect(r).toEqual({ items: [], total: 0, nextOffset: null });
    }
  });

  it('bounds are rejected by the registry', async () => {
    const ctx = fx['wrapper-module']!.ctx();
    expect((await reg.call('dependents', { file: 'a.ts', depth: 6 }, ctx)).isError).toBe(true);
    expect((await reg.call('files_using_package', { pkg: 'axios', limit: 201 }, ctx)).isError).toBe(true);
    expect((await reg.call('files_using_package', { pkg: 'axios', offset: -1 }, ctx)).isError).toBe(true);
    const many = Array.from({ length: 101 }, (_, i) => `f${i}.ts`);
    expect((await reg.call('tests_covering', { files: many }, ctx)).isError).toBe(true);
    const both = await reg.call('affected_entry_points', { pkg: 'axios', file: 'src/lib/http.ts' }, ctx);
    expect(both).toMatchObject({ isError: true, content: 'affected_entry_points failed: pass exactly one of pkg or file' });
  });
});
