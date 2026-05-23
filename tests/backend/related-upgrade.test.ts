/**
 * Unit tests for the deterministic phase of the related-deps upgrade
 * analysis (view [B] new section). The LLM phase is covered indirectly
 * via the existing MOCK_LLM infrastructure used by other report tests;
 * here we lock in the offline semver-satisfies logic that ALWAYS runs
 * regardless of LLM state.
 */
import { describe, it, expect } from 'vitest';
import { computeDeterministicVerdict, buildSkeleton } from '@/lib/llm/relatedUpgradeService';
import type { RelatedDep } from '@/lib/api-types';

function rel(name: string, installedVersion: string | null, reasons: RelatedDep['reasons']): RelatedDep {
  return {
    name,
    installedVersion,
    reasons,
    health: {
      deprecated: null,
      cveCount: null,
      maxCveSeverity: null,
      eol: null,
      ageDays: null
    }
  };
}

describe('computeDeterministicVerdict', () => {
  it('returns compatible when every ranged reason satisfies the target', () => {
    const r = rel('react', '18.2.0', [
      { kind: 'inbound-engine', range: '>=10.0.0', satisfied: null }
    ]);
    const { verdict } = computeDeterministicVerdict(r, '24.13.0');
    expect(verdict).toBe('compatible');
  });

  it('returns breaks when at least one range fails to satisfy', () => {
    const r = rel('legacy-tool', '1.0.0', [
      { kind: 'inbound-engine', range: '>=10 <20', satisfied: null }
    ]);
    const { verdict } = computeDeterministicVerdict(r, '24.13.0');
    expect(verdict).toBe('breaks');
  });

  it('returns unknown when no reason carries a range (e.g. naming-only)', () => {
    const r = rel('@types/node', '17.0.33', [
      { kind: 'naming', range: null, satisfied: null }
    ]);
    const { verdict } = computeDeterministicVerdict(r, '24.13.0');
    expect(verdict).toBe('unknown');
  });

  it('treats malformed ranges as null (no signal), but still detects valid breaks alongside them', () => {
    const r = rel('mixed', '1.0.0', [
      { kind: 'inbound-engine', range: 'not-a-range', satisfied: null },
      { kind: 'inbound-engine', range: '>=10 <20', satisfied: null }
    ]);
    const { verdict, perReason } = computeDeterministicVerdict(r, '24.0.0');
    expect(verdict).toBe('breaks');
    expect(perReason[0]).toBeNull();
    expect(perReason[1]).toBe(false);
  });

  it('returns unknown when ALL ranges are malformed', () => {
    const r = rel('bad', '1.0.0', [
      { kind: 'inbound-engine', range: 'banana', satisfied: null }
    ]);
    const { verdict } = computeDeterministicVerdict(r, '24.0.0');
    expect(verdict).toBe('unknown');
  });
});

describe('buildSkeleton', () => {
  it('produces one skeleton row per related dep, in order', () => {
    const { skeleton, promptDeps } = buildSkeleton({
      viewedDep: 'node',
      fromVersion: '18.16.0',
      toVersion: '24.13.0',
      relatedDeps: [
        rel('react', '18.2.0', [
          { kind: 'inbound-engine', range: '>=10.0.0', satisfied: null }
        ]),
        rel('@types/node', '17.0.33', [{ kind: 'naming', range: null, satisfied: null }])
      ],
      relatedDetails: {}
    });
    expect(skeleton).toHaveLength(2);
    expect(promptDeps).toHaveLength(2);
    expect(skeleton[0]!.name).toBe('react');
    expect(skeleton[1]!.name).toBe('@types/node');
  });

  it('defaults action=keep on compatible verdict, action=investigate otherwise', () => {
    const { skeleton } = buildSkeleton({
      viewedDep: 'node',
      fromVersion: '18.16.0',
      toVersion: '24.13.0',
      relatedDeps: [
        rel('compat', '1.0.0', [
          { kind: 'inbound-engine', range: '>=10.0.0', satisfied: null }
        ]),
        rel('breaks', '1.0.0', [
          { kind: 'inbound-engine', range: '>=10 <20', satisfied: null }
        ]),
        rel('unknown', '1.0.0', [{ kind: 'naming', range: null, satisfied: null }])
      ],
      relatedDetails: {}
    });
    expect(skeleton[0]!.action).toBe('keep');
    expect(skeleton[0]!.deterministicVerdict).toBe('compatible');
    expect(skeleton[1]!.action).toBe('investigate');
    expect(skeleton[1]!.deterministicVerdict).toBe('breaks');
    expect(skeleton[2]!.action).toBe('investigate');
    expect(skeleton[2]!.deterministicVerdict).toBe('unknown');
  });

  it('surfaces latest version + engines from related detail when available', () => {
    const { promptDeps } = buildSkeleton({
      viewedDep: 'node',
      fromVersion: '18.16.0',
      toVersion: '24.13.0',
      relatedDeps: [
        rel('react', '18.2.0', [
          { kind: 'inbound-engine', range: '>=10.0.0', satisfied: null }
        ])
      ],
      relatedDetails: {
        react: {
          name: 'react',
          availableVersions: [
            { version: '19.0.0', publishedAt: '2026-01-01T00:00:00Z', isPrerelease: false }
          ],
          support: { homepage: null, repository: null, lastPublishAt: null },
          license: 'MIT',
          deprecation: null,
          currentVersionCves: [],
          latestPeerDeps: {},
          latestEngines: { node: '>=18.17' },
          relatedDeps: []
        }
      }
    });
    expect(promptDeps[0]!.latestAvailableVersion).toBe('19.0.0');
    expect(promptDeps[0]!.latestEngines).toEqual({ node: '>=18.17' });
  });
});
