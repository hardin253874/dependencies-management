/**
 * Stage 2 — breadcrumb composition for views [A]/[B]/[C] per spec §7.4.
 */
import { describe, expect, it } from 'vitest';
import { buildBreadcrumb, routesEqual } from '@/lib/client/routes';

describe('buildBreadcrumb', () => {
  it('view [A] renders a single non-clickable segment with the dep name', () => {
    const segments = buildBreadcrumb({ kind: 'A', depName: 'react' });
    expect(segments).toEqual([{ label: 'react', route: null }]);
  });

  it('view [B] renders dep > vX.Y.Z with the dep segment clickable', () => {
    const segments = buildBreadcrumb({ kind: 'B', depName: 'react', version: '19.0.0' });
    expect(segments).toEqual([
      { label: 'react', route: { kind: 'A', depName: 'react' } },
      { label: 'v19.0.0', route: null }
    ]);
  });

  it('view [C] renders dep > Usage with the dep segment clickable', () => {
    const segments = buildBreadcrumb({ kind: 'C', depName: 'react' });
    expect(segments).toEqual([
      { label: 'react', route: { kind: 'A', depName: 'react' } },
      { label: 'Usage', route: null }
    ]);
  });
});

describe('routesEqual', () => {
  it('returns true for identical routes', () => {
    expect(routesEqual({ kind: 'A', depName: 'react' }, { kind: 'A', depName: 'react' })).toBe(true);
  });
  it('returns false when dep name differs', () => {
    expect(routesEqual({ kind: 'A', depName: 'react' }, { kind: 'A', depName: 'redux' })).toBe(false);
  });
  it('returns false when kinds differ', () => {
    expect(routesEqual({ kind: 'A', depName: 'r' }, { kind: 'C', depName: 'r' })).toBe(false);
  });
  it('compares version for [B] routes', () => {
    expect(
      routesEqual(
        { kind: 'B', depName: 'r', version: '1' },
        { kind: 'B', depName: 'r', version: '2' }
      )
    ).toBe(false);
  });
});
