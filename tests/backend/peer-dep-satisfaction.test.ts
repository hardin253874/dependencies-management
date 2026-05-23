/**
 * Peer-dep satisfaction algorithm unit tests (spec §11.6, Stage 4 plan).
 *
 * Synthetic peer ranges → semver.satisfies — pure function, no I/O.
 */
import { describe, it, expect } from 'vitest';
import { computePeerDepSatisfaction } from '@/lib/llm/peerDepSatisfaction';

describe('computePeerDepSatisfaction', () => {
  it('returns empty when no transitive declares the target', () => {
    const out = computePeerDepSatisfaction({
      targetName: 'react',
      candidateTargetVersion: '19.0.0',
      transitives: [
        { name: 'lodash', version: '4.17.21', peerDependencies: {} },
        { name: 'axios', version: '1.6.0', peerDependencies: { fs: '*' } }
      ]
    });
    expect(out).toEqual([]);
  });

  it('marks satisfied when candidate is inside ^17.0.0 range', () => {
    const out = computePeerDepSatisfaction({
      targetName: 'react',
      candidateTargetVersion: '17.0.2',
      transitives: [
        {
          name: 'react-router',
          version: '6.0.0',
          peerDependencies: { react: '^17.0.0' }
        }
      ]
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.package).toBe('react-router');
    expect(out[0]!.satisfiedByCandidate).toBe(true);
    expect(out[0]!.peerRange).toBe('^17.0.0');
  });

  it('marks unsatisfied when candidate is outside ^17.0.0 range', () => {
    const out = computePeerDepSatisfaction({
      targetName: 'react',
      candidateTargetVersion: '19.0.0',
      transitives: [
        {
          name: 'react-router',
          version: '6.0.0',
          peerDependencies: { react: '^17.0.0' }
        }
      ]
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.satisfiedByCandidate).toBe(false);
  });

  it('handles complex ranges like `>=16 <19`', () => {
    const out = computePeerDepSatisfaction({
      targetName: 'react',
      candidateTargetVersion: '18.3.1',
      transitives: [
        {
          name: 'some-pkg',
          version: '1.0.0',
          peerDependencies: { react: '>=16 <19' }
        }
      ]
    });
    expect(out[0]!.satisfiedByCandidate).toBe(true);
    const out2 = computePeerDepSatisfaction({
      targetName: 'react',
      candidateTargetVersion: '19.0.0',
      transitives: [
        {
          name: 'some-pkg',
          version: '1.0.0',
          peerDependencies: { react: '>=16 <19' }
        }
      ]
    });
    expect(out2[0]!.satisfiedByCandidate).toBe(false);
  });

  it('handles `~17.0.0` tilde range', () => {
    const out = computePeerDepSatisfaction({
      targetName: 'react',
      candidateTargetVersion: '17.0.5',
      transitives: [
        {
          name: 'tilde-pkg',
          version: '1.0.0',
          peerDependencies: { react: '~17.0.0' }
        }
      ]
    });
    expect(out[0]!.satisfiedByCandidate).toBe(true);
    const out2 = computePeerDepSatisfaction({
      targetName: 'react',
      candidateTargetVersion: '17.1.0',
      transitives: [
        {
          name: 'tilde-pkg',
          version: '1.0.0',
          peerDependencies: { react: '~17.0.0' }
        }
      ]
    });
    // ~17.0.0 means >=17.0.0 <17.1.0 → 17.1.0 falls outside
    expect(out2[0]!.satisfiedByCandidate).toBe(false);
  });

  it('returns deterministic ordering (sorted by package, version, range)', () => {
    const out = computePeerDepSatisfaction({
      targetName: 'react',
      candidateTargetVersion: '17.0.0',
      transitives: [
        { name: 'zeta', version: '1.0.0', peerDependencies: { react: '^17.0.0' } },
        { name: 'alpha', version: '1.0.0', peerDependencies: { react: '^17.0.0' } },
        { name: 'beta', version: '2.0.0', peerDependencies: { react: '^17.0.0' } }
      ]
    });
    expect(out.map((p) => p.package)).toEqual(['alpha', 'beta', 'zeta']);
  });

  it('treats malformed peer ranges as unsatisfied', () => {
    const out = computePeerDepSatisfaction({
      targetName: 'react',
      candidateTargetVersion: '17.0.0',
      transitives: [
        {
          name: 'garbage-pkg',
          version: '1.0.0',
          peerDependencies: { react: 'definitely-not-a-semver-range' }
        }
      ]
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.satisfiedByCandidate).toBe(false);
  });

  it('handles missing peerDependencies field gracefully', () => {
    const out = computePeerDepSatisfaction({
      targetName: 'react',
      candidateTargetVersion: '17.0.0',
      transitives: [{ name: 'no-peers', version: '1.0.0' }]
    });
    expect(out).toEqual([]);
  });
});
