/**
 * Model router (D28, proposed; V2_STAGE5_SPEC 5b.6 / 5b.7).
 *
 * Step 1 — rules in code (no Jev): clear cases go straight to a model.
 * Step 2 — Jev for the unclear cases: one `choice` over METADATA ONLY
 * (`RouterFacts`), easy → Haiku, moderate → Sonnet, hard → Opus; low
 * confidence or low probability → one step stronger.
 * Any refusal / outage / timeout / ledger refusal / no key / switch off →
 * the configured model with `via: 'default'`. Never throws to the caller.
 * Private or unknown-privacy projects: rules only.
 *
 * Rule constants are the spec's initial proposals (tuned only from the 5c
 * offline arms, and recorded there; Q-5.7).
 */
import { choice } from '@typesafe-ai/sdk';
import { MODEL_OPTIONS } from '../../lib/llm/models';
import { VIEW_EFFORT, type LlmEffort } from '../../lib/llm/effort';
import { metadataPayload } from '../judge/payload';
import { ROUTER_TIMEOUT_MS } from '../judge/client';
import { judgeAllowedFor } from '../judge/privacy';
import type { Judge } from '../judge/judge';
import type { ChoiceAnswer, JudgeSubject } from '../judge/types';

export type RouterView = 'update-report' | 'deep-report' | 'file-review' | 'agent';
export type RouterJump = 'major' | 'minor' | 'patch' | 'none' | 'add' | 'remove';

/** Metadata only: numbers and enums. No paths, no source text (5b.6). */
export interface RouterFacts {
  view: RouterView;
  jump: RouterJump;
  packageCount: number;
  /** Size of the graph base impacted set. */
  graphFileCount: number;
  /** Only when already cached; the router never fetches it. */
  apiDiff: { removed: number; signatureChanged: number } | null;
  cveCount: number;
  configuredModel: string;
}

export interface RouterDecision {
  model: string;
  effort: LlmEffort;
  via: 'rule' | 'jev' | 'default';
  reason: string;
  jev?: { choice: string; confidence: number; probability: number; model: string; cached: boolean; latencyMs: number };
}

export const ROUTER_RULES = Object.freeze({
  easyMaxFiles: 20,
  hardMinFiles: 200,
  hardMinPackages: 3,
  hardMinRemovedExports: 10
});
export const ROUTER_MIN_CONFIDENCE = 0.5;
export const ROUTER_MIN_PROBABILITY = 0.6;

export const HAIKU = 'claude-haiku-5-5';
export const SONNET = 'claude-sonnet-5-5';
export const OPUS = 'claude-opus-5-5';
/** Weakest → strongest. Fable 5.1 is never routed to (5b.6). */
export const ROUTER_LADDER: readonly string[] = Object.freeze([HAIKU, SONNET, OPUS]);

export function routerCandidates(): string[] {
  return MODEL_OPTIONS.anthropic.filter((m) => m !== 'claude-fable-5-1');
}

const MODEL_LABEL: Readonly<Record<string, string>> = { [HAIKU]: 'Haiku 5.5', [SONNET]: 'Sonnet 5.5', [OPUS]: 'Opus 5.5' };
export function modelLabel(model: string): string {
  return MODEL_LABEL[model] ?? model;
}

export function effortFor(view: RouterView): LlmEffort {
  switch (view) {
    case 'update-report':
    case 'agent':
      return VIEW_EFFORT.updateReport;
    case 'deep-report':
      return VIEW_EFFORT.deepReport;
    case 'file-review':
      return VIEW_EFFORT.fileReview;
    default: {
      const never: never = view;
      throw new Error(`unknown router view ${String(never)}`);
    }
  }
}

function n(x: number): string {
  return x.toLocaleString('en-US');
}

export type RuleOutcome = { decision: RouterDecision } | { unclear: true; facts: RouterFacts };

/** Step 1 (pure). */
export function routeRules(facts: RouterFacts): RuleOutcome {
  const effort = effortFor(facts.view);
  if (facts.view === 'deep-report') {
    return { decision: { model: OPUS, effort, via: 'rule', reason: `deep report → ${modelLabel(OPUS)}` } };
  }
  if ((facts.jump === 'patch' || facts.jump === 'none') && facts.graphFileCount <= ROUTER_RULES.easyMaxFiles && facts.cveCount === 0) {
    return {
      decision: { model: HAIKU, effort, via: 'rule', reason: `${facts.jump} jump, ${n(facts.graphFileCount)} files, no CVEs → ${modelLabel(HAIKU)}` }
    };
  }
  if (facts.jump === 'major') {
    const why: string[] = [];
    if (facts.graphFileCount >= ROUTER_RULES.hardMinFiles) why.push(`${n(facts.graphFileCount)} files`);
    if (facts.packageCount >= ROUTER_RULES.hardMinPackages) why.push(`${facts.packageCount} packages`);
    if (facts.apiDiff !== null && facts.apiDiff.removed >= ROUTER_RULES.hardMinRemovedExports) why.push(`${facts.apiDiff.removed} removed exports`);
    if (why.length > 0) {
      return { decision: { model: OPUS, effort, via: 'rule', reason: `major jump, ${why.join(', ')} → ${modelLabel(OPUS)}` } };
    }
  }
  return { unclear: true, facts };
}

