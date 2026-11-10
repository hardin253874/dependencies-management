/**
 * Shared types of the Jev judge (V2_STAGE5_SPEC 5b.2–5b.5).
 *
 * Core boundary (D1/D23): no `next`/`react`, relative imports only, no
 * module-scoped mutable state. Every caller of TypeSafe goes through `Judge`
 * (`judge.ts`): flag + privacy guard, then cache, then the Jev ledger.
 */
import type { Question } from '@typesafe-ai/sdk';

/** `router` = D28 step 2; J1–J8 = the plan's judgment table. */
export type JudgeUse = 'router' | 'J1' | 'J2' | 'J3' | 'J4' | 'J5' | 'J6' | 'J7' | 'J8';
export const JUDGE_USES: readonly JudgeUse[] = ['router', 'J1', 'J2', 'J3', 'J4', 'J5', 'J6', 'J7', 'J8'];
export type JFlag = Exclude<JudgeUse, 'router'>;
export const J_FLAGS: readonly JFlag[] = ['J1', 'J2', 'J3', 'J4', 'J5', 'J6', 'J7', 'J8'];

/** What a payload may contain (5b.3). `source` = target-project source snippets. */
export type PayloadClass = 'metadata' | 'public-text' | 'source';

/**
 * The one table of "data sent" per use, mirroring the plan's J table
 * (V2_UPGRADE_PLAN Stage 5): J1–J3 source snippets, J4 public `.d.ts`,
 * J5/J6/router metadata only, J7 public advisory text, J8 public report text.
 */
export const USE_CLASS: Readonly<Record<JudgeUse, PayloadClass>> = Object.freeze({
  router: 'metadata',
  J1: 'source',
  J2: 'source',
  J3: 'source',
  J4: 'public-text',
  J5: 'metadata',
  J6: 'metadata',
  J7: 'public-text',
  J8: 'public-text'
});

/** Human label of each use's data, shown next to its switch (Settings → LLM). */
export const USE_DATA_LABEL: Readonly<Record<JudgeUse, string>> = Object.freeze({
  router: 'metadata only (versions, counts)',
  J1: 'source snippets',
  J2: 'source snippets',
  J3: 'source snippets',
  J4: "public .d.ts signatures",
  J5: 'metadata only (package names, versions)',
  J6: 'metadata only (package names, versions)',
  J7: 'public advisory text',
  J8: 'public report text'
});

/** A built, class-checked payload. Only the builders in `payload.ts` create one. */
export interface JudgePayload {
  readonly payloadClass: PayloadClass;
  readonly state: Record<string, unknown>;
}

/**
 * Answer shapes as the API returns them (SDK `ChoiceResponse` / `ScoreResponse` /
 * `NoulResponse`, flattened: the SDK's generic score legend type recurses too
 * deeply for TS when used un-instantiated, TS2589).
 */
export interface ChoiceAnswer {
  readonly type: 'choice';
  readonly choice: string;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
}
export interface ScoreAnswer {
  readonly type: 'score';
  /** Expected level (fractional), 0-based index into the criteria list. */
  readonly score: number;
  readonly confidence: number;
  readonly legend: Readonly<Record<string, string>>;
  readonly probabilities: Readonly<Record<string, number>>;
}
export interface NoulAnswer {
  readonly type: 'noul';
  /** P(yes). */
  readonly noul: number;
}
export type JudgeAnswer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export interface JudgeRequest {
  use: JudgeUse;
  payload: JudgePayload;
  questions: Record<string, Question>;
  signal?: AbortSignal;
  /** Per-call timeout (router: `ROUTER_TIMEOUT_MS`). */
  timeoutMs?: number;
}

export interface JudgeResult {
  answers: Record<string, JudgeAnswer>;
  /** Model that answered (may differ from the requested alias). */
  model: string;
  usage: { inputTokens: number | null };
  latencyMs: number;
  cached: boolean;
}

/** Privacy facts the guard needs about the project (or eval case) a request is about. */
export interface JudgeSubject {
  /** `undefined` = unknown → treated as private (D30, fail-safe). */
  privacy: 'public' | 'private' | undefined;
  /** Per-project switch; `'off'` beats the global switch. Missing = `'on'` (follow global). */
  judge?: 'on' | 'off';
  /** Explicit per-project opt-in for J1–J3 source uses on a private project (plan: "same per-project opt-in"). */
  sourceOptIn?: boolean;
  /** Eval only: `real.ts` classified the case private. Always refused. */
  privateEvalCase?: boolean;
}

/** The global switches (`_config.json` `judge`). */
export interface JudgeSwitches {
  enabled: boolean;
  router: boolean;
  flags: Record<JFlag, boolean>;
}

/**
 * D32 (confirmed 2026-11-10): Jev and J1 on by default; the router (D28) and
 * J2–J8 stay off. J1 still only sends anything for a public project (D30) or
 * one with the per-project source opt-in, and only with `TYPESAFE_API_KEY`.
 */
export const DEFAULT_JUDGE_SWITCHES: Readonly<JudgeSwitches> = Object.freeze({
  enabled: true,
  router: false,
  flags: Object.freeze({ J1: true, J2: false, J3: false, J4: false, J5: false, J6: false, J7: false, J8: false })
}) as Readonly<JudgeSwitches>;

function boolOr(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/**
 * A missing / non-boolean field takes its default (a config from before 5b
 * has none); an explicit boolean the user saved, `false` included, is kept.
 */
export function normalizeJudgeSwitches(raw: unknown): JudgeSwitches {
  const o = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const f = o.flags !== null && typeof o.flags === 'object' ? (o.flags as Record<string, unknown>) : {};
  const flags = {} as Record<JFlag, boolean>;
  for (const j of J_FLAGS) flags[j] = boolOr(f[j], DEFAULT_JUDGE_SWITCHES.flags[j]);
  return { enabled: boolOr(o.enabled, DEFAULT_JUDGE_SWITCHES.enabled), router: boolOr(o.router, DEFAULT_JUDGE_SWITCHES.router), flags };
}

/**
 * Only the switches named `true` are on; anything missing is off. The eval
 * builds per-use judges with this so a D32 app default (J1 on) never leaks
 * into a measurement of another use.
 */
export function explicitJudgeSwitches(raw: { enabled?: boolean; router?: boolean; flags?: Partial<Record<JFlag, boolean>> }): JudgeSwitches {
  const flags = {} as Record<JFlag, boolean>;
  for (const j of J_FLAGS) flags[j] = raw.flags?.[j] === true;
  return { enabled: raw.enabled === true, router: raw.router === true, flags };
}

/** Refused by code before any client call (flag off, privacy, payload class). Callers fall back to today's behaviour. */
export class JudgePrivacyError extends Error {
  readonly code = 'JUDGE_REFUSED' as const;
  constructor(message: string) {
    super(message);
    this.name = 'JudgePrivacyError';
  }
}

/** The judge cannot answer (no key, outage, timeout, 4xx/5xx, ledger refusal). Never an error toast. */
export class JudgeUnavailableError extends Error {
  readonly code = 'JUDGE_UNAVAILABLE' as const;
  constructor(
    readonly reason: JudgeUnavailableReason,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'JudgeUnavailableError';
  }
}

export type JudgeUnavailableReason = 'no-key' | 'timeout' | 'rate-limit' | 'overloaded' | 'auth' | 'ledger' | 'connection' | 'bad-request' | 'server' | 'aborted' | 'other';
