/**
 * Stage 3 carry-over M1 (Stage 4): consolidated `isValidVersionParam` lives in
 * `src/lib/http/validate.ts`. This test pins its semantics so a future drift in
 * either route handler can't regress the path-traversal defense.
 */
import { describe, it, expect } from 'vitest';
import {
  isValidParam,
  isValidPackageName,
  isValidVersionParam
} from '@/lib/http/validate';

describe('isValidVersionParam', () => {
  it('accepts semver-like version strings', () => {
    expect(isValidVersionParam('1.0.0')).toBe(true);
    expect(isValidVersionParam('19.0.0')).toBe(true);
    expect(isValidVersionParam('1.0.0-rc.1')).toBe(true);
    expect(isValidVersionParam('1.0.0+build.1')).toBe(true);
    expect(isValidVersionParam('14.2.35')).toBe(true);
  });

  it('rejects bare `..` traversal segment', () => {
    expect(isValidVersionParam('..')).toBe(false);
  });

  it('rejects embedded `..` even though the regex would allow `.`', () => {
    expect(isValidVersionParam('1.0..0')).toBe(false);
    expect(isValidVersionParam('1..0.0')).toBe(false);
    expect(isValidVersionParam('..1.0.0')).toBe(false);
    expect(isValidVersionParam('1.0.0..')).toBe(false);
  });

  it('rejects empty / overly-long / non-string', () => {
    expect(isValidVersionParam('')).toBe(false);
    expect(isValidVersionParam('a'.repeat(65))).toBe(false);
    expect(isValidVersionParam(123 as unknown as string)).toBe(false);
    expect(isValidVersionParam(null as unknown as string)).toBe(false);
    expect(isValidVersionParam(undefined as unknown as string)).toBe(false);
  });

  it('rejects path separators + nul + spaces', () => {
    expect(isValidVersionParam('1.0/0')).toBe(false);
    expect(isValidVersionParam('1.0\\0')).toBe(false);
    expect(isValidVersionParam('1.0 0')).toBe(false);
    expect(isValidVersionParam('1.0\x00')).toBe(false);
  });
});

describe('isValidParam — already exercised by traversal invariant test', () => {
  it('rejects `..` and accepts normal slugs', () => {
    expect(isValidParam('..')).toBe(false);
    expect(isValidParam('my-app-7c4e2a')).toBe(true);
  });
});

describe('isValidPackageName — already exercised by package-name test', () => {
  it('accepts scoped + unscoped names', () => {
    expect(isValidPackageName('react')).toBe(true);
    expect(isValidPackageName('@types/react')).toBe(true);
    expect(isValidPackageName('..')).toBe(false);
  });
});
