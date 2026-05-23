/**
 * Scoped-package URL handling (spec §9.2).
 *
 * Endpoints receive `@types%2Freact` and must:
 *   1. URL-decode → `@types/react`
 *   2. Validate against the allowlist regex
 *   3. Reject `..` segments BEFORE any filesystem operation
 */
import { describe, it, expect } from 'vitest';
import { decodeAndValidatePackageName } from '@/lib/http/packageName';

describe('decodeAndValidatePackageName', () => {
  it('decodes and validates bare names', () => {
    expect(decodeAndValidatePackageName('react')).toBe('react');
    expect(decodeAndValidatePackageName('lodash')).toBe('lodash');
  });
  it('decodes scoped names from %2F', () => {
    expect(decodeAndValidatePackageName('@types%2Freact')).toBe('@types/react');
    expect(decodeAndValidatePackageName('@testing-library%2Freact')).toBe('@testing-library/react');
  });
  it('rejects ".." in the decoded form', () => {
    expect(decodeAndValidatePackageName('..')).toBeNull();
    expect(decodeAndValidatePackageName('@scope%2F..')).toBeNull();
    expect(decodeAndValidatePackageName('..%2Fevil')).toBeNull();
  });
  it('rejects empty string and forbidden chars', () => {
    expect(decodeAndValidatePackageName('')).toBeNull();
    expect(decodeAndValidatePackageName('react;rm -rf /')).toBeNull();
    expect(decodeAndValidatePackageName('react<script>')).toBeNull();
  });
  it('rejects names that fail the allowlist regex', () => {
    expect(decodeAndValidatePackageName('Foo')).toBeNull(); // uppercase
    expect(decodeAndValidatePackageName('@SCOPE/pkg')).toBeNull(); // uppercase
  });
  it('handles bad encodings gracefully', () => {
    expect(decodeAndValidatePackageName('%E0%A4%A')).toBeNull(); // truncated encoding
  });
});
