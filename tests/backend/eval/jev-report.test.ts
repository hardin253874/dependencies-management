/**
 * Stage 5c review r1 (M1, m1): the Jev steps' result files carry the Jev
 * ledger state (spend block) and real per-phase request counts, and never an
 * absolute path under the user profile. Sandbox ledger + fake clients only:
 * no request leaves the process.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { JevLedger } from '@/core/judge/ledger';
import type { JudgeAskInput, JudgeClient } from '@/core/judge/client';
import { MockJudgeClient } from '@/core/judge/mock';
import { JudgeCache } from '@/core/judge/cache';
import { Judge } from '@/core/judge/judge';
import { normalizeJudgeSwitches } from '@/core/judge/types';
import { jevSpendSession, publicCachePath } from '../../../eval/lib/jev-report';
import { judgeEvalCacheDir, runJudgeEval } from '../../../eval/lib/judge';
import { askRouterJev, computeRouterArms, jevCacheLookup } from '../../../eval/lib/router-arms';
import type { LoadedCase, ResultFile } from '../../../eval/lib/types';

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-report-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

const FIX = path.join(process.cwd(), 'test-fixtures', 'eval', 'router');
async function load<T>(name: string): Promise<T> {
  return JSON.parse(await fs.readFile(path.join(FIX, name), 'utf8')) as T;
}

/**
 * Stands in for `TypeSafeJudgeClient`: reserve through the gate, "send", settle
 * from usage. Answers come from an inner mock, but the client itself is not a
 * `MockJudgeClient` (the pre-fix counter only saw those).
 */
function gatedFakeClient(gate: { reserve: JevGateReserve; settle: JevGateSettle }, answers: Record<string, unknown>): JudgeClient & { sent: number } {
  const inner = new MockJudgeClient({ responder: () => answers as never });
  const c = {
    kind: 'typesafe' as const,
    sent: 0,
    async ask(input: JudgeAskInput) {
      const id = await gate.reserve({ use: input.use, model: 'jev-1.14.0', boundTokens: 1_000 });
      c.sent += 1;
      const out = await inner.ask(input);
      await gate.settle(id, { model: 'jev-1.14.0', inputTokens: 400 });
      return { ...out, usage: { inputTokens: 400 } };
    }
  };
  return c;
}
type JevGateReserve = (r: { use: string; model: string; boundTokens: number }) => Promise<string>;
type JevGateSettle = (id: string, s: { model: string; inputTokens: number }) => Promise<void>;

function j5Deps(client: JudgeClient, cache: JudgeCache | null) {
  return {
    prepare: async () => 'C:/clone',
    truth: async () => [{ phaseId: 'p1', kept: [], dependencyDiff: [{ projectDir: '.', changes: [{ field: 'dependencies' as const, name: 'react-dom', from: '17.0.2', to: '18.2.0' }] }] }],
    predicted: async () => new Map<string, string[]>(),
    snippet: async () => null,
    directDeps: async () => [
      { name: 'react-dom', version: '17.0.2' },
      { name: 'lodash', version: '4.17.21' }
    ],
    client,
    cache,
    log: () => undefined
  };
}

function allStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) allStrings(x, out);
  else if (v !== null && typeof v === 'object') for (const x of Object.values(v)) allStrings(x, out);
  return out;
}

describe('M1: Jev spend block from the ledger + gate', () => {
  it('records start/end ledger state, requests that passed the gate and refusals', async () => {
    const ledger = await JevLedger.open(path.join(await tmp(), 'jev-round1.json'));
    try {
      // Spend from an earlier step must show up as spentBefore.
      const pre = await ledger.reserve({ step: 'earlier', use: 'J5', model: 'jev-1.14.0', boundTokens: 1_000 });
      await ledger.settle(pre, { model: 'jev-1.14.0', inputTokens: 1_000 });
      const before = ledger.state().spentUsd;
      const s = jevSpendSession(ledger, { step: 'judge:J5:t' });
      await s.gate.settle(await s.gate.reserve({ use: 'J5', model: 'jev-1.14.0', boundTokens: 1_000 }), { model: 'jev-1.14.0', inputTokens: 400 });
      await s.gate.reserve({ use: 'J5', model: 'jev-1.14.0', boundTokens: 1_000 }); // left open: stays reserved
      await expect(s.gate.reserve({ use: 'J5', model: 'jev-1.14.0', boundTokens: 20_000_000 })).rejects.toThrow(/cap/);
      const info = s.spendInfo();
      const end = ledger.state();
      expect(info).toEqual({
        roundId: 'jev-round1',
        capUsd: 0.5,
        spentBefore: before,
        spentAfter: end.spentUsd,
        reservedAfter: end.reservedUsd,
        requests: 2,
        refusals: 1
      });
      expect(info.spentAfter).toBeGreaterThan(info.spentBefore);
      expect(info.reservedAfter).toBeGreaterThan(0);
      // Only this session's step is attributed in the ledger.
      expect(ledger.entries().filter((e) => e.step === 'judge:J5:t' && e.kind === 'reserve')).toHaveLength(2);
    } finally {
      await ledger.close();
    }
  });

  it('a ceiling refusal counts as a refusal, not a request', async () => {
    const ledger = await JevLedger.open(path.join(await tmp(), 'jev-round1.json'));
    try {
      const s = jevSpendSession(ledger, { step: 's', ceilingUsd: 0 });
      await expect(s.gate.reserve({ use: 'J1', model: 'jev-1.14.0', boundTokens: 10 })).rejects.toThrow();
      expect(s.spendInfo()).toMatchObject({ requests: 0, refusals: 1, spentBefore: 0, spentAfter: 0 });
    } finally {
      await ledger.close();
    }
  });
});

