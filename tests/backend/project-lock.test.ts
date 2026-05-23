/**
 * Stage 3 carry-over M5 (Stage 4): `withProjectLock` serializes per-slug critical sections.
 *
 * Verifies:
 *   - Two concurrent calls for the same slug run sequentially.
 *   - Two concurrent calls for different slugs run in parallel.
 *   - A throwing fn doesn't poison the next holder.
 *   - Lock map cleans up after the last waiter resolves.
 */
import { describe, it, expect } from 'vitest';
import {
  withProjectLock,
  _activeProjectLockCount
} from '@/lib/storage/projectLock';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('withProjectLock', () => {
  it('serializes calls for the same slug', async () => {
    const order: string[] = [];
    const t1 = withProjectLock('slug-A', async () => {
      order.push('A1-start');
      await wait(20);
      order.push('A1-end');
    });
    const t2 = withProjectLock('slug-A', async () => {
      order.push('A2-start');
      order.push('A2-end');
    });
    await Promise.all([t1, t2]);
    expect(order).toEqual(['A1-start', 'A1-end', 'A2-start', 'A2-end']);
  });

  it('does not serialize calls for different slugs', async () => {
    const order: string[] = [];
    const t1 = withProjectLock('slug-A', async () => {
      order.push('A-start');
      await wait(30);
      order.push('A-end');
    });
    const t2 = withProjectLock('slug-B', async () => {
      order.push('B-start');
      await wait(5);
      order.push('B-end');
    });
    await Promise.all([t1, t2]);
    // B should complete entirely before A ends (B is shorter and runs in parallel).
    expect(order.indexOf('B-end')).toBeLessThan(order.indexOf('A-end'));
  });

  it('lets a thrown error from one holder still allow the next holder to run', async () => {
    const completed: string[] = [];
    const t1 = withProjectLock('slug-X', async () => {
      throw new Error('boom');
    }).catch(() => undefined);
    const t2 = withProjectLock('slug-X', async () => {
      completed.push('after-throw');
    });
    await Promise.all([t1, t2]);
    expect(completed).toEqual(['after-throw']);
  });

  it('removes the lock entry when the last waiter resolves', async () => {
    await withProjectLock('slug-clean', async () => {
      // intentionally trivial
    });
    expect(_activeProjectLockCount()).toBe(0);
  });
});
