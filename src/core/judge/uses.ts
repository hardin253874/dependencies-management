/**
 * J1–J8 (V2_STAGE5_SPEC 5b.10–5b.15): one helper per judgment. Each builds
 * its payload with the class from `USE_CLASS`, asks through `Judge.tryAsk`
 * (guard → cache → ledger), and interprets the answers. None throws: a
 * refusal or outage returns `null` and the call site keeps today's output.
 *
 * Thresholds are the docs' starting bands (confidence.md): Noul 0.7 yes /
 * 0.3 no; Choice confidence < 0.5 → do not act.
 */
import { choice, noul, score } from '@typesafe-ai/sdk';
import type { Question } from '@typesafe-ai/sdk';
import type { Judge } from './judge';
import { JEV_TIMEOUT_MS, JEV_USE_DEADLINE_MS } from './constants';
import { capSnippet, metadataPayload, publicTextPayload, REQUEST_MAX_BOUND_TOKENS, requestBoundTokens, sourcePayload, type SourceSnippet } from './payload';
import { JudgePrivacyError, type ChoiceAnswer, type JudgeAnswer, type JudgePayload, type JudgeSubject, type JudgeUse } from './types';

export interface JudgeContext {
  judge: Judge;
  subject: JudgeSubject;
  signal?: AbortSignal;
  /**
   * Shared by every request made with this context (the app builds one
   * context per use per job). Without one, each helper call gets its own.
   */
  breaker?: JudgeBreaker;
}

/**
 * Per-job circuit breaker + overall deadline (review 5b M2). The first
 * `unavailable` answer (timeout, network, 5xx, no key, abort) trips it and
 * every later ask on the same breaker returns "not answered" without a
 * request. The deadline clock starts at the first ask; each request's
 * timeout is capped by what is left, so N items against a hanging Jev wait
 * one timeout, not N. Refusals (privacy) do not trip it: they are per item.
 */
export interface JudgeBreaker {
  readonly deadlineMs: number;
  startedAt: number | null;
  /** The reason it tripped, or `null` while closed. */
  tripped: string | null;
}

export function createJudgeBreaker(deadlineMs: number = JEV_USE_DEADLINE_MS): JudgeBreaker {
  return { deadlineMs, startedAt: null, tripped: null };
}

function breakerOf(ctx: JudgeContext): JudgeBreaker {
  return ctx.breaker ?? createJudgeBreaker();
}

export const NOUL_YES = 0.7;
export const NOUL_NO = 0.3;
export const CHOICE_MIN_CONFIDENCE = 0.5;

type Built = { payload: JudgePayload; questions: Record<string, Question> };

/** One request; a payload-builder refusal, an open breaker or a spent deadline count as "not answered". */
async function askOnce(ctx: JudgeContext, use: JudgeUse, build: () => Built, breaker: JudgeBreaker): Promise<Record<string, JudgeAnswer> | null> {
  if (breaker.tripped !== null) return null;
  const now = Date.now();
  if (breaker.startedAt === null) breaker.startedAt = now;
  const left = breaker.deadlineMs - (now - breaker.startedAt);
  if (left <= 0) {
    breaker.tripped = 'deadline';
    return null;
  }
  let built: Built;
  try {
    built = build();
  } catch (err) {
    if (err instanceof JudgePrivacyError) return null;
    throw err;
  }
  const res = await ctx.judge.tryAsk({
    use,
    payload: built.payload,
    questions: built.questions,
    subject: ctx.subject,
    timeoutMs: Math.min(JEV_TIMEOUT_MS, left),
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {})
  });
  if (!res.ok && res.kind === 'unavailable') breaker.tripped = res.reason;
  return res.ok ? res.result.answers : null;
}

