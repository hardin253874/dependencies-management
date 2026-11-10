/**
 * 5b.6 router rules (pure) and 5b.7 router Jev step (mock judge):
 * mapping, escalation, every outage kind → configured model, private →
 * rules only, cached answer reused.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { HAIKU, OPUS, SONNET, ROUTER_RULES, routeModel, routeRules, routerCandidates, stepUp, type RouterFacts } from '@/core/llm/router';
import { Judge } from '@/core/judge/judge';
import { JudgeCache } from '@/core/judge/cache';
import { MockJudgeClient, type MockFailure } from '@/core/judge/mock';
import { normalizeJudgeSwitches, type JudgeSubject } from '@/core/judge/types';

const base: RouterFacts = { view: 'update-report', jump: 'minor', packageCount: 1, graphFileCount: 50, apiDiff: null, cveCount: 0, configuredModel: 'claude-sonnet-5-5' };
const f = (o: Partial<RouterFacts>): RouterFacts => ({ ...base, ...o });
const ON = normalizeJudgeSwitches({ enabled: true, router: true });
const PUBLIC: JudgeSubject = { privacy: 'public' };

afterEach(() => {
  vi.useRealTimers();
});

describe('5b.6 rules', () => {
  it('easy: patch/none, ≤ 20 files, no CVEs → Haiku; boundary 20/21', () => {
    expect(routeRules(f({ jump: 'patch', graphFileCount: 20 }))).toMatchObject({ decision: { model: HAIKU, via: 'rule' } });
    expect(routeRules(f({ jump: 'none', graphFileCount: 0 }))).toMatchObject({ decision: { model: HAIKU } });
    expect(routeRules(f({ jump: 'patch', graphFileCount: 21 }))).toMatchObject({ unclear: true });
    expect(routeRules(f({ jump: 'patch', graphFileCount: 5, cveCount: 1 }))).toMatchObject({ unclear: true });
  });

  it('hard: major and (≥ 200 files | ≥ 3 packages | ≥ 10 removed); boundaries 199/200, 9/10', () => {
    expect(routeRules(f({ jump: 'major', graphFileCount: 200 }))).toMatchObject({ decision: { model: OPUS } });
    expect(routeRules(f({ jump: 'major', graphFileCount: 199 }))).toMatchObject({ unclear: true });
    expect(routeRules(f({ jump: 'major', packageCount: 3 }))).toMatchObject({ decision: { model: OPUS } });
    expect(routeRules(f({ jump: 'major', packageCount: 2 }))).toMatchObject({ unclear: true });
    expect(routeRules(f({ jump: 'major', apiDiff: { removed: 10, signatureChanged: 0 } }))).toMatchObject({ decision: { model: OPUS } });
    expect(routeRules(f({ jump: 'major', apiDiff: { removed: 9, signatureChanged: 0 } }))).toMatchObject({ unclear: true });
    expect(routeRules(f({ jump: 'minor', graphFileCount: 5000 }))).toMatchObject({ unclear: true });
  });

  it('deep report → Opus regardless', () => {
    expect(routeRules(f({ view: 'deep-report', jump: 'patch', graphFileCount: 1 }))).toMatchObject({ decision: { model: OPUS, effort: 'high' } });
  });

  it('reason strings are stable and human-readable', () => {
    const r = routeRules(f({ jump: 'major', graphFileCount: 1352 }));
    expect('decision' in r && r.decision.reason).toBe('major jump, 1,352 files → Opus 5.5');
    expect(ROUTER_RULES).toEqual({ easyMaxFiles: 20, hardMinFiles: 200, hardMinPackages: 3, hardMinRemovedExports: 10 });
  });

  it('candidates exclude Fable 5.1; stepUp ladder', () => {
    expect(routerCandidates()).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
    expect([stepUp(HAIKU), stepUp(SONNET), stepUp(OPUS)]).toEqual([SONNET, OPUS, OPUS]);
  });

  it('RouterFacts carries no string field other than enums and the model id (compile-time shape)', () => {
    const keys: Array<keyof RouterFacts> = ['view', 'jump', 'packageCount', 'graphFileCount', 'apiDiff', 'cveCount', 'configuredModel'];
    expect(Object.keys(base).sort()).toEqual([...keys].sort());
  });
});

function judgeWith(mock: MockJudgeClient, cache: JudgeCache | null = null): Judge {
  return new Judge({ client: mock, cache, switches: ON });
}

describe('5b.7 Jev step', () => {
  it.each([
    ['easy', HAIKU],
    ['moderate', SONNET],
    ['hard', OPUS]
  ])('%s → %s', async (label, model) => {
    const mock = new MockJudgeClient({ responder: () => ({ difficulty: { choice: label, confidence: 0.9 } }) });
    const d = await routeModel(base, { judge: judgeWith(mock), subject: PUBLIC });
    expect(d).toMatchObject({ model, via: 'jev' });
    expect(d.jev).toMatchObject({ choice: label, confidence: 0.9, model: 'jev-1.14.0', cached: false });
    expect(d.jev?.latencyMs).toBeTypeOf('number');
  });

  it('low confidence escalates one step', async () => {
    const mock = new MockJudgeClient({ responder: () => ({ difficulty: { choice: 'easy', confidence: 0.4 } }) });
    const d = await routeModel(base, { judge: judgeWith(mock), subject: PUBLIC });
    expect(d.model).toBe(SONNET);
    expect(d.reason).toMatch(/low → one step up/);
  });

  it('low probability (< 0.6) escalates even with high confidence', async () => {
    const mock = new MockJudgeClient({
      responder: () => ({ difficulty: { choice: 'moderate', confidence: 0.7, probabilities: { easy: 0.45, moderate: 0.55, hard: 0 } } })
    });
    const d = await routeModel(base, { judge: judgeWith(mock), subject: PUBLIC });
    expect(d.model).toBe(OPUS);
  });

  it.each<MockFailure>(['timeout', '429', '529', '401', 'connection'])('outage %s → configured model, via default', async (failure) => {
    const mock = new MockJudgeClient();
    mock.failure = failure;
    const d = await routeModel(base, { judge: judgeWith(mock), subject: PUBLIC });
    expect(d).toMatchObject({ model: 'claude-sonnet-5-5', via: 'default' });
    expect(d.reason).toMatch(/unavailable/);
  });

  it('a hanging judge resolves to the configured model within the 3 s router timeout (fake timers)', async () => {
    vi.useFakeTimers();
    const mock = new MockJudgeClient();
    mock.failure = 'hang';
    const p = routeModel(base, { judge: judgeWith(mock), subject: PUBLIC });
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(p).resolves.toMatchObject({ via: 'default', reason: expect.stringMatching(/timeout/) as unknown as string });
  });

  it('no key, router Jev off, ledger refusal → configured model', async () => {
    expect(await routeModel(base, { judge: new Judge({ client: null, cache: null, switches: ON }), subject: PUBLIC })).toMatchObject({ via: 'default', reason: expect.stringMatching(/no-key/) as unknown as string });
    expect(await routeModel(base, { judge: new Judge({ client: new MockJudgeClient(), cache: null, switches: normalizeJudgeSwitches({ enabled: true }) }), subject: PUBLIC })).toMatchObject({ via: 'default', reason: expect.stringMatching(/router Jev off/) as unknown as string });
    expect(await routeModel(base, { judge: null, subject: PUBLIC })).toMatchObject({ via: 'default' });
  });

  it('private and unknown-privacy projects: rules only, 0 judge requests', async () => {
    const mock = new MockJudgeClient();
    for (const subject of [{ privacy: 'private' }, { privacy: undefined }] as JudgeSubject[]) {
      const d = await routeModel(base, { judge: judgeWith(mock), subject });
      expect(d).toMatchObject({ via: 'default', reason: 'private project: rules only' });
      // A rule case still routes.
      expect(await routeModel(f({ view: 'deep-report' }), { judge: judgeWith(mock), subject })).toMatchObject({ model: OPUS, via: 'rule' });
    }
    expect(mock.requests).toHaveLength(0);
  });

  it('allowJudge: false (cost-estimate GET) never asks', async () => {
    const mock = new MockJudgeClient();
    const d = await routeModel(base, { judge: judgeWith(mock), subject: PUBLIC, allowJudge: false });
    expect(d.via).toBe('default');
    expect(mock.requests).toHaveLength(0);
  });

  it('a cached answer is reused (second route sends nothing)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-cache-'));
    try {
      const mock = new MockJudgeClient({ responder: () => ({ difficulty: { choice: 'hard', confidence: 0.95 } }) });
      const judge = judgeWith(mock, new JudgeCache(dir));
      await routeModel(base, { judge, subject: PUBLIC });
      const again = await routeModel(base, { judge, subject: PUBLIC });
      expect(again.jev?.cached).toBe(true);
      expect(mock.requests).toHaveLength(1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
