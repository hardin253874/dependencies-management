import { describe, it, expect } from 'vitest';
import { checkCsrf, getCsrfToken, CSRF_HEADER, rotateCsrfToken } from '@/lib/csrf';

describe('invariant: CSRF rejects mutating requests without X-Local-Token (§16.3)', () => {
  it('rejects when header is missing', () => {
    const headers = new Headers();
    const result = checkCsrf(headers);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/missing/i);
  });

  it('rejects when header is wrong', () => {
    getCsrfToken(); // ensure token exists
    const headers = new Headers({ [CSRF_HEADER]: 'not-the-token' });
    const result = checkCsrf(headers);
    expect(result.ok).toBe(false);
  });

  it('accepts when header matches current token', () => {
    const token = getCsrfToken();
    const headers = new Headers({ [CSRF_HEADER]: token });
    expect(checkCsrf(headers).ok).toBe(true);
  });

  it('token rotates on rotateCsrfToken (sim of server restart)', () => {
    const before = getCsrfToken();
    const after = rotateCsrfToken();
    expect(after).not.toBe(before);
    // Old token no longer valid.
    const headers = new Headers({ [CSRF_HEADER]: before });
    expect(checkCsrf(headers).ok).toBe(false);
  });
});
