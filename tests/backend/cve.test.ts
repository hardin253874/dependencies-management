/**
 * OSV.dev CVE client tests (spec §10.5, §10.9).
 *
 * Covered:
 *   - 429 → retry
 *   - Total failure → currentVersionCves = null (not [])
 *   - Happy path: vulns returned with severity
 *   - Empty result for clean packages
 */
import { describe, it, expect } from 'vitest';
import { queryCves, keyFor, deriveSeverity } from '@/lib/scanners/cve';

function mockBatchOk(idsPerQuery: string[][]): Response {
  return new Response(
    JSON.stringify({ results: idsPerQuery.map((ids) => ({ vulns: ids.map((id) => ({ id })) })) }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

function mockVulnOk(id: string, severity = 'HIGH', summary = 'fixture vuln'): Response {
  return new Response(
    JSON.stringify({ id, summary, database_specific: { severity } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

describe('queryCves (happy path)', () => {
  it('returns empty array when OSV reports no vulns', async () => {
    const fetcher = async (url: string | URL | Request): Promise<Response> => {
      const u = String(url);
      if (u.endsWith('/v1/querybatch')) return mockBatchOk([[], []]);
      return new Response('{}', { status: 200 });
    };
    const map = await queryCves(
      [
        { name: 'react', version: '19.0.0' },
        { name: 'react-dom', version: '19.0.0' }
      ],
      { fetcher: fetcher as unknown as typeof fetch }
    );
    expect(map.get(keyFor('react', '19.0.0'))).toEqual([]);
    expect(map.get(keyFor('react-dom', '19.0.0'))).toEqual([]);
  });

  it('returns CVE records with severity', async () => {
    const fetcher = async (url: string | URL | Request): Promise<Response> => {
      const u = String(url);
      if (u.endsWith('/v1/querybatch')) return mockBatchOk([['GHSA-aaaa-aaaa-aaaa']]);
      if (u.includes('/v1/vulns/')) return mockVulnOk('GHSA-aaaa-aaaa-aaaa', 'HIGH', 'XSS');
      return new Response('{}', { status: 200 });
    };
    const map = await queryCves(
      [{ name: 'react', version: '18.0.0' }],
      { fetcher: fetcher as unknown as typeof fetch }
    );
    const cves = map.get(keyFor('react', '18.0.0'));
    expect(cves).not.toBeNull();
    expect(cves?.length).toBe(1);
    expect(cves?.[0]).toMatchObject({ id: 'GHSA-aaaa-aaaa-aaaa', severity: 'high', summary: 'XSS' });
  });
});

describe('queryCves (failure)', () => {
  it('marks affected pairs as null on persistent 429', async () => {
    const fetcher = async (): Promise<Response> => new Response('rate limited', { status: 429 });
    const map = await queryCves(
      [{ name: 'react', version: '18.0.0' }],
      { fetcher: fetcher as unknown as typeof fetch }
    );
    expect(map.get(keyFor('react', '18.0.0'))).toBeNull();
  }, 20_000);

  it('marks affected pairs as null on 5xx', async () => {
    const fetcher = async (): Promise<Response> => new Response('boom', { status: 503 });
    const map = await queryCves(
      [{ name: 'foo', version: '1.0.0' }],
      { fetcher: fetcher as unknown as typeof fetch }
    );
    expect(map.get(keyFor('foo', '1.0.0'))).toBeNull();
  }, 20_000);
});

describe('deriveSeverity', () => {
  it('reads database_specific.severity verbatim (case-insensitive)', () => {
    expect(deriveSeverity({ id: 'x', database_specific: { severity: 'CRITICAL' } })).toBe('critical');
    expect(deriveSeverity({ id: 'x', database_specific: { severity: 'High' } })).toBe('high');
    expect(deriveSeverity({ id: 'x', database_specific: { severity: 'moderate' } })).toBe('medium');
    expect(deriveSeverity({ id: 'x', database_specific: { severity: 'low' } })).toBe('low');
  });
  it('falls back to unknown when no signal available', () => {
    expect(deriveSeverity({ id: 'x' })).toBe('unknown');
  });
});