describe('M1: per-phase requests are counted for a non-mock client (cache-miss path)', () => {
  it('J5 with a gated fake "typesafe" client reports requests = 1, then 0 from the cache', async () => {
    const cases = await load<LoadedCase[]>('cases.json');
    const dir = await tmp();
    const ledger = await JevLedger.open(path.join(dir, 'jev-round1.json'));
    try {
      const s = jevSpendSession(ledger, { step: 'judge:J5:t' });
      const client = gatedFakeClient(s.gate, { d0: { noul: 0.9 }, d1: { noul: 0.1 } });
      const cache = new JudgeCache(judgeEvalCacheDir(dir, 'typesafe'));
      const a = await runJudgeEval({ use: 'J5', label: 't', now: new Date(0), cases: [cases[0]!], deps: j5Deps(client, cache) });
      expect(a.client).toBe('typesafe');
      expect(a.phases[0]!.requests).toBe(1);
      const b = await runJudgeEval({ use: 'J5', label: 't', now: new Date(0), cases: [cases[0]!], deps: j5Deps(client, cache) });
      expect(b.phases[0]!.requests).toBe(0);
      expect(client.sent).toBe(1);
      expect(s.spendInfo().requests).toBe(1);
    } finally {
      await ledger.close();
    }
  });
});

describe('m1: no absolute user-profile path in Jev result files', () => {
  const home = os.homedir();
  const localAppData = path.join(home, 'AppData', 'Local');

  it('publicCachePath: %LOCALAPPDATA% substituted, other absolute paths reduced to the basename, relative kept', () => {
    expect(publicCachePath(path.join(localAppData, 'dep-agent-eval', '_judge'), { localAppData })).toBe(path.join('%LOCALAPPDATA%', 'dep-agent-eval', '_judge'));
    expect(publicCachePath(localAppData.toUpperCase() + path.sep + '_judge', { localAppData })).toBe(path.join('%LOCALAPPDATA%', '_judge'));
    expect(publicCachePath(path.join(home, 'elsewhere', '_judge-mock'), { localAppData })).toBe('_judge-mock');
    expect(publicCachePath(path.join(home, 'x'), {})).toBe('x');
    expect(publicCachePath(path.join('rel', '_judge'), { localAppData })).toBe(path.join('rel', '_judge'));
    expect(publicCachePath(null, { localAppData })).toBeNull();
  });

  it('router-jev and router-arms results contain no string with os.homedir()', async () => {
    const cases = await load<LoadedCase[]>('cases.json');
    const files = { opus: await load<ResultFile>('opus.json'), sonnet: await load<ResultFile>('sonnet.json'), haiku: await load<ResultFile>('haiku.json') };
    // A cache dir under the user profile, as the CLI passes it; only its contents live in the sandbox.
    const sandbox = await tmp();
    const cacheDir = judgeEvalCacheDir(sandbox, 'mock');
    const profileCacheDir = path.join(localAppData, 'dep-agent-eval', '_judge-mock');
    const judge = new Judge({
      client: new MockJudgeClient({ responder: () => ({ difficulty: { choice: 'moderate', confidence: 0.9, probabilities: { easy: 0.05, moderate: 0.9, hard: 0.05 } } }) }),
      cache: new JudgeCache(cacheDir),
      switches: normalizeJudgeSwitches({ enabled: true, router: true })
    });
    const routed = await askRouterJev({ label: 't', now: new Date(0), cases, files, inputNames: { opus: 'o', sonnet: 's', haiku: 'h' }, judge, client: 'mock', jevCache: profileCacheDir, localAppData });
    const arms = await computeRouterArms({ label: 't', now: new Date(0), cases, files, inputNames: { opus: 'o', sonnet: 's', haiku: 'h', jevCache: profileCacheDir }, jev: jevCacheLookup(cacheDir), localAppData });
    for (const r of [routed, arms]) {
      const hits = allStrings(JSON.parse(JSON.stringify(r))).filter((x) => x.toLowerCase().includes(home.toLowerCase()));
      expect(hits).toEqual([]);
    }
    expect(routed.jevCache).toBe(path.join('%LOCALAPPDATA%', 'dep-agent-eval', '_judge-mock'));
    expect(arms.inputs.jevCache).toBe(path.join('%LOCALAPPDATA%', 'dep-agent-eval', '_judge-mock'));
  });

  it('a J result with a spend block contains no string with os.homedir()', async () => {
    const cases = await load<LoadedCase[]>('cases.json');
    const ledger = await JevLedger.open(path.join(await tmp(), 'jev-round1.json'));
    try {
      const s = jevSpendSession(ledger, { step: 'judge:J5:t' });
      const r = await runJudgeEval({ use: 'J5', label: 't', now: new Date(0), cases: [cases[0]!], deps: j5Deps(gatedFakeClient(s.gate, { d0: { noul: 0.9 } }), null) });
      const withSpend = { ...r, spend: s.spendInfo() };
      expect(allStrings(withSpend).filter((x) => x.toLowerCase().includes(os.homedir().toLowerCase()))).toEqual([]);
    } finally {
      await ledger.close();
    }
  });
});
