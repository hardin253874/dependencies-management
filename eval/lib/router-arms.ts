/**
 * Offline router arms (V2_STAGE5_SPEC 5b.16 / 5c.3). Never calls Claude: the
 * arm results are the CHOSEN model's phase result from existing per-model
 * `run --predictor v2-agent` result files.
 *
 * Arms: always-Opus, always-Sonnet, rules-only, rules+Jev. Rules come from
 * the core router (`routeRules`) over facts built offline from the case
 * metadata and the Sonnet file's `agent.impact.base` (the graph base-set
 * size; identical across models because it is graph-derived). `apiDiff` and
 * `cveCount` are not available offline → null / 0 (recorded in the output).
 * rules+Jev: unclear phases take the cached Jev answer for the exact router
 * request (`--jev-cache`), else the configured model (`default`). The
 * producer is `eval judge --use router` (`askRouterJev` below): same phase
 * facts, asks only the unclear phases through a `Judge` whose `JudgeCache`
 * writes `<dir>/<routerCacheKey>.json` (review 5b M3).
 *
 * Arm cost = sum of the chosen runs' `agent.costUsd` (+ Jev cost from the
 * cached usage). D28 ship check, computed for the full set AND the confirmed
 * subset (Q-5.1): recall within 2 points of always-Opus at ≥ 30 % lower cost.
 */
import { promises as fs } from 'fs';
import path from 'path';
// Relative imports on purpose (vite-node has no `@/` alias).
import { decisionFromJev, defaultDecision, OPUS, routeModel, routeRules, routerPayloadState, routerQuestions, SONNET, HAIKU, type RouterDecision, type RouterFacts, type RouterJump } from '../../src/core/llm/router';
import type { Judge } from '../../src/core/judge/judge';
import { judgeCacheKey, type CachedJudgeAnswer } from '../../src/core/judge/cache';
import { metadataPayload } from '../../src/core/judge/payload';
import { JEV_MODEL } from '../../src/core/judge/constants';
import { JEV_PRICES } from '../../src/core/judge/ledger';
import type { LoadedCase, PhaseResult, PrecisionRecall, ResultFile } from './types';

export type ArmId = 'always-opus' | 'always-sonnet' | 'rules-only' | 'rules+jev';
export const ARMS: readonly ArmId[] = ['always-opus', 'always-sonnet', 'rules-only', 'rules+jev'];
export const SHIP_RECALL_POINTS = 0.02;
export const SHIP_MIN_SAVING = 0.3;

export class RouterArmsError extends Error {}

export function jumpOfPhase(packages: ReadonlyArray<{ from: string | null; to: string | null }>): RouterJump {
  const rank: Record<RouterJump, number> = { none: 0, patch: 1, minor: 2, add: 3, remove: 3, major: 4 };
  let best: RouterJump = 'none';
  for (const p of packages) {
    const j = jumpOne(p.from, p.to);
    if (rank[j] > rank[best]) best = j;
  }
  return best;
}

function jumpOne(from: string | null, to: string | null): RouterJump {
  if (from === null && to !== null) return 'add';
  if (from !== null && to === null) return 'remove';
  const parse = (v: string | null) => (v ?? '').replace(/^[^0-9]*/, '').split('.').map((x) => Number.parseInt(x, 10));
  const a = parse(from);
  const b = parse(to);
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return 'major';
  if ((a[0] ?? 0) !== (b[0] ?? 0)) return 'major';
  if ((a[1] ?? 0) !== (b[1] ?? 0)) return 'minor';
  if ((a[2] ?? 0) !== (b[2] ?? 0)) return 'patch';
  return 'none';
}

export function phaseFacts(packages: ReadonlyArray<{ from: string | null; to: string | null }>, baseFiles: number, configuredModel: string): RouterFacts {
  return { view: 'agent', jump: jumpOfPhase(packages), packageCount: packages.length, graphFileCount: baseFiles, apiDiff: null, cveCount: 0, configuredModel };
}

/** The cache key the app / `eval judge` would use for this router request. */
export function routerCacheKey(facts: RouterFacts): string {
  return judgeCacheKey({ use: 'router', model: JEV_MODEL, state: metadataPayload(routerPayloadState(facts)).state, questions: routerQuestions() });
}

export type JevLookup = (facts: RouterFacts) => Promise<CachedJudgeAnswer | null>;

