/**
 * 5b.4 judge cache (hit/miss, key sensitivity, errors not cached, in-flight
 * dedupe) and 5b.5 Jev ledger (HARD $0.50, reserve before / settle after,
 * unpriced refused, cap not raisable, lock, crash survival). Sandbox paths only.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { noul } from '@typesafe-ai/sdk';
import { JudgeCache, judgeCacheKey, JUDGE_PROMPT_VERSION } from '@/core/judge/cache';
import { Judge } from '@/core/judge/judge';
import { MockJudgeClient } from '@/core/judge/mock';
import { metadataPayload } from '@/core/judge/payload';
import { JEV_CAP_USD, JEV_PRICES, JevLedger, JevLedgerLockError, JevSpendCapError, estimateJevUsd, jevLedgerPathApp, jevLedgerPathEval, perOperationGate } from '@/core/judge/ledger';
import { TypeSafeJudgeClient } from '@/core/judge/client';
import { JudgeUnavailableError, normalizeJudgeSwitches } from '@/core/judge/types';

const ON = normalizeJudgeSwitches({ enabled: true, router: true, flags: { J5: true } });
const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'judge-cl-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

const req = () => ({ use: 'J5' as const, payload: metadataPayload({ target: 'react', n: 1 }), questions: { x: noul('q?') }, subject: { privacy: 'public' as const } });

describe('5b.4 judge cache', () => {
  it('miss then hit: second ask is cached and sends nothing', async () => {
    const mock = new MockJudgeClient();
    const judge = new Judge({ client: mock, cache: new JudgeCache(await tmp()), switches: ON });
    const a = await judge.ask(req());
    const b = await judge.ask(req());
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(b.answers).toEqual(a.answers);
    expect(mock.requests).toHaveLength(1);
  });

  it('key changes with model, prompt version and any state byte', () => {
    const base = { use: 'J5' as const, model: 'jev-1.14.0', state: { a: 1 }, questions: { x: noul('q?') } };
    const k = judgeCacheKey(base);
    expect(judgeCacheKey({ ...base, state: { a: 1 } })).toBe(k);
    expect(judgeCacheKey({ ...base, model: 'jev-1.13.0' })).not.toBe(k);
    expect(judgeCacheKey({ ...base, promptVersion: `${JUDGE_PROMPT_VERSION}x` })).not.toBe(k);
    expect(judgeCacheKey({ ...base, state: { a: 2 } })).not.toBe(k);
    expect(judgeCacheKey({ ...base, use: 'J6' })).not.toBe(k);
  });

  it('errors are not cached', async () => {
    const mock = new MockJudgeClient();
    const dir = await tmp();
    const judge = new Judge({ client: mock, cache: new JudgeCache(dir), switches: ON });
    mock.failure = '529';
    await expect(judge.ask(req())).rejects.toBeInstanceOf(JudgeUnavailableError);
    expect(await fs.readdir(dir).catch(() => [])).toHaveLength(0);
    mock.failure = null;
    expect((await judge.ask(req())).cached).toBe(false);
    expect(mock.requests).toHaveLength(2);
  });

  it('concurrent same-key calls → one request (in-flight dedupe on the cache instance)', async () => {
    const mock = new MockJudgeClient();
    const judge = new Judge({ client: mock, cache: new JudgeCache(await tmp()), switches: ON });
    const [a, b] = await Promise.all([judge.ask(req()), judge.ask(req())]);
    expect(mock.requests).toHaveLength(1);
    expect([a.cached, b.cached].sort()).toEqual([false, true]);
  });

  it('a refused request never reaches the cache or the client', async () => {
    const mock = new MockJudgeClient();
    const dir = await tmp();
    const judge = new Judge({ client: mock, cache: new JudgeCache(dir), switches: normalizeJudgeSwitches({ enabled: true }) });
    const res = await judge.tryAsk(req());
    expect(res.ok).toBe(false);
    expect(mock.requests).toHaveLength(0);
  });
});

describe('5b.5 Jev ledger', () => {
  it('constants: cap $0.50, priced models only, paths outside the repo', () => {
    expect(JEV_CAP_USD).toBe(0.5);
    expect(Object.keys(JEV_PRICES).sort()).toEqual(['jev-1.13.0', 'jev-1.14.0']);
    expect(jevLedgerPathEval('C:\\LAD')).toBe(path.join('C:\\LAD', 'dep-agent-eval', '_spend', 'jev-round1.json'));
    expect(jevLedgerPathApp('/lib')).toBe(path.join('/lib', '_spend', 'jev-round1.json'));
    expect(() => estimateJevUsd('jev-latest', 10)).toThrow(JevSpendCapError);
  });

  it('refuses when the estimate would cross $0.50; the fake fetch saw 0 calls', async () => {
    const file = path.join(await tmp(), 'jev-round1.json');
    const calls: string[] = [];
    // 0.5 / (0.042e-6 × 1.1) ≈ 10.8M bytes; a 12 MB state crosses the cap.
    const client = new TypeSafeJudgeClient({
      apiKey: 'k',
      gate: perOperationGate(file, 'test'),
      fetch: async (u) => {
        calls.push(u);
        return new Response('{}');
      }
    });
    const err = (await client.ask({ use: 'J1', state: { big: 'x'.repeat(12_000_000) }, questions: { q: noul('q?') } }).catch((e: unknown) => e)) as JudgeUnavailableError;
    expect(err).toBeInstanceOf(JudgeUnavailableError);
    expect(err.reason).toBe('ledger');
    expect(calls).toHaveLength(0);
    const l = await JevLedger.open(file);
    expect(l.entries()).toHaveLength(0);
    await l.close();
  });

  it('settles from usage; spent replaces reserved', async () => {
    const file = path.join(await tmp(), 'l.json');
    const l = await JevLedger.open(file);
    const id = await l.reserve({ step: 's', use: 'J5', model: 'jev-1.14.0', boundTokens: 1_000 });
    expect(l.state().reservedUsd).toBeGreaterThan(0);
    await l.settle(id, { model: 'jev-1.14.0', inputTokens: 500 });
    expect(l.state()).toMatchObject({ reservedUsd: 0, spentUsd: Math.round(500 * 0.042e-6 * 1e9) / 1e9 });
    await l.close();
  });

  it('an unsettled (usage-less / crashed) reservation stays counted across reopen', async () => {
    const file = path.join(await tmp(), 'l.json');
    const l = await JevLedger.open(file);
    await l.reserve({ step: 's', use: 'J5', model: 'jev-1.14.0', boundTokens: 1_000 });
    const reserved = l.state().reservedUsd;
    // Simulate a crash: the lock file is left with a dead pid.
    await fs.writeFile(`${file}.lock`, '999999999');
    const again = await JevLedger.open(file);
    expect(again.state().reservedUsd).toBe(reserved);
    await again.close();
  });

  it('the cap is not raisable by env or by the file; a ceiling only lowers it', async () => {
    vi.stubEnv('JEV_CAP_USD', '100');
    const file = path.join(await tmp(), 'l.json');
    await fs.writeFile(file, JSON.stringify({ roundId: 'jev-round1', capUsd: 100, entries: [], spentUsd: 0, reservedUsd: 0 }));
    const l = await JevLedger.open(file);
    expect(l.state().capUsd).toBe(0.5);
    await expect(l.reserve({ step: 's', use: 'J5', model: 'jev-1.14.0', boundTokens: 100, ceilingUsd: 5 })).resolves.toBeTypeOf('string');
    await expect(l.reserve({ step: 's', use: 'J5', model: 'jev-1.14.0', boundTokens: 100, ceilingUsd: 0.000001 })).rejects.toBeInstanceOf(JevSpendCapError);
    await l.close();
    expect(JSON.parse(await fs.readFile(file, 'utf8')).capUsd).toBe(0.5);
  });

  it('a second live process is refused (lock held by a live pid)', async () => {
    const file = path.join(await tmp(), 'l.json');
    await fs.writeFile(`${file}.lock`, String(process.ppid > 0 ? process.ppid : process.pid));
    await expect(JevLedger.open(file)).rejects.toBeInstanceOf(JevLedgerLockError);
  });
});