export function defaultDecision(facts: Pick<RouterFacts, 'view' | 'configuredModel'>, reason: string): RouterDecision {
  return { model: facts.configuredModel, effort: effortFor(facts.view), via: 'default', reason };
}

/** One step stronger on the ladder (Opus stays Opus). */
export function stepUp(model: string): string {
  const i = ROUTER_LADDER.indexOf(model);
  if (i < 0 || i === ROUTER_LADDER.length - 1) return model;
  return ROUTER_LADDER[i + 1]!;
}

export const ROUTER_QUESTION_NAME = 'difficulty';
export const ROUTER_CRITERIA = Object.freeze({
  easy: 'A small, low-risk upgrade: few files use the package, no known breaking API changes affect them; a fast model can assess it well.',
  moderate: 'A typical upgrade: some files and some API changes to check; needs a capable model.',
  hard: 'A large or risky upgrade: many files, many packages, removed or changed APIs; needs the strongest model.'
});
const DIFFICULTY_MODEL: Readonly<Record<keyof typeof ROUTER_CRITERIA, string>> = { easy: HAIKU, moderate: SONNET, hard: OPUS };

export function routerQuestions(): Record<string, ReturnType<typeof choice>> {
  return { [ROUTER_QUESTION_NAME]: choice('How hard is this upgrade to assess well?', { ...ROUTER_CRITERIA }) };
}

/** The exact metadata payload state the router sends (tests and the eval reuse it). */
export function routerPayloadState(facts: RouterFacts): Record<string, unknown> {
  return {
    view: facts.view,
    jump: facts.jump,
    packageCount: facts.packageCount,
    graphFileCount: facts.graphFileCount,
    apiDiff: facts.apiDiff,
    cveCount: facts.cveCount
  };
}

/** Maps a Jev answer to a decision (pure; used by the router and by the eval's rules+Jev arm). */
export function decisionFromJev(facts: RouterFacts, answer: ChoiceAnswer, meta: { model: string; cached: boolean; latencyMs: number }): RouterDecision | null {
  const label = answer.choice as keyof typeof ROUTER_CRITERIA;
  const target = DIFFICULTY_MODEL[label];
  if (target === undefined) return null;
  const probability = answer.probabilities[label] ?? 0;
  const low = answer.confidence < ROUTER_MIN_CONFIDENCE || probability < ROUTER_MIN_PROBABILITY;
  const model = low ? stepUp(target) : target;
  const conf = answer.confidence.toFixed(2);
  const reason = low
    ? `Jev: ${label} (confidence ${conf}, p ${probability.toFixed(2)}, low → one step up) → ${modelLabel(model)}`
    : `Jev: ${label} (confidence ${conf}) → ${modelLabel(model)}`;
  return {
    model,
    effort: effortFor(facts.view),
    via: 'jev',
    reason,
    jev: { choice: label, confidence: answer.confidence, probability, model: meta.model, cached: meta.cached, latencyMs: meta.latencyMs }
  };
}

/** Steps 1 + 2. Never throws. */
export async function routeModel(facts: RouterFacts, opts: { judge: Judge | null; subject: JudgeSubject; signal?: AbortSignal; allowJudge?: boolean }): Promise<RouterDecision> {
  const rules = routeRules(facts);
  if ('decision' in rules) return rules.decision;
  if (opts.allowJudge === false) return defaultDecision(facts, 'unclear by rules: Jev decides when the run starts');
  const judge = opts.judge;
  if (judge === null || !judge.switches.enabled || !judge.switches.router) return defaultDecision(facts, 'unclear by rules; router Jev off');
  if (!judgeAllowedFor('router', opts.subject, judge.switches)) {
    return defaultDecision(facts, opts.subject.judge === 'off' ? 'unclear by rules; Jev off for this project' : 'private project: rules only');
  }
  let payload;
  try {
    payload = metadataPayload(routerPayloadState(facts));
  } catch (err) {
    return defaultDecision(facts, `unclear by rules; router payload refused (${(err as Error).message})`);
  }
  const res = await judge.tryAsk({
    use: 'router',
    payload,
    questions: routerQuestions(),
    subject: opts.subject,
    timeoutMs: ROUTER_TIMEOUT_MS,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {})
  });
  if (!res.ok) return defaultDecision(facts, `unclear by rules; Jev ${res.kind === 'refused' ? 'refused' : 'unavailable'} (${res.reason})`);
  const answer = res.result.answers[ROUTER_QUESTION_NAME];
  if (answer === undefined || answer.type !== 'choice') return defaultDecision(facts, 'unclear by rules; Jev gave no answer');
  return decisionFromJev(facts, answer, { model: res.result.model, cached: res.result.cached, latencyMs: res.result.latencyMs }) ?? defaultDecision(facts, 'unclear by rules; Jev gave an unknown label');
}
