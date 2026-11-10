/**
 * 5b.16 offline router arms + J harness (mock): arms math on synthetic
 * fixtures (hand-computed, see test-fixtures/eval/router/README.md), D28 ship
 * check on full set and subset, private case refused, `--real` without a key
 * fails before any network, and router-arms never constructs an Anthropic client.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

const anthropicCtor = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({ default: class { constructor() { anthropicCtor(); } } }));

import { askRouterJev, computeRouterArms, jevCacheLookup, phaseFacts, routerCacheKey, RouterArmsError, shipChecks } from '../../../eval/lib/router-arms';
import { coUpgradedTruth, f1, judgeEvalCacheDir, recallAtK, runJudgeEval, JudgeEvalError } from '../../../eval/lib/judge';
import { Judge } from '@/core/judge/judge';
import { normalizeJudgeSwitches } from '@/core/judge/types';
import { loadTypesafeKey, MissingTypesafeKeyError, createRealJudgeClient, PrivateCaseError } from '../../../eval/lib/real';
import { parseArgs, UsageError } from '../../../eval/lib/args';
import { JudgeCache } from '@/core/judge/cache';
import { MockJudgeClient } from '@/core/judge/mock';
import type { LoadedCase, ResultFile } from '../../../eval/lib/types';

const FIX = path.join(process.cwd(), 'test-fixtures', 'eval', 'router');
async function load<T>(name: string): Promise<T> {
  return JSON.parse(await fs.readFile(path.join(FIX, name), 'utf8')) as T;
}
async function inputs() {
  return {
    cases: await load<LoadedCase[]>('cases.json'),
    files: { opus: await load<ResultFile>('opus.json'), sonnet: await load<ResultFile>('sonnet.json'), haiku: await load<ResultFile>('haiku.json') },
    inputNames: { opus: 'opus.json', sonnet: 'sonnet.json', haiku: 'haiku.json', jevCache: null }
  };
}
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

describe('router arms (synthetic fixtures)', () => {
  it('always / rules-only arms match the hand-computed table', async () => {
    const r = await computeRouterArms({ label: 't', now: new Date(0), ...(await inputs()) });
    const arm = (id: string) => r.arms.find((a) => a.arm === id)!;
    expect(arm('always-opus')).toMatchObject({ costUsd: 0.8, full: { overall: { recall: 144 / 160 }, complex: { recall: 135 / 150 } }, subset: { overall: { recall: 55 / 160 } } });
    expect(arm('always-sonnet')).toMatchObject({ costUsd: 0.4, full: { overall: { recall: 141 / 160 } } });
    // rules-only: major/300 → Opus, patch/10 → Haiku, minor/50 unclear → configured (Opus).
    expect(arm('rules-only').models).toEqual({ 'claude-opus-5-5': 2, 'claude-haiku-5-5': 1 });
    expect(arm('rules-only').costUsd).toBeCloseTo(0.705, 6);
    expect(arm('rules-only').full.overall.recall).toBeCloseTo(144 / 160, 9);
    // rules+Jev without any cached answer = rules-only.
    expect(arm('rules+jev').costUsd).toBeCloseTo(0.705, 6);
    expect(anthropicCtor).not.toHaveBeenCalled();
  });

  it('rules+Jev with a cached "moderate" → Sonnet on the unclear phase; ship check met on full and subset', async () => {
    const inp = await inputs();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'arms-jev-'));
    dirs.push(dir);
    const facts = phaseFacts(inp.cases[2]!.phases[0]!.packages, 50, 'claude-opus-5-5');
    await new JudgeCache(dir).put(routerCacheKey(facts), {
      answers: { difficulty: { type: 'choice', choice: 'moderate', confidence: 0.9, probabilities: { easy: 0.05, moderate: 0.9, hard: 0.05 } } },
      model: 'jev-1.14.0',
      usage: { inputTokens: 200 },
      latencyMs: 300
    });
    const r = await computeRouterArms({ label: 't', now: new Date(0), ...inp, jev: jevCacheLookup(dir) });
    const jev = r.arms.find((a) => a.arm === 'rules+jev')!;
    expect(jev.models).toEqual({ 'claude-opus-5-5': 1, 'claude-haiku-5-5': 1, 'claude-sonnet-5-5': 1 });
    expect(jev.jevRequests).toBe(1);
    expect(jev.jevCostUsd).toBeCloseTo(200 * 0.042e-6, 9);
    expect(jev.full.overall.recall).toBeCloseTo(143 / 160, 9);
    expect(jev.subset.overall.recall).toBeCloseTo(52 / 160, 9);
    const checks = r.shipCheck.filter((c) => c.arm === 'rules+jev');
    expect(checks.map((c) => [c.set, c.met])).toEqual([
      ['full', true],
      ['subset', true]
    ]);
    // rules-only saves only ~12 %: not met.
    expect(r.shipCheck.find((c) => c.arm === 'rules-only' && c.set === 'full')!.met).toBe(false);
  });

  it('ship check needs both: recall within 2 points AND ≥ 30 % cheaper', () => {
    const mk = (arm: 'always-opus' | 'rules-only', recall: number, cost: number) => ({
      arm,
      phases: 1,
      models: {},
      full: { overall: { precision: null, recall }, complex: { precision: null, recall } },
      subset: { overall: { precision: null, recall }, complex: { precision: null, recall } },
      costUsd: cost,
      jevCostUsd: 0,
      jevRequests: 0,
      decisions: []
    });
    expect(shipChecks([mk('always-opus', 0.9, 1), mk('rules-only', 0.879, 0.5)])[0]!.met).toBe(false);
    expect(shipChecks([mk('always-opus', 0.9, 1), mk('rules-only', 0.88, 0.71)])[0]!.met).toBe(false);
    expect(shipChecks([mk('always-opus', 0.9, 1), mk('rules-only', 0.88, 0.7)])[0]!.met).toBe(true);
  });

  it('refuses a private case and non-agent result files', async () => {
    const inp = await inputs();
    const priv = inp.cases.map((c, i) => (i === 0 ? { ...c, visibility: 'private' as const } : c));
    await expect(computeRouterArms({ label: 't', now: new Date(0), ...inp, cases: priv })).rejects.toBeInstanceOf(RouterArmsError);
    await expect(computeRouterArms({ label: 't', now: new Date(0), ...inp, files: { ...inp.files, opus: { ...inp.files.opus, predictor: 'v2-graph' } } })).rejects.toThrow(/v2-agent/);
  });
});

describe('judge harness (mock)', () => {
  it('metric helpers', () => {
    expect(recallAtK(['a', 'b', 'c'], new Set(['c', 'x']), 2)).toBe(0);
    expect(recallAtK(['c', 'b'], new Set(['c', 'x']), 2)).toBe(0.5);
    expect(recallAtK(['c'], new Set(['c']), 50)).toBe(1);
    expect(f1(new Set(['a', 'b']), new Set(['a']))).toEqual({ precision: 0.5, recall: 1, f1: 2 / 3 });
    expect([...coUpgradedTruth([{ changes: [{ field: 'dependencies', name: 'react', from: '1', to: '2' }, { field: 'dependencies', name: 'react-dom', from: '1', to: '2' }] }], ['react'])]).toEqual(['react-dom']);
  });

  it('J5 over injected truth (no clone, mock client); private case refused; J3 not measurable', async () => {
    const cases = await load<LoadedCase[]>('cases.json');
    const mock = new MockJudgeClient({ responder: () => ({ d0: { noul: 0.9 }, d1: { noul: 0.1 } }) });
    const deps = {
      prepare: async () => 'C:/clone',
      truth: async () => [{ phaseId: 'p1', kept: [], dependencyDiff: [{ projectDir: '.', changes: [{ field: 'dependencies' as const, name: 'react-dom', from: '17.0.2', to: '18.2.0' }] }] }],
      predicted: async () => new Map<string, string[]>(),
      snippet: async () => null,
      directDeps: async () => [
        { name: 'react-dom', version: '17.0.2' },
        { name: 'lodash', version: '4.17.21' }
      ],
      client: mock,
      log: () => undefined
    };
    const r = await runJudgeEval({ use: 'J5', label: 't', now: new Date(0), cases: [cases[0]!], deps });
    expect(r.status).toBe('measured');
    expect(r.phases[0]!.metrics['jev.f1']).toBe(1);
    expect(r.phases[0]!.requests).toBe(1);
    await expect(runJudgeEval({ use: 'J5', label: 't', now: new Date(0), cases: [{ ...cases[0]!, visibility: 'private' }], deps })).rejects.toBeInstanceOf(JudgeEvalError);
    expect((await runJudgeEval({ use: 'J4', label: 't', now: new Date(0), cases: [cases[0]!], deps })).status).toBe('not-measurable');
  });

  it('`judge --real` key loader: env wins, else only TYPESAFE_API_KEY from the file; missing → error before any network', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-key-'));
    dirs.push(dir);
    const envFile = path.join(dir, '.env');
    await fs.writeFile(envFile, 'ANTHROPIC_API_KEY=sk-ant-not-this-one\nTYPESAFE_API_KEY=ts-file-key\n');
    expect(await loadTypesafeKey(envFile, {})).toBe('ts-file-key');
    expect(await loadTypesafeKey(envFile, { TYPESAFE_API_KEY: 'ts-env' })).toBe('ts-env');
    await fs.writeFile(envFile, 'ANTHROPIC_API_KEY=sk-ant-only\n');
    await expect(loadTypesafeKey(envFile, {})).rejects.toBeInstanceOf(MissingTypesafeKeyError);
    await expect(loadTypesafeKey(path.join(dir, 'missing.env'), {})).rejects.toBeInstanceOf(MissingTypesafeKeyError);
  });

  it('real judge client refuses a private case before anything is built', () => {
    const calls: string[] = [];
    expect(() =>
      createRealJudgeClient({
        evalCase: { id: 'x', repo: 'https://example.invalid/x.git', visibility: 'private' },
        privateIds: new Set(),
        apiKey: 'k',
        gate: { reserve: async () => 'r', settle: async () => undefined },
        fetch: async (u) => {
          calls.push(u);
          return new Response('{}');
        }
      })
    ).toThrow(PrivateCaseError);
    expect(calls).toHaveLength(0);
  });

  it('args: router-arms needs the three files; judge validates --use and refuses --local', () => {
    expect(parseArgs(['router-arms', '--label', 'x', '--opus', 'a', '--sonnet', 'b', '--haiku', 'c'])).toMatchObject({ command: 'router-arms', opus: 'a' });
    expect(() => parseArgs(['router-arms', '--label', 'x', '--opus', 'a'])).toThrow(UsageError);
    expect(parseArgs(['judge', '--use', 'J1', '--label', 'x'])).toMatchObject({ command: 'judge', use: 'J1', real: false });
    expect(() => parseArgs(['judge', '--use', 'J9', '--label', 'x'])).toThrow(/J1-J8/);
    expect(() => parseArgs(['judge', '--use', 'J1', '--label', 'x', '--local', 'f'])).toThrow(/--local/);
    expect(() => parseArgs(['judge', '--use', 'J1', '--label', 'x', '--stop-at-usd', '0.1'])).toThrow(/--real/);
  });
});

describe('router Jev producer: eval judge --use router → router-arms --jev-cache (review 5b M3)', () => {
  it('asks only the unclear phase, writes it through JudgeCache, router-arms reads it back', async () => {
    const inp = await inputs();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-jev-'));
    dirs.push(dir);
    const cacheDir = judgeEvalCacheDir(dir, 'mock');
    expect(path.basename(cacheDir)).toBe('_judge-mock');
    expect(path.basename(judgeEvalCacheDir(dir, 'typesafe'))).toBe('_judge');
    const mock = new MockJudgeClient({
      responder: () => ({ difficulty: { choice: 'moderate', confidence: 0.9, probabilities: { easy: 0.05, moderate: 0.9, hard: 0.05 } } })
    });
    const judge = new Judge({ client: mock, cache: new JudgeCache(cacheDir), switches: normalizeJudgeSwitches({ enabled: true, router: true }) });
    const run = () =>
      askRouterJev({ label: 't', now: new Date(0), cases: inp.cases, files: inp.files, inputNames: { opus: 'o', sonnet: 's', haiku: 'h' }, judge, client: 'mock', jevCache: cacheDir });
    const r = await run();
    // major/300 and patch/10 are decided by rules; only minor/50 goes to Jev.
    expect(r.rulesDecided).toBe(2);
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]).toMatchObject({ via: 'jev', model: 'claude-sonnet-5-5', cached: false });
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]!.use).toBe('router');
    const facts = phaseFacts(inp.cases[2]!.phases[0]!.packages, 50, 'claude-opus-5-5');
    expect(r.asked[0]!.key).toBe(routerCacheKey(facts));
    await expect(fs.stat(path.join(cacheDir, `${routerCacheKey(facts)}.json`))).resolves.toBeTruthy();
    // Re-run: answered from the cache, no new request.
    expect((await run()).asked[0]!.cached).toBe(true);
    expect(mock.requests).toHaveLength(1);
    // Round trip: router-arms with --jev-cache picks Sonnet on the unclear phase.
    const arms = await computeRouterArms({ label: 't', now: new Date(0), ...inp, jev: jevCacheLookup(cacheDir) });
    const jev = arms.arms.find((a) => a.arm === 'rules+jev')!;
    expect(jev.models).toEqual({ 'claude-opus-5-5': 1, 'claude-haiku-5-5': 1, 'claude-sonnet-5-5': 1 });
    expect(jev.jevRequests).toBe(1);
    expect(jev.decisions.find((d) => d.via === 'jev')).toMatchObject({ model: 'claude-sonnet-5-5' });
  });

  it('request cap: over --max the rest is skipped and never asked; private case refused; outage not cached', async () => {
    const inp = await inputs();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-jev-'));
    dirs.push(dir);
    const mock = new MockJudgeClient();
    const judge = new Judge({ client: mock, cache: new JudgeCache(dir), switches: normalizeJudgeSwitches({ enabled: true, router: true }) });
    const base = { label: 't', now: new Date(0), files: inp.files, inputNames: { opus: 'o', sonnet: 's', haiku: 'h' }, judge, client: 'mock' as const, jevCache: dir };
    const capped = await askRouterJev({ ...base, cases: inp.cases, maxRequests: 0 });
    expect(capped.asked).toHaveLength(0);
    expect(capped.skipped).toHaveLength(1);
    expect(mock.requests).toHaveLength(0);
    await expect(askRouterJev({ ...base, cases: inp.cases.map((c, i) => (i === 2 ? { ...c, visibility: 'private' as const } : c)) })).rejects.toBeInstanceOf(RouterArmsError);
    expect(mock.requests).toHaveLength(0);
    mock.failure = 'connection';
    const down = await askRouterJev({ ...base, cases: inp.cases });
    expect(down.asked[0]).toMatchObject({ via: 'default' });
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('args: judge --use router needs the three result files; they are refused for other uses', () => {
    expect(parseArgs(['judge', '--use', 'router', '--label', 'x', '--opus', 'a', '--sonnet', 'b', '--haiku', 'c', '--cases', 'p1'])).toMatchObject({ command: 'judge', use: 'router', opus: 'a', sonnet: 'b', haiku: 'c', cases: ['p1'] });
    expect(() => parseArgs(['judge', '--use', 'router', '--label', 'x', '--opus', 'a'])).toThrow(UsageError);
    expect(() => parseArgs(['judge', '--use', 'J5', '--label', 'x', '--opus', 'a'])).toThrow(/--use router/);
  });
});

describe('eval judge J uses go through the eval JudgeCache (review 5b M3)', () => {
  it('second J5 run is answered from <evalCache>/_judge-mock with no request', async () => {
    const cases = await load<LoadedCase[]>('cases.json');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'judge-eval-cache-'));
    dirs.push(dir);
    const mock = new MockJudgeClient({ responder: () => ({ d0: { noul: 0.9 } }) });
    const deps = {
      prepare: async () => 'C:/clone',
      truth: async () => [{ phaseId: 'p1', kept: [], dependencyDiff: [] }],
      predicted: async () => new Map<string, string[]>(),
      snippet: async () => null,
      directDeps: async () => [{ name: 'react-dom', version: '17.0.2' }],
      client: mock,
      cache: new JudgeCache(judgeEvalCacheDir(dir, 'mock')),
      log: () => undefined
    };
    const a = await runJudgeEval({ use: 'J5', label: 't', now: new Date(0), cases: [cases[0]!], deps });
    const b = await runJudgeEval({ use: 'J5', label: 't', now: new Date(0), cases: [cases[0]!], deps });
    expect(a.phases[0]!.requests).toBe(1);
    expect(b.phases[0]!.requests).toBe(0);
    expect((await fs.readdir(path.join(dir, '_judge-mock'))).length).toBe(1);
  });
});
