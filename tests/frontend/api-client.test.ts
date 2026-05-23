import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from '@/lib/client/api-client';

function makeFetcher(responses: Array<{ status: number; body?: unknown; contentType?: string }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const response = responses.shift();
    if (!response) throw new Error('Unexpected fetch call: ' + url);
    const headers = new Headers({
      'content-type': response.contentType ?? 'application/json'
    });
    return new Response(response.body === undefined ? null : JSON.stringify(response.body), {
      status: response.status,
      headers
    });
  });
  return { fetcher, calls };
}

describe('ApiClient', () => {
  it('attaches X-Local-Token on mutating requests after fetching CSRF', async () => {
    const { fetcher, calls } = makeFetcher([
      { status: 200, body: { token: 'csrf-abc' } },
      { status: 202, body: { slug: 'demo', jobId: null } }
    ]);
    const client = new ApiClient({ fetcher: fetcher as unknown as typeof fetch });

    const result = await client.addProject({ path: '/tmp/demo' });

    expect(result).toEqual({ slug: 'demo', jobId: null });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('/api/csrf');
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[1]!.url).toBe('/api/projects');
    expect(calls[1]!.init.method).toBe('POST');
    expect((calls[1]!.init.headers as Record<string, string>)['X-Local-Token']).toBe('csrf-abc');
  });

  it('does NOT attach X-Local-Token on GET requests', async () => {
    const { fetcher, calls } = makeFetcher([{ status: 200, body: { projects: [] } }]);
    const client = new ApiClient({ fetcher: fetcher as unknown as typeof fetch, csrfToken: 'preset' });

    await client.listProjects();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/projects');
    expect(calls[0]!.init.method).toBe('GET');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['X-Local-Token']).toBeUndefined();
  });

  it('reuses a pre-seeded CSRF token without fetching /api/csrf', async () => {
    const { fetcher, calls } = makeFetcher([{ status: 200, body: { ok: true } }]);
    const client = new ApiClient({ fetcher: fetcher as unknown as typeof fetch, csrfToken: 'preset' });

    await client.setApiKey({ provider: 'anthropic', apiKey: 'sk-xxx' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/config/api-key');
    expect((calls[0]!.init.headers as Record<string, string>)['X-Local-Token']).toBe('preset');
  });

  it('caches the CSRF token across multiple mutations', async () => {
    const { fetcher, calls } = makeFetcher([
      { status: 200, body: { token: 'csrf-x' } },
      { status: 202, body: { slug: 'a', jobId: null } },
      { status: 200, body: { ok: true } }
    ]);
    const client = new ApiClient({ fetcher: fetcher as unknown as typeof fetch });

    await client.addProject({ path: '/a' });
    await client.setApiKey({ provider: 'anthropic', apiKey: 'k' });

    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toBe('/api/csrf');
    expect((calls[1]!.init.headers as Record<string, string>)['X-Local-Token']).toBe('csrf-x');
    expect((calls[2]!.init.headers as Record<string, string>)['X-Local-Token']).toBe('csrf-x');
  });

  it('unwraps spec §9.5 error envelope into ApiError', async () => {
    const { fetcher } = makeFetcher([
      {
        status: 409,
        body: {
          error: { code: 'DUPLICATE_PROJECT', message: 'Path already registered', retryable: false }
        }
      }
    ]);
    const client = new ApiClient({ fetcher: fetcher as unknown as typeof fetch, csrfToken: 'k' });

    await expect(client.addProject({ path: '/dup' })).rejects.toMatchObject({
      code: 'DUPLICATE_PROJECT',
      status: 409,
      retryable: false
    });
  });

  it('GET fs validate triggers /api/fs/validate with path param', async () => {
    const { fetcher, calls } = makeFetcher([
      { status: 200, body: { ok: true, code: 'OK', message: 'Valid' } }
    ]);
    const client = new ApiClient({
      fetcher: fetcher as unknown as typeof fetch,
      csrfToken: 'k'
    });

    await client.validateFs('C:/Users/d/projects/my-app');

    expect(calls[0]!.url).toBe('/api/fs/validate?path=C%3A%2FUsers%2Fd%2Fprojects%2Fmy-app');
    expect(calls[0]!.init.method).toBe('GET');
  });

  it('SSE URL is built from baseUrl + jobId', () => {
    const client = new ApiClient({ baseUrl: 'http://127.0.0.1:3000', csrfToken: 'k' });
    expect(client.jobEventsUrl('job-1')).toBe('http://127.0.0.1:3000/api/jobs/job-1/events');
  });
});
