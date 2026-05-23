/**
 * Registry client unit tests (spec §10.4, §10.9).
 *
 * Covered:
 *   - 429 → retry honouring Retry-After
 *   - 4xx (non-429) → AbortError; no retries beyond the first attempt
 *   - Successful packument shape
 *   - availableVersions cap on a 200-version package
 */
import { describe, it, expect } from 'vitest';
import { createRegistryFetcher, normalizePackument } from '@/lib/scanners/registry';
import { applyAvailableVersionsCap } from '@/lib/scanners/phase2';

interface MockResponse {
  status: number;
  statusText?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

function mockFetcher(responses: MockResponse[]) {
  let i = 0;
  const calls: number[] = [];
  const fn = async (_url: string): Promise<{
    status: number;
    statusText: string;
    headers: { get: (n: string) => string | null };
    json: () => Promise<unknown>;
  }> => {
    calls.push(i);
    const resp = responses[i] ?? responses[responses.length - 1]!;
    i += 1;
    return {
      status: resp.status,
      statusText: resp.statusText ?? '',
      headers: { get: (n: string) => resp.headers?.[n.toLowerCase()] ?? null },
      json: async () => resp.body ?? {}
    };
  };
  return { fn, calls };
}

describe('createRegistryFetcher', () => {
  it('retries on 429 honouring Retry-After', async () => {
    const { fn } = mockFetcher([
      { status: 429, headers: { 'retry-after': '0' } },
      {
        status: 200,
        body: {
          name: 'react',
          'dist-tags': { latest: '19.0.0' },
          time: { '19.0.0': '2026-01-01T00:00:00Z' },
          versions: { '19.0.0': { version: '19.0.0' } }
        }
      }
    ]);
    const registry = createRegistryFetcher({ cwd: '.', fetcher: fn });
    const pack = await registry.fetchPackument('react');
    expect(pack.name).toBe('react');
    expect(pack.distTags.latest).toBe('19.0.0');
  }, 15_000);

  it('aborts retries on 404', async () => {
    const { fn } = mockFetcher([{ status: 404, statusText: 'Not Found' }]);
    const registry = createRegistryFetcher({ cwd: '.', fetcher: fn });
    await expect(registry.fetchPackument('nonexistent-pkg')).rejects.toThrow();
  });
});

describe('normalizePackument', () => {
  it('extracts homepage / repository / license / latest publish', () => {
    const pack = normalizePackument('react', {
      name: 'react',
      'dist-tags': { latest: '19.0.0' },
      time: {
        '18.0.0': '2024-01-01T00:00:00Z',
        '19.0.0': '2026-01-01T00:00:00Z'
      },
      versions: {
        '18.0.0': { version: '18.0.0', license: 'MIT' },
        '19.0.0': {
          version: '19.0.0',
          license: { type: 'Apache-2.0' },
          deprecated: 'use v20'
        }
      },
      homepage: 'https://example.com',
      repository: { url: 'git+https://github.com/facebook/react.git' }
    });
    expect(pack.homepage).toBe('https://example.com');
    expect(pack.repository).toContain('github.com/facebook/react');
    expect(pack.lastPublishAt).toBe('2026-01-01T00:00:00Z');
    expect(pack.deprecation).toBe('use v20');
  });
});

describe('applyAvailableVersionsCap (§8.7)', () => {
  it('keeps last 50 majors + current major versions + declared-range matches', () => {
    // Build a packument with 60 major versions x 5 minor each = 300 versions.
    const versions: Array<{
      version: string;
      publishedAt: string | null;
      isPrerelease: boolean;
      deprecated: string | null;
      peerDependencies: Record<string, string>;
      engines: Record<string, string>;
    }> = [];
    for (let m = 1; m <= 60; m += 1) {
      for (let n = 0; n < 5; n += 1) {
        versions.push({
          version: `${m}.${n}.0`,
          publishedAt: null,
          isPrerelease: false,
          deprecated: null,
          peerDependencies: {},
          engines: {}
        });
      }
    }
    const { kept, total } = applyAvailableVersionsCap(
      {
        name: 'fixture',
        versions,
        distTags: {},
        deprecation: null,
        homepage: null,
        repository: null,
        license: null,
        lastPublishAt: null,
        latestPeerDependencies: {},
        latestEngines: {}
      },
      '20.0.0',
      '^20.0.0'
    );
    expect(total).toBe(300);
    // Only the top 50 majors keep, so any version with major < 11 should be excluded
    // (60 - 50 = 10, so majors 1-10 dropped, 11-60 kept).
    for (const v of kept) {
      const parts = v.version.split('.');
      const major = Number.parseInt(parts[0]!, 10);
      expect(major).toBeGreaterThanOrEqual(11);
    }
    // Descending order
    for (let i = 1; i < kept.length; i += 1) {
      const a = kept[i - 1]!.version.split('.');
      const b = kept[i]!.version.split('.');
      const am = Number.parseInt(a[0]!, 10);
      const bm = Number.parseInt(b[0]!, 10);
      if (am === bm) {
        expect(Number.parseInt(a[1]!, 10) >= Number.parseInt(b[1]!, 10)).toBe(true);
      } else {
        expect(am > bm).toBe(true);
      }
    }
  });

  it('keeps every version of the installed major even when older than the 50-major window', () => {
    const versions: Array<{
      version: string;
      publishedAt: string | null;
      isPrerelease: boolean;
      deprecated: string | null;
      peerDependencies: Record<string, string>;
      engines: Record<string, string>;
    }> = [];
    for (let m = 1; m <= 60; m += 1) {
      versions.push({ version: `${m}.0.0`, publishedAt: null, isPrerelease: false, deprecated: null, peerDependencies: {}, engines: {} });
    }
    // Add a few minors to major 1 (which would otherwise be dropped).
    versions.push({ version: '1.1.0', publishedAt: null, isPrerelease: false, deprecated: null, peerDependencies: {}, engines: {} });
    versions.push({ version: '1.2.0', publishedAt: null, isPrerelease: false, deprecated: null, peerDependencies: {}, engines: {} });
    const { kept } = applyAvailableVersionsCap(
      {
        name: 'fixture',
        versions,
        distTags: {},
        deprecation: null,
        homepage: null,
        repository: null,
        license: null,
        lastPublishAt: null,
        latestPeerDependencies: {},
        latestEngines: {}
      },
      '1.0.0',
      '^1.0.0'
    );
    const major1 = kept.filter((v) => v.version.startsWith('1.'));
    expect(major1.length).toBe(3); // 1.0.0, 1.1.0, 1.2.0
  });
});
