/**
 * CSRF (spec §9.4 / §9.3).
 *
 * Local-only protection: a per-process random token, returned by GET /api/csrf
 * (the only endpoint exempt from CSRF). All mutating endpoints require the
 * X-Local-Token header to match. Token lifetime = server lifetime; rotates on
 * restart.
 *
 * Storage: stashed on `globalThis` rather than module-scope. In Next.js dev
 * mode, route handlers can be served by separately-evaluated module instances
 * (per-route bundles + HMR). A plain `let token: string | null = null` would
 * give each instance its own copy, so the token returned by GET /api/csrf
 * would not match the one validated on POST /api/projects. The `globalThis`
 * pin keeps a single token across all instances within the same Node process.
 */
import crypto from 'crypto';

declare global {
  // eslint-disable-next-line no-var
  var __DEP_AGENT_CSRF_TOKEN__: string | undefined;
}

export function getCsrfToken(): string {
  if (globalThis.__DEP_AGENT_CSRF_TOKEN__ === undefined) {
    globalThis.__DEP_AGENT_CSRF_TOKEN__ = crypto.randomBytes(32).toString('hex');
  }
  return globalThis.__DEP_AGENT_CSRF_TOKEN__;
}

/** Test hook — force a new token (used to assert rotation on restart). */
export function rotateCsrfToken(): string {
  globalThis.__DEP_AGENT_CSRF_TOKEN__ = crypto.randomBytes(32).toString('hex');
  return globalThis.__DEP_AGENT_CSRF_TOKEN__;
}

export const CSRF_HEADER = 'x-local-token';

/**
 * Validate the CSRF header on a Request. Mutating routes call this first;
 * non-mutating GET routes skip it.
 */
export function checkCsrf(headers: Headers): { ok: boolean; reason?: string } {
  const sent = headers.get(CSRF_HEADER);
  if (sent === null || sent === '') {
    return { ok: false, reason: 'Missing X-Local-Token header.' };
  }
  const expected = getCsrfToken();
  if (sent.length !== expected.length) {
    return { ok: false, reason: 'Invalid CSRF token.' };
  }
  const a = Buffer.from(sent);
  const b = Buffer.from(expected);
  if (!crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'Invalid CSRF token.' };
  }
  return { ok: true };
}