export function jevCacheLookup(dir: string): JevLookup {
  return async (facts) => {
    try {
      const env = JSON.parse(await fs.readFile(path.join(dir, `${routerCacheKey(facts)}.json`), 'utf8')) as { data?: CachedJudgeAnswer };
      return env.data ?? null;
    } catch {
      return null;
    }
  };
}

interface Picked {
  tp: number;
  predicted: number;
  truth: number;
  subsetTp: number;
  subsetPredicted: number;
  costUsd: number;
  complex: boolean;
}

interface Totals {
  tp: number;
  predicted: number;
  truth: number;
  subsetTp: number;
  subsetPredicted: number;
  costUsd: number;
}

function pr(tp: number, predicted: number, truth: number): PrecisionRecall {
  return { precision: predicted === 0 ? null : tp / predicted, recall: truth === 0 ? null : tp / truth };
}

export interface ArmResult {
  arm: ArmId;
  phases: number;
  models: Record<string, number>;
  full: { overall: PrecisionRecall; complex: PrecisionRecall };
  subset: { overall: PrecisionRecall; complex: PrecisionRecall };
  costUsd: number;
  jevCostUsd: number;
  jevRequests: number;
  decisions: Array<{ caseId: string; phaseId: string; model: string; via: RouterDecision['via']; reason: string }>;
}

export interface ShipCheck {
  arm: ArmId;
  set: 'full' | 'subset';
  recallDeltaPoints: number | null;
  costSaving: number | null;
  met: boolean;
}

export interface RouterArmsResult {
  kind: 'router-arms';
  label: string;
  generatedAt: string;
  visibility: 'public';
  inputs: { opus: string; sonnet: string; haiku: string; jevCache: string | null; configuredModel: string };
  notes: string[];
  arms: ArmResult[];
  shipCheck: ShipCheck[];
}

function phaseIndex(file: ResultFile): Map<string, PhaseResult> {
  const m = new Map<string, PhaseResult>();
  for (const c of file.cases) {
    if (c.status !== 'ok') continue;
    for (const p of c.phases) if (p.status !== 'skipped') m.set(`${c.id}::${p.id}`, p);
  }
  return m;
}

function pickFrom(p: PhaseResult, complex: boolean): Picked {
  return {
    tp: p.tp,
    predicted: p.predictedCount,
    truth: p.truthCount,
    subsetTp: p.agent?.subset?.tp ?? 0,
    subsetPredicted: p.agent?.subset?.predictedCount ?? 0,
    costUsd: p.agent?.costUsd ?? 0,
    complex
  };
}

export interface RouterPhase {
  key: string;
  caseId: string;
  phaseId: string;
  facts: RouterFacts;
}

/**
 * The case x phase list both `router-arms` and its Jev producer walk: phases
 * ok in all three result files, facts from the case metadata + the Sonnet
 * file's graph base size. Refuses non-agent / non-public files and private cases.
 */
export function routerPhases(opts: { cases: readonly LoadedCase[]; files: { opus: ResultFile; sonnet: ResultFile; haiku: ResultFile }; configuredModel: string }): { phases: RouterPhase[]; idx: Record<string, Map<string, PhaseResult>> } {
  for (const [k, f] of Object.entries(opts.files)) {
    if (f.predictor !== 'v2-agent') throw new RouterArmsError(`--${k} is a ${f.predictor} result; router arms need v2-agent results`);
    if (f.visibility !== 'public') throw new RouterArmsError(`--${k} is not a public result file`);
  }
  const idx = { [OPUS]: phaseIndex(opts.files.opus), [SONNET]: phaseIndex(opts.files.sonnet), [HAIKU]: phaseIndex(opts.files.haiku) } as Record<string, Map<string, PhaseResult>>;
  const keys = [...idx[SONNET]!.keys()].filter((k) => idx[OPUS]!.has(k) && idx[HAIKU]!.has(k)).sort();
  if (keys.length === 0) throw new RouterArmsError('no case × phase is ok in all three result files');
  const phases = keys.map((key): RouterPhase => {
    const [caseId, phaseId] = key.split('::') as [string, string];
    const c = opts.cases.find((x) => x.id === caseId);
    const phase = c?.phases.find((p) => p.id === phaseId);
    if (c === undefined || phase === undefined) throw new RouterArmsError(`case ${caseId} phase ${phaseId} is not in the corpus`);
    if (c.visibility !== 'public') throw new RouterArmsError(`case ${caseId} is private`);
    const sonnetPhase = idx[SONNET]!.get(key)!;
    return { key, caseId, phaseId, facts: phaseFacts(phase.packages, sonnetPhase.agent?.impact?.base ?? sonnetPhase.predictedCount, opts.configuredModel) };
  });
  return { phases, idx };
}

