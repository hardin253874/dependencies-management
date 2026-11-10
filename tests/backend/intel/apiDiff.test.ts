/**
 * api_diff (V2_STAGE4_SPEC 4a.4): tarballs built at test time, fake fetchers,
 * no network, nothing executed.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import cp from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { createSandbox, type Sandbox } from '../helpers/sandbox';
import { buildAgentFixture, type BuiltFixture } from '../helpers/agentFixture';
import { makeTgz, packageTgz } from '../helpers/tarball';
import { computeApiDiff, typesPackageName, apiDiffCacheFile } from '@/core/intel/apiDiff';
import { readTypesFromTarball } from '@/core/intel/tarball';
import { createToolRegistry } from '@/core/agent/registry';
import { apiDiffTools } from '@/core/agent/tools/apiDiff';
import type { IntelContext, PackumentLike } from '@/core/agent/types';

const V1 = `export declare function get(url: string): Promise<unknown>;
/** old */
export declare function legacy(): void;
declare const axios: { get(url: string): Promise<unknown> };
export default axios;
`;
const V2 = `export declare function get(url: string, opts?: object): Promise<unknown>;
export declare function fresh(): void;
declare const axios: { get(url: string): Promise<unknown>; post(url: string, body: unknown): Promise<unknown> };
export default axios;
`;

const tarballs: Record<string, Buffer> = {
  'https://r/axios-1.0.0.tgz': packageTgz({
    'package.json': JSON.stringify({ name: 'axios', version: '1.0.0', types: 'index.d.ts', scripts: { postinstall: 'node evil.js' } }),
    'index.d.ts': V1,
    'evil.js': "require('child_process').execSync('echo pwned')"
  }),
  'https://r/axios-2.0.0.tgz': packageTgz({ 'package.json': JSON.stringify({ name: 'axios', version: '2.0.0', exports: { '.': { types: './lib/index.d.ts' } } }), 'lib/index.d.ts': V2 }),
  // no own types → @types fallback
  'https://r/plain-1.2.0.tgz': packageTgz({ 'package.json': JSON.stringify({ name: 'plain', version: '1.2.0' }), 'index.js': 'module.exports = {}' }),
  'https://r/plain-2.0.1.tgz': packageTgz({ 'package.json': JSON.stringify({ name: 'plain', version: '2.0.1' }), 'index.js': 'module.exports = {}' }),
  'https://r/types-plain-1.2.9.tgz': makeTgz([
    { name: 'plain/package.json', content: JSON.stringify({ name: '@types/plain', version: '1.2.9', types: 'index.d.ts' }) },
    { name: 'plain/index.d.ts', content: 'export declare function a(x: number): void;\nexport declare function gone(): void;\n' }
  ]),
  'https://r/types-plain-2.0.0.tgz': makeTgz([
    { name: 'plain/package.json', content: JSON.stringify({ name: '@types/plain', version: '2.0.0', types: 'index.d.ts' }) },
    { name: 'plain/index.d.ts', content: 'export declare function a(x: string): void;\n' }
  ]),
  'https://r/untyped-1.0.0.tgz': packageTgz({ 'package.json': '{}', 'index.js': '' }),
  'https://r/untyped-2.0.0.tgz': packageTgz({ 'package.json': '{}', 'index.js': '' })
};

const packuments: Record<string, PackumentLike> = {
  axios: { versions: { '1.0.0': { dist: { tarball: 'https://r/axios-1.0.0.tgz' } }, '2.0.0': { dist: { tarball: 'https://r/axios-2.0.0.tgz' } } } },
  plain: { versions: { '1.2.0': { dist: { tarball: 'https://r/plain-1.2.0.tgz' } }, '2.0.1': { dist: { tarball: 'https://r/plain-2.0.1.tgz' } } } },
  '@types/plain': {
    versions: {
      '1.2.3': { dist: { tarball: 'https://r/none.tgz' } },
      '1.2.9': { dist: { tarball: 'https://r/types-plain-1.2.9.tgz' } },
      '1.3.0': { dist: { tarball: 'https://r/none.tgz' } },
      '2.0.0': { dist: { tarball: 'https://r/types-plain-2.0.0.tgz' } }
    }
  },
  untyped: { versions: { '1.0.0': { dist: { tarball: 'https://r/untyped-1.0.0.tgz' } }, '2.0.0': { dist: { tarball: 'https://r/untyped-2.0.0.tgz' } } } }
};

let sandbox: Sandbox;
let fx: BuiltFixture;

function intel(over: Partial<IntelContext> = {}): IntelContext & { fetchPackument: ReturnType<typeof vi.fn>; fetchTarball: ReturnType<typeof vi.fn> } {
  const fetchPackument = vi.fn(async (name: string) => {
    const p = packuments[name];
    if (p === undefined) throw new Error(`404 ${name}`);
    return p;
  });
  const fetchTarball = vi.fn(async (url: string) => {
    const t = tarballs[url];
    if (t === undefined) throw new Error(`404 ${url}`);
    return new Uint8Array(t);
  });
  return { fetchPackument, fetchTarball, apiDiffCacheDir: path.join(sandbox.libraryRoot, '_apidiff'), ...over } as never;
}

beforeAll(async () => {
  sandbox = await createSandbox('api-diff');
  fx = await buildAgentFixture(sandbox, 'wrapper-module');
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  fx.graph.close();
  await sandbox.dispose();
});

describe('computeApiDiff (4a.4)', () => {
  it('own types: one removed, two changed, one added', async () => {
    const r = await computeApiDiff(intel({ apiDiffCacheDir: undefined }), 'axios', '1.0.0', '2.0.0');
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.sources.from).toEqual({ package: 'axios', version: '1.0.0', entry: 'index.d.ts', via: 'own' });
    expect(r.sources.to.entry).toBe('lib/index.d.ts');
    expect(r.removed.map((e) => e.name)).toEqual(['legacy']);
    expect(r.added.map((e) => e.name)).toEqual(['fresh']);
    expect(r.signatureChanged.map((e) => e.name)).toEqual(['default', 'get']);
    expect(r.signatureChanged.find((e) => e.name === 'get')).toMatchObject({ from: 'export declare function get(url:string):Promise<unknown>;' });
    expect(r.renamedCandidate).toEqual([{ from: 'legacy', to: 'fresh', confidence: 'low' }]);
  });

  it('@types fallback picks the highest version with the same major.minor', async () => {
    const r = await computeApiDiff(intel({ apiDiffCacheDir: undefined }), 'plain', '1.2.0', '2.0.1');
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.sources.from).toMatchObject({ package: '@types/plain', version: '1.2.9', via: '@types' });
    expect(r.sources.to).toMatchObject({ package: '@types/plain', version: '2.0.0' });
    expect(r.removed.map((e) => e.name)).toEqual(['gone']);
    expect(r.signatureChanged.map((e) => e.name)).toEqual(['a']);
    expect(typesPackageName('@scope/pkg')).toBe('@types/scope__pkg');
  });

  it('no types anywhere → unavailable with a reason', async () => {
    const r = await computeApiDiff(intel({ apiDiffCacheDir: undefined }), 'untyped', '1.0.0', '2.0.0');
    expect(r).toMatchObject({ status: 'unavailable' });
    if (r.status === 'unavailable') expect(r.reason).toMatch(/ships no types/);
  });

  it('a tarball entry with ../ is refused', () => {
    const evil = makeTgz([
      { name: 'package/index.d.ts', content: 'export {};' },
      { name: 'package/../../escape.d.ts', content: 'x' }
    ]);
    expect(() => readTypesFromTarball(evil)).toThrow(/refused/);
    expect(() => readTypesFromTarball(makeTgz([{ name: '/abs/index.d.ts', content: '' }]))).toThrow(/refused/);
  });

  it('keeps only type files + package.json, and never runs a postinstall script', async () => {
    const spies = (['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const).map((m) => vi.spyOn(cp, m));
    const files = readTypesFromTarball(tarballs['https://r/axios-1.0.0.tgz']!);
    expect([...files.keys()].sort()).toEqual(['index.d.ts', 'package.json']);
    await computeApiDiff(intel({ apiDiffCacheDir: undefined }), 'axios', '1.0.0', '2.0.0');
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it('cache hit on the second call: the fetchers are not called again', async () => {
    const i = intel();
    const first = await computeApiDiff(i, 'axios', '1.0.0', '2.0.0');
    expect(existsSync(apiDiffCacheFile(i.apiDiffCacheDir!, 'axios', '1.0.0', '2.0.0'))).toBe(true);
    const calls = i.fetchTarball.mock.calls.length;
    const again = await computeApiDiff(i, 'axios', '1.0.0', '2.0.0');
    expect(again).toEqual(first);
    expect(i.fetchTarball.mock.calls.length).toBe(calls);
    expect(i.fetchPackument.mock.calls.length).toBe(1);
  });
});

describe('api_diff tool (4a.4)', () => {
  it('joins removed/changed exports to the graph usage sites', async () => {
    const reg = createToolRegistry(apiDiffTools());
    const r = await reg.call('api_diff', { pkg: 'axios', from: '1.0.0', to: '2.0.0' }, fx.ctx({ intel: intel({ apiDiffCacheDir: undefined }) }));
    expect(r.isError).toBe(false);
    const out = JSON.parse(r.content);
    const def = out.signatureChanged.find((e: { name: string }) => e.name === 'default');
    expect(def.usage.total).toBe(2);
    expect(def.usage.sites.map((s: { path: string; line: number }) => `${s.path}:${s.line}`)).toEqual(['src/lib/http.ts:3', 'src/lib/http.ts:4']);
    const get = out.signatureChanged.find((e: { name: string }) => e.name === 'get');
    expect(get.usage.sites.map((s: { member: string }) => s.member)).toEqual(['get']);
    expect(out.removed[0].usage).toEqual({ sites: [], total: 0 });
  });

  it('no registry → status unavailable (not an error)', async () => {
    const reg = createToolRegistry(apiDiffTools());
    const r = await reg.call('api_diff', { pkg: 'axios', from: '1.0.0', to: '2.0.0' }, fx.ctx());
    expect(JSON.parse(r.content)).toMatchObject({ status: 'unavailable' });
  });
});
