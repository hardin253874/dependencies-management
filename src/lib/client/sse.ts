/**
 * SSE consumption hook (spec §9.3, §10.10).
 *
 * - One EventSource per jobId.
 * - On open / error / done events, dispatches typed callbacks.
 * - Per UI_DESIGN.md §13.5 implementation notes: handles reconnect-on-disconnect
 *   with exponential backoff so a flapping job stream doesn't hammer the server.
 * - Caller is responsible for re-fetching the GET endpoint on `done`.
 */

import { useEffect, useRef } from 'react';
import type { JobErrorPayload, JobProgress } from '@/lib/api-types';
import { getApiClient } from './api-client';

export interface JobDoneEvent {
  resultUrl?: string | null;
}

export interface JobStreamHandlers {
  onProgress?: (event: JobProgress) => void;
  onDone?: (event: JobDoneEvent) => void;
  onError?: (event: JobErrorPayload) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 5_000;

export function useJobStream(jobId: string | null, handlers: JobStreamHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!jobId) return;
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return;

    let cancelled = false;
    let source: EventSource | null = null;
    let backoff = INITIAL_BACKOFF_MS;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closedByDone = false;

    const connect = () => {
      if (cancelled) return;
      const url = getApiClient().jobEventsUrl(jobId);
      const es = new EventSource(url);
      source = es;

      es.addEventListener('open', () => {
        // Successful connection resets the backoff clock (spec §10.10 retries
        // must surface in-band; this is purely about transport reconnection).
        backoff = INITIAL_BACKOFF_MS;
        handlersRef.current.onOpen?.();
      });

      es.addEventListener('progress', (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data) as JobProgress;
          handlersRef.current.onProgress?.(data);
        } catch {
          // Malformed event — skip.
        }
      });

      es.addEventListener('done', (event) => {
        let payload: JobDoneEvent = {};
        try {
          payload = JSON.parse((event as MessageEvent).data) as JobDoneEvent;
        } catch {
          // Use default payload.
        }
        handlersRef.current.onDone?.(payload);
        closedByDone = true;
        es.close();
        handlersRef.current.onClose?.();
      });

      es.addEventListener('error', (event) => {
        const messageEvent = event as MessageEvent;
        let payload: JobErrorPayload = {
          code: 'STREAM_ERROR',
          message: 'Connection lost',
          retryable: true
        };
        if (messageEvent.data) {
          try {
            payload = JSON.parse(messageEvent.data) as JobErrorPayload;
          } catch {
            // Use default payload.
          }
        }
        handlersRef.current.onError?.(payload);

        // Browser's native EventSource auto-reconnects, which can hammer the
        // server when the stream is genuinely gone (4xx). Close it and back
        // off ourselves.
        es.close();
        if (!cancelled && !closedByDone) {
          reconnectTimer = setTimeout(connect, backoff);
          backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
        }
      });
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      if (source !== null) source.close();
      handlersRef.current.onClose?.();
    };
  }, [jobId]);
}
