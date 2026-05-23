/**
 * Stage 3 route-handler smoke tests.
 *
 * Verifies the three new endpoints can be imported, return the documented
 * status codes for the obvious error paths, and reject CSRF-less mutating
 * requests.
 *
 *   - POST /api/projects/:slug/reports/:name/:from/:to/refresh
 *   - GET  /api/projects/:slug/file-reviews/:name/:pathHash
 *   - POST /api/projects/:slug/file-reviews/:name/:pathHash/refresh
 *
 * The full happy-path integration (mocked LLM, persisted envelope, stale flag)
 * is covered in `report-flow.test.ts` and `file-review-flow.test.ts`.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createSandbox, disposeAllSandboxes, type Sandbox } from './helpers/sandbox';
import { CSRF_HEADER, getCsrfToken } from '@/lib/csrf';

import { POST as refreshReport } from '@/app/api/projects/[slug]/reports/[name]/[from]/[to]/refresh/route';
import { GET as getFileReview } from '@/app/api/projects/[slug]/file-reviews/[name]/[pathHash]/route';
import { POST as refreshFileReview } from '@/app/api/projects/[slug]/file-reviews/[name]/[pathHash]/refresh/route';

let sandbox: Sandbox | undefined;
beforeEach(() => {
  process.env.MOCK_LLM = 'true';
});
afterEach(async () => {
  delete process.env.MOCK_LLM;
  if (sandbox !== undefined) await sandbox.dispose();
  await disposeAllSandboxes();
});

function newReq(method: string, withCsrf = true): Request {
  const headers: Record<string, string> = {};
  if (withCsrf) headers[CSRF_HEADER] = getCsrfToken();
  return new Request('http://127.0.0.1/test', { method, headers });
}

describe('POST /api/projects/.../reports/.../refresh — CSRF + validation', () => {
  it('rejects requests without X-Local-Token (CSRF invariant)', async () => {
    sandbox = await createSandbox('refresh-report-csrf');
    const r = await refreshReport(newReq('POST', false), {
      params: { slug: 'whatever', name: 'react', from: '18.0.0', to: '19.0.0' }
    });
    expect(r.status).toBe(403);
  });

  it('rejects an invalid slug', async () => {
    sandbox = await createSandbox('refresh-report-bad-slug');
    const r = await refreshReport(newReq('POST'), {
      params: { slug: '../etc', name: 'react', from: '18.0.0', to: '19.0.0' }
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_SLUG');
  });

  it('rejects an invalid version param', async () => {
    sandbox = await createSandbox('refresh-report-bad-ver');
    const r = await refreshReport(newReq('POST'), {
      params: { slug: 'goodslug', name: 'react', from: '..', to: '19.0.0' }
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_VERSION');
  });

  it('returns 404 when the slug is unknown', async () => {
    sandbox = await createSandbox('refresh-report-unknown');
    const r = await refreshReport(newReq('POST'), {
      params: { slug: 'doesnotexist', name: 'react', from: '18.0.0', to: '19.0.0' }
    });
    expect(r.status).toBe(404);
  });
});

describe('GET /api/projects/.../file-reviews/...', () => {
  it('returns 400 on invalid slug', async () => {
    sandbox = await createSandbox('file-rev-bad-slug');
    const r = await getFileReview(new Request('http://127.0.0.1/test'), {
      params: { slug: '..', name: 'react', pathHash: 'abc123' }
    });
    expect(r.status).toBe(400);
  });

  it('returns 400 on invalid pathHash', async () => {
    sandbox = await createSandbox('file-rev-bad-hash');
    const r = await getFileReview(new Request('http://127.0.0.1/test'), {
      params: { slug: 'goodslug', name: 'react', pathHash: '..' }
    });
    expect(r.status).toBe(400);
  });

  it('returns 400 on invalid package name', async () => {
    sandbox = await createSandbox('file-rev-bad-name');
    const r = await getFileReview(new Request('http://127.0.0.1/test'), {
      params: { slug: 'goodslug', name: '..', pathHash: 'abc123' }
    });
    expect(r.status).toBe(400);
  });

  it('returns 404 when the project does not exist', async () => {
    sandbox = await createSandbox('file-rev-no-proj');
    const r = await getFileReview(new Request('http://127.0.0.1/test'), {
      params: { slug: 'goodslug', name: 'react', pathHash: 'abc123' }
    });
    expect(r.status).toBe(404);
  });
});

describe('POST /api/projects/.../file-reviews/.../refresh — CSRF', () => {
  it('rejects requests without X-Local-Token', async () => {
    sandbox = await createSandbox('file-rev-refresh-csrf');
    const r = await refreshFileReview(newReq('POST', false), {
      params: { slug: 'whatever', name: 'react', pathHash: 'abc123' }
    });
    expect(r.status).toBe(403);
  });

  it('rejects invalid slug', async () => {
    sandbox = await createSandbox('file-rev-refresh-bad-slug');
    const r = await refreshFileReview(newReq('POST'), {
      params: { slug: '..', name: 'react', pathHash: 'abc123' }
    });
    expect(r.status).toBe(400);
  });

  it('returns 404 when the project does not exist', async () => {
    sandbox = await createSandbox('file-rev-refresh-no-proj');
    const r = await refreshFileReview(newReq('POST'), {
      params: { slug: 'goodslug', name: 'react', pathHash: 'abc123' }
    });
    expect(r.status).toBe(404);
  });
});
