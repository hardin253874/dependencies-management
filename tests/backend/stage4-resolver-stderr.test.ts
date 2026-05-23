/**
 * Stage 3 carry-over M3 (Stage 4): expanded npm 10+ ERESOLVE stderr patterns.
 *
 * Asserts each of the five patterns documented in `extractFromStderr` is
 * captured. Coverage matters because the resolver retry path keys off
 * conflict count + ERESOLVE detection; this test pins the parser contract.
 */
import { describe, it, expect } from 'vitest';
import { parseEresolve } from '@/lib/scanners/resolver';

describe('parseEresolve — npm 10+ stderr patterns (Stage 3 M3)', () => {
  it('captures the classic `peer X@"..." from Y@v` form', () => {
    const stderr = `
npm ERR! code ERESOLVE
npm ERR! peer react@"^17.0.0" from react-router@6.0.0
npm ERR!   Conflicting peer dependency: react@18.3.1
`;
    const conflicts = parseEresolve('', stderr);
    expect(conflicts.length).toBeGreaterThan(0);
    const peerFrom = conflicts.find((c) => /react-router/.test(c.package));
    expect(peerFrom).toBeDefined();
  });

  it('captures `ERESOLVE overriding peer dependency` warnings (npm 10+)', () => {
    const stderr = `
npm WARN ERESOLVE overriding peer dependency
npm WARN While resolving: my-app@1.0.0
npm WARN Found: react@18.3.1
`;
    const conflicts = parseEresolve('', stderr);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts.some((c) => /overriding peer/.test(c.reason))).toBe(true);
  });

  it('captures `Could not resolve dependency:` preamble', () => {
    const stderr = `
npm ERR! code ERESOLVE
npm ERR! ERESOLVE could not resolve
npm ERR!
npm ERR! While resolving: my-app@1.0.0
npm ERR! Could not resolve dependency: react@19.0.0
`;
    const conflicts = parseEresolve('', stderr);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(
      conflicts.some((c) => /could not resolve|react/.test(c.reason.toLowerCase()))
    ).toBe(true);
  });

  it('captures `Conflicting peer dependency:` summary line', () => {
    const stderr = `
npm ERR! Conflicting peer dependency: react@18.3.1
npm ERR!   from react-router@6.0.0
`;
    const conflicts = parseEresolve('', stderr);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts.some((c) => /conflicting peer/.test(c.reason))).toBe(true);
  });

  it('dedupes when multiple patterns reference the same package', () => {
    const stderr = `
npm WARN ERESOLVE overriding peer dependency
npm ERR! peer react@"^17.0.0" from react-router@6.0.0
npm ERR! peer react@"^17.0.0" from react-router@6.0.0
`;
    const conflicts = parseEresolve('', stderr);
    // No duplicate `(package, reason)` pairs.
    const seen = new Set<string>();
    for (const c of conflicts) {
      const k = `${c.package}|${c.reason}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });
});
