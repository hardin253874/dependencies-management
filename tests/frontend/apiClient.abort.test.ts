/**
 * Stage 1 carry-over — AbortController hygiene through ApiClient.request.
 *
 * Verifies that calling `validateFs(path, { signal })` with an already-aborted
 * signal forwards the signal to fetch so the request errors out with
 * AbortError. This is the contract the Picker relies on to cancel inflight
 * validates on unmount or supersession.
 */
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '@/lib/client/api-client';

describe('ApiClient AbortController plumbing', () => {
  it('forwards a custom AbortSignal to fetch via options.signal', async () => {
    const fakeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      // We don't actually abort here; we just assert the signal was passed.
      expect(init?.signal).toBeDefined();
      return new Response(JSON.stringify({ ok: true, code: 'OK', message: '' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });
    const client = new ApiClient({ fetcher: fakeFetch as unknown as typeof fetch });
    const controller = new AbortController();
    await client.validateFs('/some/path', { signal: controller.signal });
    expect(fakeFetch).toHaveBeenCalledOnce();
    const call = fakeFetch.mock.calls[0]!;
    expect((call[1] as RequestInit).signal).toBe(controller.signal);
  });

  it('an aborted signal causes fetch to throw AbortError before resolving', async () => {
    // Simulate the native fetch behavior: when signal is aborted, fetch
    // rejects with an AbortError.
    const fakeFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          const error = new Error('AbortError');
          error.name = 'AbortError';
          reject(error);
          return;
        }
        signal?.addEventListener('abort', () => {
          const error = new Error('AbortError');
          error.name = 'AbortError';
          reject(error);
        });
      });
    });
    const client = new ApiClient({ fetcher: fakeFetch as unknown as typeof fetch });
    const controller = new AbortController();
    const promise = client.listFs('/x', { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toThrow(/Abort/);
  });
});