export async function computeRouterArms(opts: {
  label: string;
  now: Date;
  cases: readonly LoadedCase[];
  files: { opus: ResultFile; sonnet: ResultFile; haiku: ResultFile };
  inputNames: { opus: string; sonnet: string; haiku: string; jevCache: string | null };
  configuredModel?: string;
  jev?: JevLookup;
}): Promise<RouterArmsResult> {
  const configured = opts.configuredModel ?? OPUS;
  const { phases, idx } = routerPhases({ cases: opts.cases, files: opts.files, configuredModel: configured });
  const keys = phases.map((p) => p.key);
  const arms: ArmResult[] = [];
  for (const arm of ARMS) {
    const t: Totals = { tp: 0, predicted: 0, truth: 0, subsetTp: 0, subsetPredicted: 0, costUsd: 0 };
    const tc: Totals = { ...t };
    const models: Record<string, number> = {};
    const decisions: ArmResult['decisions'] = [];
    let jevCost = 0;
    let jevRequests = 0;
    for (const { key, caseId, phaseId, facts } of phases) {
      let decision: RouterDecision;
      if (arm === 'always-opus') decision = { model: OPUS, effort: 'medium', via: 'rule', reason: 'always Opus' };
      else if (arm === 'always-sonnet') decision = { model: SONNET, effort: 'medium', via: 'rule', reason: 'always Sonnet' };
      else {
        const r = routeRules(facts);
        if ('decision' in r) decision = r.decision;
        else if (arm === 'rules-only') decision = defaultDecision(facts, 'unclear by rules (rules-only arm)');
        else {
          const cached = opts.jev !== undefined ? await opts.jev(facts) : null;
          const answer = cached?.answers.difficulty;
          const d = answer !== undefined && answer.type === 'choice' ? decisionFromJev(facts, answer, { model: cached!.model, cached: true, latencyMs: cached!.latencyMs }) : null;
          decision = d ?? defaultDecision(facts, 'unclear by rules; no cached Jev answer');
          if (cached !== null) {
            jevRequests += 1;
            jevCost += (cached.usage.inputTokens ?? 0) * (JEV_PRICES[cached.model] ?? JEV_PRICES[JEV_MODEL]!);
          }
        }
      }
      const res = idx[decision.model] ?? idx[configured];
      const phaseRes = res?.get(key);
      if (phaseRes === undefined) throw new RouterArmsError(`no result for model ${decision.model} on ${key}`);
      const complex = phaseRes.tags.includes('complex');
      const p = pickFrom(phaseRes, complex);
      for (const acc of complex ? [t, tc] : [t]) {
        acc.tp += p.tp;
        acc.predicted += p.predicted;
        acc.truth += p.truth;
        acc.subsetTp += p.subsetTp;
        acc.subsetPredicted += p.subsetPredicted;
        acc.costUsd += p.costUsd;
      }
      models[decision.model] = (models[decision.model] ?? 0) + 1;
      decisions.push({ caseId, phaseId, model: decision.model, via: decision.via, reason: decision.reason });
    }
    arms.push({
      arm,
      phases: keys.length,
      models,
      full: { overall: pr(t.tp, t.predicted, t.truth), complex: pr(tc.tp, tc.predicted, tc.truth) },
      subset: { overall: pr(t.subsetTp, t.subsetPredicted, t.truth), complex: pr(tc.subsetTp, tc.subsetPredicted, tc.truth) },
      costUsd: round9(t.costUsd + jevCost),
      jevCostUsd: round9(jevCost),
      jevRequests,
      decisions
    });
  }
  return {
    kind: 'router-arms',
    label: opts.label,
    generatedAt: opts.now.toISOString(),
    visibility: 'public',
    inputs: { ...opts.inputNames, configuredModel: configured },
    notes: ['facts offline: apiDiff = null and cveCount = 0 (not in the result files); graphFileCount = Sonnet agent.impact.base', 'n = 1 run per case × model: arm differences under ~10 points on one case are noise'],
    arms,
    shipCheck: shipChecks(arms)
  };
}

/** 9 decimals: Jev costs are in the micro-dollar range. */
function round9(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}

