/**
 * Deep scan pipeline tests (Stage 4, spec §11.6).
 *
 * Covered:
 *   - Happy path: packuments + OSV → lockfileSummary populated
 *   - Peer-dep conflict: candidate target doesn't satisfy peer → satisfiedByCandidate: false
 *   - CVE delta: target's fromVersion has a CVE not in toVersion → resolvedCves populated
 *   - L2 cache reuse: second run skips packument fetch
 *   - L2 cache invalidation: change lockfile state hash → refetch
 *   - Target read-only invariant: snapshot before/after, no diff
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createSandbox, disposeAllSandboxes, type Sandbox } from './helpers/sandbox';
import { createSmallNpmProject, snapshotDirectory } from './helpers/fixtures';
import { runDeepScan } from '@/lib/scanners/deepScan';
import { addProjectPipeline } from '@/lib/projects/add';
import type { RegistryFetcher, RegistryPackument } from '@/lib/scanners/registry';
import { deepCacheDir, deepCacheFilePath } from '@/lib/paths';

let sandbox: Sandbox | undefined;

beforeEach(() => {
  process.env.MOCK_LLM = 'true';
});
afterEach(async () => {
  delete process.env.MOCK_LLM;
  if (sandbox !== undefined) await sandbox.dispose();
  await disposeAllSandboxes();
  sandbox = undefined;
});

function makeMockRegistry(versions: Record<string, RegistryPackument>): RegistryFetcher {
  return {
    fetchPackument: async (name: string): Promise<RegistryPackument> => {
      const pack = versions[name];
      if (pack === undefined) throw new Error(`No fixture for ${name}`);
      return pack;
    }
  };
}

function pack(
  name: string,
  versionEntries: Array<{
    version: string;
    peerDependencies?: Record<string, string>;
    engines?: Record<string, string>;
  }>
): RegistryPackument {
  const latestEntry = versionEntries[versionEntries.length - 1]!;
  return {
    name,
    versions: versionEntries.map((v) => ({
      version: v.version,
      publishedAt: '2026-01-01T00:00:00Z',
      isPrerelease: false,
      deprecated: null,
      peerDependencies: v.peerDependencies ?? {},
      engines: v.engines ?? {}
    })),
    distTags: { latest: latestEntry.version },
    deprecation: null,
    homepage: null,
    repository: null,
    license: 'MIT',
    lastPublishAt: null,
    latestPeerDependencies: latestEntry.peerDependencies ?? {},
    latestEngines: latestEntry.engines ?? {}
  };
}

function mockOsvNoCves(): typeof fetch {
  // OSV.dev fetcher that always reports zero vulns.
  return (async (url: string | URL | Request): Promise<Response> => {
    const u = String(url);
    if (u.endsWith('/v1/querybatch')) {
      // Read the body to get the # of queries so we mirror back the same count.
      // Lazy approach: just return a generic empty results array of size 1000.
      return new Response(
        JSON.stringify({ results: Array.from({ length: 1000 }, () => ({ vulns: [] })) }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
}

describe('runDeepScan', () => {
  it('populates lockfileSummary.peerDepsOnTarget for transitives that peer on the target', async () => {
    sandbox = await createSandbox();
    const proj = path.join(sandbox.scratchRoot, 'p');
    await createSmallNpmProject(proj);
    const result = await addProjectPipeline({ absolutePath: proj });
    if (!result.ok) throw new Error(`Add failed: ${result.error.message}`);

    const registry = makeMockRegistry({
      react: pack('react', [{ version: '18.3.1' }]),
      'react-dom': pack('react-dom', [
        { version: '18.3.1', peerDependencies: { react: '^18.0.0' } }
      ]),
      scheduler: pack('scheduler', [{ version: '0.23.2' }]),
      typescript: pack('typescript', [{ version: '5.5.3' }])
    });

    const out = await runDeepScan({
      slug: result.slug,
      projectPath: proj,
      resolvedPackages: [
        { name: 'react', version: '18.3.1' },
        { name: 'react-dom', version: '18.3.1' },
        { name: 'scheduler', version: '0.23.2' },
        { name: 'typescript', version: '5.5.3' }
      ],
      lockfileStateHash: result.projectJson.lockfileStateHash,
      targetName: 'react',
      fromVersion: '18.3.1',
      toVersion: '19.0.0',
      registryFetcher: registry,
      osvFetch: mockOsvNoCves()
    });

    expect(out.lockfileSummary.totalPackages).toBe(4);
    // react-dom@18.3.1 has peerDeps: { react: '^18.0.0' } — 19.0.0 does NOT satisfy.
    const peer = out.lockfileSummary.peerDepsOnTarget.find((p) => p.package === 'react-dom');
    expect(peer).toBeDefined();
    expect(peer!.peerRange).toBe('^18.0.0');
    expect(peer!.satisfiedByCandidate).toBe(false);
  });

  it('caches L2 data and reuses it on second invocation (no extra packument fetches)', async () => {
    sandbox = await createSandbox();
    const proj = path.join(sandbox.scratchRoot, 'p');
    await createSmallNpmProject(proj);
    const result = await addProjectPipeline({ absolutePath: proj });
    if (!result.ok) throw new Error(`Add failed: ${result.error.message}`);

    let fetchCount = 0;
    const registry: RegistryFetcher = {
      fetchPackument: async (name) => {
        fetchCount += 1;
        return pack(name, [{ version: '1.0.0', peerDependencies: {} }]);
      }
    };

    const runOnce = async (): Promise<void> => {
      await runDeepScan({
        slug: result.slug,
        projectPath: proj,
        resolvedPackages: [
          { name: 'react', version: '18.3.1' },
          { name: 'react-dom', version: '18.3.1' }
        ],
        lockfileStateHash: result.projectJson.lockfileStateHash,
        targetName: 'react',
        fromVersion: '18.3.1',
        toVersion: '19.0.0',
        registryFetcher: registry,
        osvFetch: mockOsvNoCves()
      });
    };

    await runOnce();
    const fetchesAfterFirst = fetchCount;
    expect(fetchesAfterFirst).toBeGreaterThan(0);
    // Confirm cache file exists on disk.
    const fp = deepCacheFilePath(result.slug, result.projectJson.lockfileStateHash);
    expect(await fs.access(fp).then(() => true).catch(() => false)).toBe(true);

    await runOnce();
    expect(fetchCount).toBe(fetchesAfterFirst); // no new fetches
  });

  it('invalidates L2 cache when lockfileStateHash changes', async () => {
    sandbox = await createSandbox();
    const proj = path.join(sandbox.scratchRoot, 'p');
    await createSmallNpmProject(proj);
    const result = await addProjectPipeline({ absolutePath: proj });
    if (!result.ok) throw new Error(`Add failed: ${result.error.message}`);

    let fetchCount = 0;
    const registry: RegistryFetcher = {
      fetchPackument: async (name) => {
        fetchCount += 1;
        return pack(name, [{ version: '1.0.0', peerDependencies: {} }]);
      }
    };

    const baseInput = {
      slug: result.slug,
      projectPath: proj,
      resolvedPackages: [{ name: 'react', version: '18.3.1' }],
      targetName: 'react',
      fromVersion: '18.3.1',
      toVersion: '19.0.0',
      registryFetcher: registry,
      osvFetch: mockOsvNoCves()
    };

    await runDeepScan({
      ...baseInput,
      lockfileStateHash: 'hash-A'
    });
    const after1 = fetchCount;
    expect(after1).toBeGreaterThan(0);

    // Re-run with different lockfile hash → cache miss → refetch.
    await runDeepScan({
      ...baseInput,
      lockfileStateHash: 'hash-B'
    });
    expect(fetchCount).toBe(after1 * 2);
  });

  it('honours forceRefresh to bypass the L2 cache', async () => {
    sandbox = await createSandbox();
    const proj = path.join(sandbox.scratchRoot, 'p');
    await createSmallNpmProject(proj);
    const result = await addProjectPipeline({ absolutePath: proj });
    if (!result.ok) throw new Error(`Add failed: ${result.error.message}`);

    let fetchCount = 0;
    const registry: RegistryFetcher = {
      fetchPackument: async (name) => {
        fetchCount += 1;
        return pack(name, [{ version: '1.0.0', peerDependencies: {} }]);
      }
    };
    const baseInput = {
      slug: result.slug,
      projectPath: proj,
      resolvedPackages: [{ name: 'react', version: '18.3.1' }],
      lockfileStateHash: result.projectJson.lockfileStateHash,
      targetName: 'react',
      fromVersion: '18.3.1',
      toVersion: '19.0.0',
      registryFetcher: registry,
      osvFetch: mockOsvNoCves()
    };

    await runDeepScan(baseInput);
    const after1 = fetchCount;

    await runDeepScan({ ...baseInput, forceRefresh: true });
    expect(fetchCount).toBeGreaterThan(after1);
  });

  it('preserves target read-only invariant during deep scan', async () => {
    sandbox = await createSandbox();
    const proj = path.join(sandbox.scratchRoot, 'p');
    await createSmallNpmProject(proj);
    const result = await addProjectPipeline({ absolutePath: proj });
    if (!result.ok) throw new Error(`Add failed: ${result.error.message}`);

    const before = await snapshotDirectory(proj);

    const registry = makeMockRegistry({
      react: pack('react', [{ version: '18.3.1' }]),
      'react-dom': pack('react-dom', [{ version: '18.3.1' }]),
      scheduler: pack('scheduler', [{ version: '0.23.2' }]),
      typescript: pack('typescript', [{ version: '5.5.3' }])
    });

    await runDeepScan({
      slug: result.slug,
      projectPath: proj,
      resolvedPackages: [
        { name: 'react', version: '18.3.1' },
        { name: 'react-dom', version: '18.3.1' },
        { name: 'scheduler', version: '0.23.2' },
        { name: 'typescript', version: '5.5.3' }
      ],
      lockfileStateHash: result.projectJson.lockfileStateHash,
      targetName: 'react',
      fromVersion: '18.3.1',
      toVersion: '19.0.0',
      registryFetcher: registry,
      osvFetch: mockOsvNoCves()
    });

    const after = await snapshotDirectory(proj);
    expect(after).toEqual(before);
  });
});

describe('runDeepScan — CVE delta', () => {
  it('populates resolvedCves when fromVersion has a CVE that toVersion does not', async () => {
    sandbox = await createSandbox();
    const proj = path.join(sandbox.scratchRoot, 'p');
    await createSmallNpmProject(proj);
    const result = await addProjectPipeline({ absolutePath: proj });
    if (!result.ok) throw new Error(`Add failed: ${result.error.message}`);

    const registry = makeMockRegistry({
      react: pack('react', [
        { version: '18.3.1' },
        { version: '19.0.0' }
      ])
    });

    let batchCallNumber = 0;
    const osv: typeof fetch = (async (url: string | URL | Request, init?: unknown): Promise<Response> => {
      const u = String(url);
      if (u.endsWith('/v1/querybatch')) {
        const body = (init as { body?: string } | undefined)?.body;
        // First batch is the transitive set (all packages); second batch is
        // the target's from/to pair (the CVE delta call). We distinguish by
        // looking at the body's package list.
        batchCallNumber += 1;
        const parsed = JSON.parse(body ?? '{}') as { queries: Array<{ package: { name: string }; version: string }> };
        const ids = parsed.queries.map((q) => {
          if (q.package.name === 'react' && q.version === '18.3.1') {
            return ['CVE-OLD-001'];
          }
          return [];
        });
        return new Response(JSON.stringify({ results: ids.map((vulns) => ({ vulns: vulns.map((id) => ({ id })) })) }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (u.includes('/v1/vulns/')) {
        const id = u.split('/').pop()!;
        return new Response(
          JSON.stringify({ id, summary: `${id} summary`, database_specific: { severity: 'HIGH' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const out = await runDeepScan({
      slug: result.slug,
      projectPath: proj,
      resolvedPackages: [
        { name: 'react', version: '18.3.1' },
        { name: 'react-dom', version: '18.3.1' },
        { name: 'scheduler', version: '0.23.2' },
        { name: 'typescript', version: '5.5.3' }
      ],
      lockfileStateHash: result.projectJson.lockfileStateHash,
      targetName: 'react',
      fromVersion: '18.3.1',
      toVersion: '19.0.0',
      registryFetcher: registry,
      osvFetch: osv,
      forceRefresh: true
    });

    expect(out.cveDelta.resolvedCves.length).toBe(1);
    expect(out.cveDelta.resolvedCves[0]!.id).toBe('CVE-OLD-001');
    expect(out.cveDelta.newCves.length).toBe(0);
    expect(batchCallNumber).toBeGreaterThan(0);
  });
});
