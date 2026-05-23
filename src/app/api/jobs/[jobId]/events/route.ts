/**
 * GET /api/jobs/:jobId/events — Server-Sent Events live tail of a job.
 *
 * Spec §9.3 event shape:
 *   event: progress | done | error
 *   data: <JSON>
 *
 * The job state file is the source of truth; SSE simply forwards updates as
 * they happen. On reconnect, the client should re-query GET /api/jobs/:jobId.
 */
import { getJobQueue } from '@/lib/jobs/queue';
import { isValidParam } from '@/lib/http/validate';
import { badRequest, notFound } from '@/lib/http/errors';
import type { JobRecord } from '@/lib/api-types';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: { jobId: string } }): Promise<Response> {
  const jobId = ctx.params.jobId;
  if (!isValidParam(jobId)) {
    return badRequest('INVALID_JOB_ID', 'Job id failed allowlist validation.');
  }
  const queue = getJobQueue();
  const initial = queue.get(jobId);
  if (initial === null) return notFound('JOB_NOT_FOUND', `No job with id ${jobId}.`);

  // Cleanup state is captured by closures in start/cancel so the underlying
  // source's cancel callback (called by the platform when the client
  // disconnects or the response is aborted) can tear everything down. The
  // previous implementation assigned `controller.cancel = fn` which is not a
  // standard API and never fired, leaking heartbeats and subscriptions.
  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();

      const send = (event: string, data: unknown): void => {
        const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(chunk));
      };

      // Send current state immediately so the client doesn't race.
      emit(initial, send);

      const unsubscribe = queue.subscribe(jobId, (record) => {
        emit(record, send);
        if (record.state === 'done' || record.state === 'error' || record.state === 'cancelled') {
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      });

      // Heartbeat every 15s to keep proxies / dev-server connections alive.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keepalive\n\n`));
        } catch {
          clearInterval(heartbeat);
          unsubscribe();
        }
      }, 15_000);

      cleanup = (): void => {
        clearInterval(heartbeat);
        unsubscribe();
      };
    },
    cancel() {
      if (cleanup !== null) {
        cleanup();
        cleanup = null;
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    }
  });
}

function emit(record: JobRecord, send: (event: string, data: unknown) => void): void {
  if (record.progress !== null) send('progress', record.progress);
  send('state', { state: record.state });
  if (record.state === 'done') send('done', { resultUrl: record.resultUrl });
  if (record.state === 'error' && record.error !== null) send('error', record.error);
  if (record.state === 'cancelled') send('error', { code: 'CANCELLED', message: 'Job cancelled.', retryable: false });
}
