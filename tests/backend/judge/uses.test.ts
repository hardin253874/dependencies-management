/**
 * 5b.10–5b.15 core helpers over the mock judge: J1 ordering + batching,
 * J2 badges, J3 triage, J4 rename candidates (top 50), J5/J6 suggestions,
 * J7 band, J8 suggestions; every flag off → no request.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { JEV_TIMEOUT_MS, JEV_USE_DEADLINE_MS } from '@/core/judge/constants';
import type { JudgeClient } from '@/core/judge/client';
import { Judge } from '@/core/judge/judge';
import { MockJudgeClient } from '@/core/judge/mock';
import { REQUEST_MAX_BOUND_TOKENS, requestBoundTokens } from '@/core/judge/payload';
import { normalizeJudgeSwitches, J_FLAGS, type JudgeSubject } from '@/core/judge/types';
import {
  bandFromScore,
  coUpgradeJ5,
  createJudgeBreaker,
  estimateSeverityJ7,
  evidenceCheckJ2,
  rankFilesJ1,
  relatedUnknownJ6,
  renameCandidatesJ4,
  suggestFindingsJ8,
  supportFromNoul,
  topCandidates,
  triageCvesJ3
} from '@/core/judge/uses';

const ALL = normalizeJudgeSwitches({ enabled: true, router: true, flags: Object.fromEntries(J_FLAGS.map((j) => [j, true])) });
const PUBLIC: JudgeSubject = { privacy: 'public' };

function ctxWith(mock: MockJudgeClient, switches = ALL) {
  return { judge: new Judge({ client: mock, cache: null, switches }), subject: PUBLIC };
}

describe('J1 rank files', () => {
  it('orders by score desc, ties keep input order', async () => {
    const mock = new MockJudgeClient({ responder: () => ({ f0: { score: 1 }, f1: { score: 4 }, f2: { score: 1 }, f3: { score: 3 } }) });
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts'].map((p) => ({ path: p, snippet: `import x from 'react'; // ${p}` }));
    const out = await rankFilesJ1(ctxWith(mock), { pkg: 'react', from: '17.0.2', to: '18.2.0', files });
    expect(out?.order).toEqual(['b.ts', 'd.ts', 'a.ts', 'c.ts']);
  });

  it('batches keep every request under the token bound', async () => {
    const mock = new MockJudgeClient();
    const files = Array.from({ length: 60 }, (_, i) => ({ path: `src/f${i}.ts`, snippet: 'z'.repeat(1_900) }));
    await rankFilesJ1(ctxWith(mock), { pkg: 'react', from: '17.0.2', to: '18.2.0', files });
    expect(mock.requests.length).toBeGreaterThan(1);
    for (const r of mock.requests) expect(requestBoundTokens('jev-1.14.0', r.state, r.questions)).toBeLessThanOrEqual(REQUEST_MAX_BOUND_TOKENS);
    expect(mock.requests.reduce((n, r) => n + Object.keys(r.questions).length, 0)).toBe(60);
  });

  it('flag off → null, no request', async () => {
    const mock = new MockJudgeClient();
    const out = await rankFilesJ1(ctxWith(mock, normalizeJudgeSwitches({ enabled: true })), { pkg: 'react', from: '1.0.0', to: '2.0.0', files: [{ path: 'a.ts', snippet: 'x' }] });
    expect(out).toBeNull();
    expect(mock.requests).toHaveLength(0);
  });
});

describe('J2 evidence check', () => {
  it('noul < 0.3 → low, 0.3–0.7 → unclear, ≥ 0.7 → none', async () => {
    expect([supportFromNoul(0.1), supportFromNoul(0.5), supportFromNoul(0.9)]).toEqual(['low', 'unclear', null]);
    let i = 0;
    const values = [0.1, 0.5, 0.9];
    const mock = new MockJudgeClient({ responder: () => ({ supported: { noul: values[i++] } }) });
    const out = await evidenceCheckJ2(ctxWith(mock), [
      { id: 'a', claim: 'a.ts must change', evidence: [{ path: 'a.ts', text: 'x' }] },
      { id: 'b', claim: 'b.ts must change', evidence: [{ path: 'b.ts', text: 'y' }] },
      { id: 'c', claim: 'c.ts must change', evidence: [] }
    ]);
    expect([...out!.entries()].map(([k, v]) => [k, v.support])).toEqual([
      ['a', 'low'],
      ['b', 'unclear'],
      ['c', null]
    ]);
  });
});

describe('J3 CVE triage', () => {
  it('maps choices; low confidence → inconclusive', async () => {
    const answers = [
      { choice: 'not-affected', confidence: 0.9 },
      { choice: 'likely-affected', confidence: 0.3 }
    ];
    let i = 0;
    const mock = new MockJudgeClient({ responder: () => ({ verdict: answers[i++] }) });
    const out = await triageCvesJ3(ctxWith(mock), { cves: [{ id: 'CVE-1', advisory: 'XSS' }, { id: 'CVE-2', advisory: 'RCE' }], snippets: [{ path: 'a.ts', text: 'x' }] });
    expect(out?.get('CVE-1')?.verdict).toBe('not-affected');
    expect(out?.get('CVE-2')?.verdict).toBe('inconclusive');
  });
});

describe('J4 rename candidates', () => {
  it('choice → candidate; none → nothing', async () => {
    let i = 0;
    const picks = ['createRoot', '__none__'];
    const mock = new MockJudgeClient({ responder: () => ({ replacement: { choice: picks[i++], confidence: 0.8 } }) });
    const out = await renameCandidatesJ4(ctxWith(mock), {
      pkg: 'react-dom',
      removed: [{ name: 'render', signature: 'function render(el, c): void' }, { name: 'gone', signature: 'const gone: number' }],
      added: [{ name: 'createRoot', signature: 'function createRoot(c): Root' }]
    });
    expect(out).toEqual([{ from: 'render', to: 'createRoot', confidence: 0.8, source: 'jev' }]);
  });

  it('> 50 added exports → top 50 by name similarity (deterministic)', () => {
    const added = Array.from({ length: 80 }, (_, i) => ({ name: `fn${String(i).padStart(2, '0')}`, signature: 's' }));
    added.push({ name: 'renderRoot', signature: 's' });
    const top = topCandidates('render', added);
    expect(top).toHaveLength(50);
    expect(top[0]!.name).toBe('renderRoot');
    expect(topCandidates('render', added).map((a) => a.name)).toEqual(top.map((a) => a.name));
  });
});

describe('J5 / J6 metadata suggestions', () => {
  it('J5: noul ≥ 0.7 → suggestion; one request for all deps', async () => {
    const mock = new MockJudgeClient({ responder: () => ({ d0: { noul: 0.9 }, d1: { noul: 0.2 } }) });
    const out = await coUpgradeJ5(ctxWith(mock), { target: 'react', from: '17.0.2', to: '18.2.0', deps: [{ name: 'react-dom', version: '17.0.2' }, { name: 'lodash', version: '4.17.21' }] });
    expect(out).toEqual([{ name: 'react-dom', noul: 0.9 }]);
    expect(mock.requests).toHaveLength(1);
  });

  it('J6: low confidence keeps investigate', async () => {
    const mock = new MockJudgeClient({ responder: () => ({ a0: { choice: 'upgrade', confidence: 0.8 }, b0: { choice: 'major', confidence: 0.8 }, a1: { choice: 'keep', confidence: 0.4 } }) });
    const out = await relatedUnknownJ6(ctxWith(mock), { viewedDep: 'node', from: '16.0.0', to: '20.0.0', deps: [{ name: 'sass', version: '1.0.0' }, { name: 'jest', version: '27.0.0' }] });
    expect(out?.get('sass')).toMatchObject({ action: 'upgrade', bump: 'major' });
    expect(out?.get('jest')?.action).toBe('investigate');
  });
});

describe('J7 / J8 public text', () => {
  it('J7: score → band', async () => {
    expect([bandFromScore(0), bandFromScore(1.4), bandFromScore(2.6), bandFromScore(9)]).toEqual(['low', 'medium', 'critical', 'critical']);
    const mock = new MockJudgeClient({ responder: () => ({ severity: { score: 2.2 } }) });
    expect((await estimateSeverityJ7(ctxWith(mock), { id: 'GHSA-1', summary: 'Prototype pollution' }))?.band).toBe('high');
  });

  it('J8: suggestions per finding; private eval case refused', async () => {
    const mock = new MockJudgeClient({ responder: () => ({ g0: { choice: 'found' }, g1: { choice: 'missed' } }) });
    const ctx = ctxWith(mock);
    const out = await suggestFindingsJ8(ctx, { reportText: 'report', findings: [{ id: 'F1', text: 'a' }, { id: 'F2', text: 'b' }] });
    expect([...out!.entries()]).toEqual([
      ['F1', 'found'],
      ['F2', 'missed']
    ]);
    const refused = await suggestFindingsJ8({ ...ctx, subject: { privacy: 'public', privateEvalCase: true } }, { reportText: 'r', findings: [{ id: 'F1', text: 'a' }] });
    expect(refused).toBeNull();
    expect(mock.requests).toHaveLength(1);
  });
});

describe('each flag independently gates its J', () => {
  it.each(J_FLAGS)('%s only', async (j) => {
    const mock = new MockJudgeClient();
    const ctx = ctxWith(mock, normalizeJudgeSwitches({ enabled: true, flags: { [j]: true } }));
    const snip = [{ path: 'a.ts', text: 'x' }];
    await rankFilesJ1(ctx, { pkg: 'p', from: '1.0.0', to: '2.0.0', files: [{ path: 'a.ts', snippet: 'x' }] });
    await evidenceCheckJ2(ctx, [{ id: 'a', claim: 'c', evidence: snip }]);
    await triageCvesJ3(ctx, { cves: [{ id: 'C', advisory: 'a' }], snippets: snip });
    await renameCandidatesJ4(ctx, { pkg: 'p', removed: [{ name: 'a', signature: 's' }], added: [{ name: 'b', signature: 's' }] });
    await coUpgradeJ5(ctx, { target: 'p', from: '1.0.0', to: '2.0.0', deps: [{ name: 'q', version: '1.0.0' }] });
    await relatedUnknownJ6(ctx, { viewedDep: 'p', from: '1.0.0', to: '2.0.0', deps: [{ name: 'q', version: '1.0.0' }] });
    await estimateSeverityJ7(ctx, { id: 'G', summary: 's' });
    await suggestFindingsJ8(ctx, { reportText: 'r', findings: [{ id: 'F', text: 't' }] });
    expect(mock.requests.map((r) => r.use)).toEqual([j]);
  });
});

describe('J-use outage latency: per-job breaker + overall deadline (review 5b M2)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const claims = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, claim: `claim ${i}`, evidence: [] }));

  it('J2 × 5 claims vs a hanging Jev: 1 request, done within one timeout, result null', async () => {
    vi.useFakeTimers();
    const mock = new MockJudgeClient();
    mock.failure = 'hang';
    const started = Date.now();
    const p = evidenceCheckJ2(ctxWith(mock), claims(5));
    await vi.advanceTimersByTimeAsync(JEV_TIMEOUT_MS);
    expect(await p).toBeNull();
    expect(mock.requests).toHaveLength(1);
    expect(Date.now() - started).toBeLessThanOrEqual(JEV_TIMEOUT_MS);
  });

  it('a shared context breaker stops later helper calls too (J7 across advisories)', async () => {
    vi.useFakeTimers();
    const mock = new MockJudgeClient();
    mock.failure = 'hang';
    const ctx = { ...ctxWith(mock), breaker: createJudgeBreaker() };
    const first = estimateSeverityJ7(ctx, { id: 'A', summary: 'x' });
    await vi.advanceTimersByTimeAsync(JEV_TIMEOUT_MS);
    expect(await first).toBeNull();
    expect(ctx.breaker.tripped).toBe('timeout');
    mock.failure = null;
    for (const id of ['B', 'C', 'D']) expect(await estimateSeverityJ7(ctx, { id, summary: 'x' })).toBeNull();
    expect(mock.requests).toHaveLength(1);
  });

  it('a fast connection error trips it as well (J4 asks once for many removed exports)', async () => {
    const mock = new MockJudgeClient();
    mock.failure = 'connection';
    const removed = Array.from({ length: 10 }, (_, i) => ({ name: `old${i}`, signature: `old${i}(): void` }));
    expect(await renameCandidatesJ4(ctxWith(mock), { pkg: 'p', removed, added: [{ name: 'neu', signature: 'neu(): void' }] })).toBeNull();
    expect(mock.requests).toHaveLength(1);
  });

  it('slow-but-answering Jev: the overall deadline caps the loop; the last request gets only what is left', async () => {
    vi.useFakeTimers();
    const timeouts: Array<number | undefined> = [];
    const slow: JudgeClient = {
      kind: 'mock',
      ask: async (input) => {
        timeouts.push(input.timeoutMs);
        await new Promise((r) => setTimeout(r, 3_000));
        return { answers: { supported: { type: 'noul', noul: 0.9 } }, model: 'jev-1.14.0', usage: { inputTokens: 1 }, latencyMs: 3_000 };
      }
    };
    const started = Date.now();
    const p = evidenceCheckJ2({ judge: new Judge({ client: slow, cache: null, switches: ALL }), subject: PUBLIC }, claims(50));
    await vi.advanceTimersByTimeAsync(JEV_USE_DEADLINE_MS + JEV_TIMEOUT_MS);
    const out = await p;
    // 3 s per answer: answers at 3, 6, 9 s; the 4th request gets 1 s left and times out; nothing after.
    expect(out?.size).toBe(3);
    expect(timeouts).toEqual([Math.min(JEV_TIMEOUT_MS, JEV_USE_DEADLINE_MS), JEV_USE_DEADLINE_MS - 3_000, JEV_USE_DEADLINE_MS - 6_000, JEV_USE_DEADLINE_MS - 9_000]);
    expect(Date.now() - started).toBeLessThanOrEqual(JEV_USE_DEADLINE_MS + JEV_TIMEOUT_MS);
  });

  it('a privacy refusal of one item does not trip the breaker', async () => {
    const mock = new MockJudgeClient({ responder: () => ({ supported: { noul: 0.1 } }) });
    const ctx = { ...ctxWith(mock), breaker: createJudgeBreaker() };
    // J5 with a non-npm-name dep → metadata payload refused (no request), breaker stays closed.
    expect(await coUpgradeJ5(ctx, { target: 'react', from: '17.0.2', to: '18.2.0', deps: [{ name: 'Not A Name!', version: '1.0.0' }] })).toBeNull();
    expect(ctx.breaker.tripped).toBeNull();
    expect(await evidenceCheckJ2(ctx, claims(2))).not.toBeNull();
    expect(mock.requests).toHaveLength(2);
  });
});
