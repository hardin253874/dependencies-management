'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api-client';

export type FetchStatus = 'idle' | 'loading' | 'cached' | 'missing' | 'error';

export interface DetailFetchState<T> {
  status: FetchStatus;
  data: T | null;
  error: string | null;
  /** True when a regeneration POST is in flight; the cached `data` keeps showing. */
  regenerating: boolean;
}

export interface UseDetailFetchOptions<T> {
  /**
   * Fetcher invoked when dependencies change. Receives an AbortSignal for
   * cancellation when the component unmounts or deps change.
   */
  fetcher: (signal: AbortSignal) => Promise<T>;
  /** Re-trigger fetch when any key changes. */
  deps: ReadonlyArray<unknown>;
  /** Skip fetch entirely when this is true. */
  skip?: boolean;
}

/**
 * Cache-first GET hook for the per-view reads (spec §3.2 + §9). Returns
 * `missing` when the API returns 404 NOT_CACHED so the caller can render the
 * `EmptyStateCTA`. Never auto-fires a POST on mount.
 *
 * Stage 2 carry-over: every fetch uses AbortController so unmount/re-fetch
 * cancels any in-flight request (no setState on unmounted components).
 */
export function useDetailFetch<T>({
  fetcher,
  deps,
  skip = false
}: UseDetailFetchOptions<T>): DetailFetchState<T> & {
  reload: () => void;
  setRegenerating: (busy: boolean) => void;
} {
  const [status, setStatus] = useState<FetchStatus>('idle');
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [reloadCounter, setReloadCounter] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (skip) {
      setStatus('idle');
      setData(null);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setStatus('loading');
    setError(null);
    void (async () => {
      try {
        const result = await fetcherRef.current(controller.signal);
        if (controller.signal.aborted) return;
        setData(result);
        setStatus('cached');
      } catch (err) {
        if (controller.signal.aborted || (err as Error).name === 'AbortError') return;
        if (err instanceof ApiError && err.code === 'NOT_CACHED') {
          setData(null);
          setStatus('missing');
        } else {
          setData(null);
          setStatus('error');
          setError(err instanceof Error ? err.message : 'Failed to load');
        }
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skip, reloadCounter, ...deps]);

  const reload = useCallback(() => setReloadCounter((n) => n + 1), []);

  return { status, data, error, regenerating, reload, setRegenerating };
}