/** D28 as written: recall within 2 points of always-Opus at ≥ 30 % lower cost (overall micro). */
export function shipChecks(arms: readonly ArmResult[]): ShipCheck[] {
  const opus = arms.find((a) => a.arm === 'always-opus');
  if (opus === undefined) return [];
  const out: ShipCheck[] = [];
  for (const arm of arms.filter((a) => a.arm === 'rules-only' || a.arm === 'rules+jev')) {
    for (const set of ['full', 'subset'] as const) {
      const ro = opus[set].overall.recall;
      const ra = arm[set].overall.recall;
      const delta = ro === null || ra === null ? null : Math.round((ro - ra) * 1e6) / 1e6;
      const saving = opus.costUsd > 0 ? Math.round((1 - arm.costUsd / opus.costUsd) * 1e6) / 1e6 : null;
      out.push({ arm: arm.arm, set, recallDeltaPoints: delta, costSaving: saving, met: delta !== null && saving !== null && delta <= SHIP_RECALL_POINTS && saving >= SHIP_MIN_SAVING });
    }
  }
  return out;
}

// ------------------------------------------------------- Jev producer -----

/** 5c.3: at most 5 router requests per run (metadata payloads). */
export const ROUTER_JEV_MAX_REQUESTS = 5;

export interface RouterJevAsk {
  caseId: string;
  phaseId: string;
  key: string;
  model: string;
  via: RouterDecision['via'];
  reason: string;
  cached: boolean | null;
  latencyMs: number | null;
}

export interface RouterJevResult {
  kind: 'router-jev';
  label: string;
  generatedAt: string;
  visibility: 'public';
  client: 'mock' | 'typesafe';
  /** The `--jev-cache` dir for `router-arms`. */
  jevCache: string;
  inputs: { opus: string; sonnet: string; haiku: string; configuredModel: string };
  maxRequests: number;
  /** Phases the rules decide (never asked). */
  rulesDecided: number;
  asked: RouterJevAsk[];
  skipped: Array<{ caseId: string; phaseId: string; reason: string }>;
}

/**
 * Asks Jev ONLY for the phases `routeRules` leaves unclear, through the one
 * app path (`routeModel` → `Judge.tryAsk` → guard → cache → client), so the
 * answers land in the judge's `JudgeCache` under exactly `routerCacheKey`.
 * Distinct keys are capped at `maxRequests`; the rest are skipped (and fall
 * back to `default` in `router-arms`). A failed ask is not cached (the arm
 * then uses `default` for it too).
 */
export async function askRouterJev(opts: {
  label: string;
  now: Date;
  cases: readonly LoadedCase[];
  files: { opus: ResultFile; sonnet: ResultFile; haiku: ResultFile };
  inputNames: { opus: string; sonnet: string; haiku: string };
  configuredModel?: string;
  judge: Judge;
  client: 'mock' | 'typesafe';
  jevCache: string;
  maxRequests?: number;
}): Promise<RouterJevResult> {
  const configured = opts.configuredModel ?? OPUS;
  const max = opts.maxRequests ?? ROUTER_JEV_MAX_REQUESTS;
  const { phases } = routerPhases({ cases: opts.cases, files: opts.files, configuredModel: configured });
  const asked: RouterJevAsk[] = [];
  const skipped: RouterJevResult['skipped'] = [];
  const keys = new Set<string>();
  let rulesDecided = 0;
  for (const p of phases) {
    if ('decision' in routeRules(p.facts)) {
      rulesDecided += 1;
      continue;
    }
    const key = routerCacheKey(p.facts);
    if (!keys.has(key) && keys.size >= max) {
      skipped.push({ caseId: p.caseId, phaseId: p.phaseId, reason: `over the ${max}-request cap` });
      continue;
    }
    keys.add(key);
    const d = await routeModel(p.facts, { judge: opts.judge, subject: { privacy: 'public' } });
    asked.push({ caseId: p.caseId, phaseId: p.phaseId, key, model: d.model, via: d.via, reason: d.reason, cached: d.jev?.cached ?? null, latencyMs: d.jev?.latencyMs ?? null });
  }
  return {
    kind: 'router-jev',
    label: opts.label,
    generatedAt: opts.now.toISOString(),
    visibility: 'public',
    client: opts.client,
    jevCache: opts.jevCache,
    inputs: { ...opts.inputNames, configuredModel: configured },
    maxRequests: max,
    rulesDecided,
    asked,
    skipped
  };
}
