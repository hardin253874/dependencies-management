/**
 * Per-slug concurrency cap (spec §10.8 — 3 jobs per project).
 *
 * Spawns 5 jobs for slug A and 5 for slug B and verifies:
 *   - At any instant, at most 3 jobs run concurrently per slug.
 *   - Total parallelism is at most 6 (3 per slug × 2 slugs).
 *   - All 10 jobs eventually complete.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { getJobQueue, resetJobQueue } from '@/lib/jobs/queue';
import { createSandbox, disposeAllSandboxes, type Sandbox } from './helpers/sandbox';

let sandbox: Sandbox | undefined;

afterEach(async () => {
  if (sandbox !== undefined) await sandbox.dispose();
  await disposeAllSandboxes();
  resetJobQueue();
});

describe('per-slug concurrency cap', () => {
  it('runs at most 3 jobs concurrently per slug, 6 across two slugs', async () => {
    sandbox = await createSandbox('per-slug');
    const q = getJobQueue();
    let activeBySlug = new Map<string, number>();
    let maxBySlug = new Map<string, number>();
    let totalActive = 0;
    let maxTotal = 0;

    function bump(slug: string, delta: number): void {
      const a = (activeBySlug.get(slug) ?? 0) + delta;
      activeBySlug.set(slug, a);
      maxBySlug.set(slug, Math.max(maxBySlug.get(slug) ?? 0, a));
      totalActive += delta;
      maxTotal = Math.max(maxTotal, totalActive);
    }

    const slowJob = (slug: string, label: string) =>
      q.enqueue({
        slug,
        kind: 'test:slow',
        resourceKey: `${slug}:${label}`,
        run: async () => {
          bump(slug, +1);
          await new Promise<void>((r) => setTimeout(r, 80));
          bump(slug, -1);
          return { resultUrl: '/' };
        }
      });

    // Spawn 5 jobs for slug A and 5 for slug B (no awaits between).
    const results = await Promise.all([
      slowJob('aaaa', 'a-1'),
      slowJob('aaaa', 'a-2'),
      slowJob('aaaa', 'a-3'),
      slowJob('aaaa', 'a-4'),
      slowJob('aaaa', 'a-5'),
      slowJob('bbbb', 'b-1'),
      slowJob('bbbb', 'b-2'),
      slowJob('bbbb', 'b-3'),
      slowJob('bbbb', 'b-4'),
      slowJob('bbbb', 'b-5')
    ]);
    expect(results.length).toBe(10);

    // Drain
    await Promise.all(
      results.map(
        ({ jobId }) =>
          new Promise<void>((resolve) => {
            const stop = q.subscribe(jobId, (rec) => {
              if (rec.state === 'done' || rec.state === 'error' || rec.state === 'cancelled') {
                stop();
                resolve();
              }
            });
          })
      )
    );

    expect(maxBySlug.get('aaaa') ?? 0).toBeLessThanOrEqual(3);
    expect(maxBySlug.get('bbbb') ?? 0).toBeLessThanOrEqual(3);
    expect(maxTotal).toBeLessThanOrEqual(6);
    expect(maxBySlug.get('aaaa')).toBe(3); // tight bound — we did hit the cap
    expect(maxBySlug.get('bbbb')).toBe(3);
  });
});
