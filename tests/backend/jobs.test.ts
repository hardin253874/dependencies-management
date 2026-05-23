import { describe, it, expect, afterEach } from 'vitest';
import { getJobQueue, resetJobQueue } from '@/lib/jobs/queue';
import { createSandbox, disposeAllSandboxes, type Sandbox } from './helpers/sandbox';

let sandbox: Sandbox | undefined;

afterEach(async () => {
  if (sandbox !== undefined) await sandbox.dispose();
  await disposeAllSandboxes();
  resetJobQueue();
});

describe('job queue (spec §10.10)', () => {
  it('enqueues a job, transitions running → done, surfaces resultUrl', async () => {
    sandbox = await createSandbox('jobs-basic');
    const q = getJobQueue();
    const { jobId, alreadyRunning } = await q.enqueue({
      slug: null,
      kind: 'noop',
      resourceKey: 'k1',
      run: async () => ({ resultUrl: '/done' })
    });
    expect(alreadyRunning).toBe(false);
    expect(jobId).toMatch(/^[0-9a-f]+$/);

    // Wait for the job to drain
    await new Promise<void>((resolve) => {
      const stop = q.subscribe(jobId, (rec) => {
        if (rec.state === 'done' || rec.state === 'error') {
          stop();
          resolve();
        }
      });
    });
    const final = q.get(jobId);
    expect(final?.state).toBe('done');
    expect(final?.resultUrl).toBe('/done');
  });

  it('returns existing job for duplicate resourceKey', async () => {
    sandbox = await createSandbox('jobs-dup');
    const q = getJobQueue();
    const slow = q.enqueue({
      slug: null,
      kind: 'slow',
      resourceKey: 'dup-key',
      run: async () => {
        await new Promise<void>((r) => setTimeout(r, 100));
        return { resultUrl: '/' };
      }
    });
    const first = await slow;
    const second = await q.enqueue({
      slug: null,
      kind: 'slow',
      resourceKey: 'dup-key',
      run: async () => ({ resultUrl: '/' })
    });
    expect(second.jobId).toBe(first.jobId);
    expect(second.alreadyRunning).toBe(true);

    // Drain
    await new Promise<void>((resolve) => {
      const stop = q.subscribe(first.jobId, (rec) => {
        if (rec.state === 'done') {
          stop();
          resolve();
        }
      });
    });
  });

  it('cancel transitions a queued/running job to cancelled', async () => {
    sandbox = await createSandbox('jobs-cancel');
    const q = getJobQueue();
    const { jobId } = await q.enqueue({
      slug: null,
      kind: 'long',
      resourceKey: 'long-key',
      run: async (_report, signal) => {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 5_000);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('aborted'));
          });
        });
      }
    });
    expect(q.cancel(jobId)).toBe(true);
    // Wait for it to flush state.
    await new Promise<void>((resolve) => {
      const stop = q.subscribe(jobId, (rec) => {
        if (rec.state === 'cancelled') {
          stop();
          resolve();
        }
      });
    });
    expect(q.get(jobId)?.state).toBe('cancelled');
  });
});
