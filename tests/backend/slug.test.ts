import { describe, it, expect } from 'vitest';
import { baseSlug, resolveSlug } from '@/lib/storage/slug';

describe('slug computation', () => {
  it('produces an 8-char hex slug', () => {
    const slug = baseSlug('/Users/d/projects/my-app');
    expect(slug).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is deterministic for the same input', () => {
    const a = baseSlug('/foo/bar');
    const b = baseSlug('/foo/bar');
    expect(a).toBe(b);
  });

  it('appends -2 when the base slug is taken', () => {
    const path = '/x/y';
    const base = baseSlug(path);
    expect(resolveSlug(path, [base])).toBe(`${base}-2`);
  });

  it('appends -3 when -2 is also taken', () => {
    const path = '/x/y';
    const base = baseSlug(path);
    expect(resolveSlug(path, [base, `${base}-2`])).toBe(`${base}-3`);
  });

  it('returns the base when no collision', () => {
    const path = '/x/y';
    const base = baseSlug(path);
    expect(resolveSlug(path, ['unrelated'])).toBe(base);
  });
});