/** Splits items into batches whose serialized request stays under the token bound. */
export function batchByBound<T>(items: readonly T[], sizeOf: (batch: readonly T[]) => number, bound = REQUEST_MAX_BOUND_TOKENS): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  for (const it of items) {
    const next = [...cur, it];
    if (cur.length > 0 && sizeOf(next) > bound) {
      out.push(cur);
      cur = [it];
    } else {
      cur = next;
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

function asChoice(a: JudgeAnswer | undefined): ChoiceAnswer | null {
  return a !== undefined && a.type === 'choice' ? a : null;
}

// ---------------------------------------------------------------- J1 ------

export const J1_LEVELS = ['unaffected', 'unlikely', 'possible', 'likely', 'certain'] as const;
const J1_CRITERIA = [
  'unaffected: the file does not use anything the upgrade or advisory changes',
  'unlikely: the file uses the package but probably not the changed parts',
  'possible: the file may use changed parts',
  'likely: the file probably uses changed parts and needs review',
  'certain: the file clearly uses removed or changed API and must change'
] as const;

export interface J1File {
  path: string;
  snippet: string;
}

function j1Questions(files: readonly J1File[]): Record<string, Question> {
  const q: Record<string, Question> = {};
  files.forEach((f, i) => {
    q[`f${i}`] = score(`How likely is the code in snippet ${i} (file ${f.path}) affected by this upgrade?`, J1_CRITERIA);
  });
  return q;
}

/**
 * J1: orders files by Jev's expected impact score (desc); ties and files Jev
 * did not score keep their input order. Returns `null` when nothing was
 * scored (refused / outage): the caller keeps the input order.
 */
export async function rankFilesJ1(
  ctx: JudgeContext,
  input: { pkg: string; from: string; to: string; breakingChanges?: readonly string[]; files: readonly J1File[] }
): Promise<{ order: string[]; scores: Record<string, number> } | null> {
  if (input.files.length === 0) return null;
  const meta = { package: input.pkg, from: input.from, to: input.to };
  const known = (input.breakingChanges ?? []).slice(0, 20).join('\n');
  const build = (batch: readonly J1File[]): Built => ({
    payload: sourcePayload({ meta, ...(known !== '' ? { publicText: { breakingChanges: known } } : {}), snippets: batch.map((f): SourceSnippet => ({ path: f.path, text: f.snippet })) }),
    questions: j1Questions(batch)
  });
  const capped = input.files.map((f) => ({ path: f.path, snippet: capSnippet(f.snippet) }));
  const batches = batchByBound(capped, (b) => {
    const { payload, questions } = build(b);
    return requestBoundTokens(ctx.judge.model, payload.state, questions);
  });
  const scores: Record<string, number> = {};
  const breaker = breakerOf(ctx);
  for (const batch of batches) {
    const answers = await askOnce(ctx, 'J1', () => build(batch), breaker);
    if (answers === null) continue;
    batch.forEach((f, i) => {
      const a = answers[`f${i}`];
      if (a !== undefined && a.type === 'score') scores[f.path] = a.score;
    });
  }
  if (Object.keys(scores).length === 0) return null;
  const indexed = input.files.map((f, i) => ({ path: f.path, i, s: scores[f.path] ?? -1 }));
  indexed.sort((a, b) => b.s - a.s || a.i - b.i);
  return { order: indexed.map((x) => x.path), scores };
}

// ---------------------------------------------------------------- J2 ------

export type ClaimSupport = 'low' | 'unclear';

export interface J2Claim {
  id: string;
  /** The report's claim (LLM output text). */
  claim: string;
  evidence: readonly SourceSnippet[];
}

export function supportFromNoul(p: number): ClaimSupport | null {
  if (p < NOUL_NO) return 'low';
  if (p < NOUL_YES) return 'unclear';
  return null;
}

/** J2: one Noul per claim (one request per claim: each claim carries its own evidence). Flags only; nothing is removed. */
export async function evidenceCheckJ2(ctx: JudgeContext, claims: readonly J2Claim[]): Promise<Map<string, { support: ClaimSupport | null; noul: number }> | null> {
  const out = new Map<string, { support: ClaimSupport | null; noul: number }>();
  const breaker = breakerOf(ctx);
  for (const c of claims) {
    const answers = await askOnce(ctx, 'J2', () => ({
      payload: sourcePayload({ publicText: { claim: c.claim }, snippets: c.evidence.length > 0 ? c.evidence : [] }),
      questions: { supported: noul('Does the cited code evidence support the claim?') }
    }), breaker);
    const a = answers?.supported;
    if (a !== undefined && a.type === 'noul') out.set(c.id, { support: supportFromNoul(a.noul), noul: a.noul });
  }
  return out.size > 0 ? out : null;
}

// ---------------------------------------------------------------- J3 ------

export const J3_LABELS = ['not-affected', 'likely-affected', 'inconclusive'] as const;
export type J3Verdict = (typeof J3_LABELS)[number];

export async function triageCvesJ3(
  ctx: JudgeContext,
  input: { cves: ReadonlyArray<{ id: string; advisory: string }>; snippets: readonly SourceSnippet[] }
): Promise<Map<string, { verdict: J3Verdict; confidence: number }> | null> {
  const out = new Map<string, { verdict: J3Verdict; confidence: number }>();
  const breaker = breakerOf(ctx);
  for (const cve of input.cves) {
    const answers = await askOnce(ctx, 'J3', () => ({
      payload: sourcePayload({ publicText: { advisory: cve.advisory }, snippets: input.snippets }),
      questions: {
        verdict: choice('Given the advisory and the project code that uses the package, is the project affected by this vulnerability?', {
          'not-affected': 'The code does not use the vulnerable function or pattern.',
          'likely-affected': 'The code uses the vulnerable function or pattern.',
          inconclusive: 'The evidence is not enough to decide.'
        })
      }
    }), breaker);
    const a = asChoice(answers?.verdict);
    if (a === null) continue;
    const verdict = (a.confidence < CHOICE_MIN_CONFIDENCE ? 'inconclusive' : a.choice) as J3Verdict;
    if ((J3_LABELS as readonly string[]).includes(verdict)) out.set(cve.id, { verdict, confidence: a.confidence });
  }
  return out.size > 0 ? out : null;
}

// ---------------------------------------------------------------- J4 ------

export const J4_MAX_CANDIDATES = 50;

/** Similarity for the deterministic top-50 cut: shared-prefix + bigram Dice, by name. */
export function nameSimilarity(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return 1;
  const grams = (s: string) => {
    const g: string[] = [];
    for (let i = 0; i < s.length - 1; i += 1) g.push(s.slice(i, i + 2));
    return g;
  };
  const gx = grams(x);
  const gy = grams(y);
  if (gx.length === 0 || gy.length === 0) return 0;
  let hit = 0;
  const pool = [...gy];
  for (const g of gx) {
    const k = pool.indexOf(g);
    if (k >= 0) {
      hit += 1;
      pool.splice(k, 1);
    }
  }
  return (2 * hit) / (gx.length + gy.length);
}

export function topCandidates(removed: string, added: ReadonlyArray<{ name: string; signature: string }>, max = J4_MAX_CANDIDATES): Array<{ name: string; signature: string }> {
  return [...added]
    .map((a) => ({ a, s: nameSimilarity(removed, a.name) }))
    .sort((p, q) => q.s - p.s || (p.a.name < q.a.name ? -1 : p.a.name > q.a.name ? 1 : 0))
    .slice(0, max)
    .map((p) => p.a);
}

export const J4_NONE = '__none__';

/** J4: one Choice per removed export over up to 50 added exports + none. */
export async function renameCandidatesJ4(
  ctx: JudgeContext,
  input: { pkg: string; removed: ReadonlyArray<{ name: string; signature: string }>; added: ReadonlyArray<{ name: string; signature: string }> }
): Promise<Array<{ from: string; to: string; confidence: number; source: 'jev' }> | null> {
  if (input.removed.length === 0 || input.added.length === 0) return null;
  const out: Array<{ from: string; to: string; confidence: number; source: 'jev' }> = [];
  let answered = false;
  const breaker = breakerOf(ctx);
  for (const r of input.removed) {
    const cands = topCandidates(r.name, input.added);
    const criteria: Record<string, string> = { [J4_NONE]: 'None of the added exports replaces it.' };
    for (const c of cands) criteria[c.name] = c.signature.slice(0, 400);
    const answers = await askOnce(ctx, 'J4', () => ({
      payload: publicTextPayload({ meta: { package: input.pkg }, text: { removedSignature: `${r.name}: ${r.signature}` } }),
      questions: { replacement: choice('Which added export (if any) is the renamed replacement of the removed export?', criteria) }
    }), breaker);
    const a = asChoice(answers?.replacement);
    if (a === null) continue;
    answered = true;
    if (a.choice !== J4_NONE && a.confidence >= CHOICE_MIN_CONFIDENCE && cands.some((c) => c.name === a.choice)) {
      out.push({ from: r.name, to: a.choice, confidence: a.confidence, source: 'jev' });
    }
  }
  return answered ? out : null;
}

// ---------------------------------------------------------------- J5 ------

/** J5: one Noul per direct dep, all in one request (fan-out over one metadata state). */
export async function coUpgradeJ5(
  ctx: JudgeContext,
  input: { target: string; from: string; to: string; deps: ReadonlyArray<{ name: string; version: string | null }> }
): Promise<Array<{ name: string; noul: number }> | null> {
  const deps = input.deps.filter((d) => d.name !== input.target).slice(0, 200);
  if (deps.length === 0) return null;
  const questions: Record<string, Question> = {};
  deps.forEach((d, i) => {
    questions[`d${i}`] = noul(`Is dependency number ${i} in the list usually upgraded together with the target package?`);
  });
  const answers = await askOnce(ctx, 'J5', () => ({
    payload: metadataPayload({ target: input.target, from: input.from, to: input.to, deps: deps.map((d) => ({ name: d.name, version: d.version })) }),
    questions
  }), breakerOf(ctx));
  if (answers === null) return null;
  const out: Array<{ name: string; noul: number }> = [];
  deps.forEach((d, i) => {
    const a = answers[`d${i}`];
    if (a !== undefined && a.type === 'noul' && a.noul >= NOUL_YES) out.push({ name: d.name, noul: a.noul });
  });
  return out;
}

// ---------------------------------------------------------------- J6 ------

export type J6Action = 'keep' | 'upgrade' | 'investigate';
export type J6Bump = 'patch' | 'minor' | 'major' | 'none';

/** J6: for deps whose range did not parse: action + bump. Confidence < 0.5 keeps `investigate`. */
export async function relatedUnknownJ6(
  ctx: JudgeContext,
  input: { viewedDep: string; from: string; to: string; deps: ReadonlyArray<{ name: string; version: string | null }> }
): Promise<Map<string, { action: J6Action; bump: J6Bump | null; confidence: number }> | null> {
  if (input.deps.length === 0) return null;
  const questions: Record<string, Question> = {};
  input.deps.forEach((_, i) => {
    questions[`a${i}`] = choice(`For related dependency number ${i}: keep it, upgrade it, or investigate?`, { keep: 'Keep the current version.', upgrade: 'Upgrade it with the target.', investigate: 'Needs a closer look.' });
    questions[`b${i}`] = choice(`For related dependency number ${i}: which version bump does it likely need?`, { patch: null, minor: null, major: null, none: null });
  });
  const answers = await askOnce(ctx, 'J6', () => ({
    payload: metadataPayload({ target: input.viewedDep, from: input.from, to: input.to, deps: input.deps.map((d) => ({ name: d.name, version: d.version })) }),
    questions
  }), breakerOf(ctx));
  if (answers === null) return null;
  const out = new Map<string, { action: J6Action; bump: J6Bump | null; confidence: number }>();
  input.deps.forEach((d, i) => {
    const a = asChoice(answers[`a${i}`]);
    if (a === null) return;
    const b = asChoice(answers[`b${i}`]);
    const confident = a.confidence >= CHOICE_MIN_CONFIDENCE;
    out.set(d.name, {
      action: confident ? (a.choice as J6Action) : 'investigate',
      bump: b !== null && b.confidence >= CHOICE_MIN_CONFIDENCE ? (b.choice as J6Bump) : null,
      confidence: a.confidence
    });
  });
  return out;
}

// ---------------------------------------------------------------- J7 ------

export const J7_BANDS = ['low', 'medium', 'high', 'critical'] as const;
export type J7Band = (typeof J7_BANDS)[number];

export function bandFromScore(s: number): J7Band {
  const i = Math.min(J7_BANDS.length - 1, Math.max(0, Math.round(s)));
  return J7_BANDS[i]!;
}

/** J7: one Score over the public advisory text. */
export async function estimateSeverityJ7(ctx: JudgeContext, input: { id: string; summary: string; details?: string }): Promise<{ band: J7Band; score: number; confidence: number } | null> {
  const answers = await askOnce(ctx, 'J7', () => ({
    payload: publicTextPayload({ text: { summary: input.summary, details: input.details ?? '' } }),
    questions: {
      severity: score('How severe is this security advisory?', [
        'low: limited impact or hard to exploit',
        'medium: moderate impact or needs user interaction',
        'high: serious impact, easy to exploit',
        'critical: remote, unauthenticated, full compromise'
      ])
    }
  }), breakerOf(ctx));
  const a = answers?.severity;
  if (a === undefined || a.type !== 'score') return null;
  return { band: bandFromScore(a.score), score: a.score, confidence: a.confidence };
}

// ---------------------------------------------------------------- J8 ------

export type J8Suggestion = 'found' | 'partial' | 'missed';

/** J8 (eval only): one Choice per golden finding over the public report text. A suggestion; the human mark stays required. */
export async function suggestFindingsJ8(
  ctx: JudgeContext,
  input: { reportText: string; findings: ReadonlyArray<{ id: string; text: string }> }
): Promise<Map<string, J8Suggestion> | null> {
  if (input.findings.length === 0) return null;
  const questions: Record<string, Question> = {};
  const text: Record<string, string> = { report: input.reportText };
  input.findings.forEach((f, i) => {
    text[`finding${i}`] = f.text;
    questions[`g${i}`] = choice(`Does the report cover finding${i}?`, { found: 'Fully covered.', partial: 'Partly covered.', missed: 'Not covered.' });
  });
  const answers = await askOnce(ctx, 'J8', () => ({ payload: publicTextPayload({ text }), questions }), breakerOf(ctx));
  if (answers === null) return null;
  const out = new Map<string, J8Suggestion>();
  input.findings.forEach((f, i) => {
    const a = asChoice(answers[`g${i}`]);
    if (a !== null) out.set(f.id, a.choice as J8Suggestion);
  });
  return out;
}
