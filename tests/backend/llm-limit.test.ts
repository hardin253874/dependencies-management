/**
 * Spec §10.8 — max 2 concurrent LLM calls per provider, across route bundles.
 *
 * Next.js dev evaluates a module once per route bundle. The limiter used to be
 * a module-scoped Map, so each route had its own cap. v2 Stage 1.4 moved it to
 * `globalThis.__DEP_AGENT_LLM_LIMITS__`. This test loads the factory module
 * twice (fresh module registry = two "bundles") and checks the cap is shared.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.resetModules();
});

describe('withLlmLimit — shared across module instances (invariant #4)', () => {
  it('two separately loaded factory modules share one cap of 2', async () => {
    vi.resetModules();
    const a = await import('@/lib/llm/factory');
    vi.resetModules();
    const b = await import('@/lib/llm/factory');
    expect(a).not.toBe(b);

    let running = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const task = (): Promise<void> =>
      new Promise<void>((resolve) => {
        running += 1;
        peak = Math.max(peak, running);
        releases.push(() => {
          running -= 1;
          resolve();
        });
      });

    const all = [
      a.withLlmLimit('anthropic', task),
      b.withLlmLimit('anthropic', task),
      a.withLlmLimit('anthropic', task),
      b.withLlmLimit('anthropic', task)
    ];
    // Let the limiter start what it may.
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(running).toBe(2);
    while (releases.length > 0) {
      releases.shift()!();
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    }
    await Promise.all(all);
    expect(peak).toBe(2);
    expect(globalThis.__DEP_AGENT_LLM_LIMITS__?.has('anthropic')).toBe(true);
  });
});
