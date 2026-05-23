/**
 * Co-upgrade candidate algorithm unit test (spec §11.5, plan Stage 3).
 *
 *  Exercises all three sources:
 *   (a)  peer-dep — package whose `peerDependencies` mentions the target
 *   (b)  common-pairing — baked-in map (react → react-dom / @types/react / react-router)
 *   (c)  peer-range conflict — installed peer range cannot be satisfied by toVersion
 */
import { describe, it, expect } from 'vitest';
import { computeCoUpgradeCandidates, COMMON_PAIRING_MAP } from '@/lib/llm/coUpgrade';

describe('computeCoUpgradeCandidates — common-pairing source', () => {
  it('returns react-dom and @types/react when target is react and they are direct deps', () => {
    const out = computeCoUpgradeCandidates({
      targetName: 'react',
      toVersion: '19.0.0',
      directDeps: [
        { name: 'react', installedVersion: '18.3.1' },
        { name: 'react-dom', installedVersion: '18.3.1' },
        { name: '@types/react', installedVersion: '18.3.3' }
      ]
    });
    const names = out.candidates.map((c) => c.name).sort();
    expect(names).toEqual(['@types/react', 'react-dom']);
    expect(out.sources['react-dom']).toContain('common-pairing');
    expect(out.sources['@types/react']).toContain('common-pairing');
  });

  it('does not include common pairings missing from the project', () => {
    const out = computeCoUpgradeCandidates({
      targetName: 'react',
      toVersion: '19.0.0',
      directDeps: [{ name: 'react', installedVersion: '18.3.1' }]
    });
    expect(out.candidates.map((c) => c.name)).toEqual([]);
  });

  it('exposes COMMON_PAIRING_MAP for inspection / iteration', () => {
    expect(COMMON_PAIRING_MAP.react).toContain('react-dom');
    expect(COMMON_PAIRING_MAP.next).toContain('react');
  });
});

describe('computeCoUpgradeCandidates — peer-dep source', () => {
  it('returns deps whose own peerDependencies declare the target', () => {
    const out = computeCoUpgradeCandidates({
      targetName: 'react',
      toVersion: '19.0.0',
      directDeps: [
        { name: 'react', installedVersion: '18.3.1' },
        {
          name: 'styled-components',
          installedVersion: '6.0.0',
          peerDependencies: { react: '^17.0.0 || ^18.0.0' }
        }
      ]
    });
    const sc = out.candidates.find((c) => c.name === 'styled-components');
    expect(sc).toBeDefined();
    expect(out.sources['styled-components']).toContain('peer-dep');
    // Range is recorded for source (c) checking.
    expect(sc?.declaredPeerDepRange).toBe('^17.0.0 || ^18.0.0');
  });

  it('also handles the "target peer-deps name a direct dep" direction', () => {
    const out = computeCoUpgradeCandidates({
      targetName: 'react',
      toVersion: '19.0.0',
      directDeps: [
        { name: 'react', installedVersion: '18.3.1' },
        { name: 'react-dom', installedVersion: '18.3.1' }
      ],
      targetPeerDependenciesAtTo: {
        'react-dom': '^19.0.0'
      }
    });
    expect(out.sources['react-dom']).toContain('peer-dep');
    const rd = out.candidates.find((c) => c.name === 'react-dom');
    expect(rd?.declaredPeerDepRange).toBe('^19.0.0');
  });
});

describe('computeCoUpgradeCandidates — peer-range-conflict source', () => {
  it('flags a peer-range-conflict when toVersion does not satisfy the declared peer range', () => {
    const out = computeCoUpgradeCandidates({
      targetName: 'react',
      toVersion: '19.0.0',
      directDeps: [
        { name: 'react', installedVersion: '18.3.1' },
        {
          name: 'legacy-thing',
          installedVersion: '1.0.0',
          peerDependencies: { react: '^17.0.0 || ^18.0.0' }
        }
      ]
    });
    // 19.0.0 does NOT satisfy ^17 || ^18 → conflict.
    expect(out.sources['legacy-thing']).toContain('peer-dep');
    expect(out.sources['legacy-thing']).toContain('peer-range-conflict');
  });

  it('does NOT flag a peer-range-conflict when toVersion satisfies the range', () => {
    const out = computeCoUpgradeCandidates({
      targetName: 'react',
      toVersion: '18.4.0',
      directDeps: [
        { name: 'react', installedVersion: '18.3.1' },
        {
          name: 'modern-thing',
          installedVersion: '1.0.0',
          peerDependencies: { react: '^17.0.0 || ^18.0.0' }
        }
      ]
    });
    expect(out.sources['modern-thing']).toContain('peer-dep');
    expect(out.sources['modern-thing']).not.toContain('peer-range-conflict');
  });
});

describe('computeCoUpgradeCandidates — deterministic ordering', () => {
  it('returns candidates sorted by name', () => {
    const out = computeCoUpgradeCandidates({
      targetName: 'react',
      toVersion: '19.0.0',
      directDeps: [
        { name: 'react', installedVersion: '18.3.1' },
        { name: 'react-router', installedVersion: '6.0.0' },
        { name: 'react-dom', installedVersion: '18.3.1' },
        { name: '@types/react', installedVersion: '18.3.3' }
      ]
    });
    const names = out.candidates.map((c) => c.name);
    expect(names).toEqual([...names].sort());
  });
});
