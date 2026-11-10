/**
 * E2E invariant — cross-route state is shared across route bundles.
 *
 * Guards bug class #1 in CLAUDE.md ("Module-scoped singleton in Next.js dev"):
 * Next.js dev can evaluate a server module once per route bundle, so state kept
 * in a module-scoped `let` silently splits into one copy per route. The CSRF
 * token lives on `globalThis.__DEP_AGENT_CSRF_TOKEN__`; it is issued by
 * `GET /api/csrf` and checked by `PATCH /api/config`, a different route bundle.
 * If the token store were per-bundle, the valid token below would be rejected
 * with 403. Runs against whichever bundler `npm run dev` uses, so it
 * re-validates the `globalThis` pattern after each bundler change.
 *
 * Limit (measured 2026-11-10, Next 16.4): only webpack dev evaluates a module
 * once per route. Turbopack dev and production builds share one instance, so
 * there a module-scoped regression would pass this spec unnoticed. The static
 * guard `tests/backend/invariant.singletons.test.ts` covers that case in
 * `npm test`. To prove this spec still has teeth, run it once with
 * `next dev --webpack` and a module-scoped token in `src/lib/csrf.ts`: the
 * second test must fail with 403.
 *
 * Must stay side-effect free: API-only (no browser page, no project), never
 * touches `.env` or `library/_config.json`. The PATCH bodies are invalid JSON,
 * so the handler stops in `readJsonBody` before `patchConfig` can write. The
 * only effect is request-log lines in `library/_logs/`.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';

const CONFIG_URL = '/api/config';
// A Buffer, not a string: Playwright JSON-encodes a string body when the
// content-type is JSON, which would turn it into the valid JSON "not json".
const BAD_BODY = Buffer.from('not json', 'utf8');

async function fetchToken(request: APIRequestContext): Promise<string> {
  const res = await request.get('/api/csrf');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { token: string };
  expect(typeof body.token).toBe('string');
  expect(body.token.length).toBeGreaterThan(0);
  return body.token;
}

test.describe('invariant: cross-route singleton (CSRF token on globalThis)', () => {
  test('GET /api/csrf returns the same token on repeated calls', async ({ request }) => {
    const first = await fetchToken(request);
    const second = await fetchToken(request);
    expect(second).toBe(first);
  });

  test('a token from /api/csrf is accepted by PATCH /api/config (different route bundle)', async ({ request }) => {
    const token = await fetchToken(request);
    const res = await request.patch(CONFIG_URL, {
      headers: { 'X-Local-Token': token, 'Content-Type': 'application/json' },
      data: BAD_BODY
    });
    // 400 INVALID_JSON proves the CSRF check passed; 403 would mean the
    // config route sees a different token store than the csrf route.
    expect(res.status()).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_JSON');
  });

  test('negative control: a wrong token is rejected with 403 CSRF_REJECTED', async ({ request }) => {
    const res = await request.patch(CONFIG_URL, {
      headers: { 'X-Local-Token': 'wrong', 'Content-Type': 'application/json' },
      data: BAD_BODY
    });
    expect(res.status()).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('CSRF_REJECTED');
  });

  test('negative control: a missing token is rejected with 403', async ({ request }) => {
    const res = await request.patch(CONFIG_URL, {
      headers: { 'Content-Type': 'application/json' },
      data: BAD_BODY
    });
    expect(res.status()).toBe(403);
  });
});
