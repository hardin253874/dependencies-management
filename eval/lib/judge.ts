/**
 * `eval judge --use J1|J2|J4|J5|J6|J7` (V2_STAGE5_SPEC 5b.16): J measurement
 * harness. Mock by default (`MockJudgeClient`); `--real` wiring exists (real
 * Jev client from `real.ts`, Jev ledger, privacy check) but is NOT executed in
 * 5b. Private cases are refused for every use, mock or real (the payloads
 * would carry private source text or metadata).
 *
 * Measured here (truth from the pinned clone, read-only):
 * - J1: recall@{20, 50, truthCount} of the Jev order vs the input order
 *   (graph base set, path asc) over the v2-graph predicted set. "Graph order"
 *   = the same input order (impactBaseSet is path-sorted), noted in the output.
 * - J5: F1 of "co-upgraded with the target" suggestions vs the packages the
 *   phase commit changed in package.json; baseline = the 4-entry pairing table.
 * - J6: action accuracy (upgrade if the commit changed it, else keep) over the
 *   direct deps; baseline = always `investigate` (accuracy 0 by construction).
 * Answers go through a `JudgeCache` when the CLI passes one (`judgeEvalCacheDir`):
 * real `<evalCache>/_judge`, mock `<evalCache>/_judge-mock`, so mock answers can
 * never be read back as real ones. `--use router` is `askRouterJev` in router-arms.ts.
 *
 * Not measurable in 5b (reported with the reason): J2 (needs the 5c.1 real
 * Sonnet reports), J4 (needs `eval/corpus/j4-renames.json` with ≥ 10 labelled
 * items; none curated yet), J7 (needs OSV advisories with a CVSS vector — a
 * public network fetch the 5c step does), J3 / J8 (no truth).
 */
import path from 'path';
import { Judge } from '../../src/core/judge/judge';
import type { JudgeCache } from '../../src/core/judge/cache';
import { MockJudgeClient } from '../../src/core/judge/mock';
import type { JudgeClient } from '../../src/core/judge/client';
import { explicitJudgeSwitches, type JFlag, type JudgeSubject } from '../../src/core/judge/types';
import { coUpgradeJ5, rankFilesJ1, relatedUnknownJ6, type JudgeContext } from '../../src/core/judge/uses';
import { COMMON_PAIRING_MAP } from '../../src/lib/llm/coUpgrade';
import type { DependencyChange } from './truth';
import type { LoadedCase, SpendInfo } from './types';

export const MEASURABLE_USES = ['J1', 'J2', 'J4', 'J5', 'J6', 'J7'] as const;
export type MeasuredUse = (typeof MEASURABLE_USES)[number];

export const NOT_MEASURABLE: Readonly<Record<string, string>> = {
  J2: 'not measurable in 5b: needs the 5c.1 real Sonnet [D] reports (claims to check)',
  J3: 'not measurable (no truth)',
  J4: 'not measurable: eval/corpus/j4-renames.json has fewer than 10 labelled renames',
  J7: 'not measurable offline: needs OSV advisories with a CVSS vector (5c fetch)',
  J8: 'not measurable (no truth)'
};

export function recallAtK(order: readonly string[], truth: ReadonlySet<string>, k: number): number | null {
  if (truth.size === 0) return null;
  let hit = 0;
  for (const p of order.slice(0, k)) if (truth.has(p)) hit += 1;
  // Normalised by what the top k can hold, so recall@k reaches 1 when truth is larger than k.
  return hit / Math.min(truth.size, Math.max(k, 1));
}

export function f1(predicted: ReadonlySet<string>, truth: ReadonlySet<string>): { precision: number | null; recall: number | null; f1: number | null } {
  let tp = 0;
  for (const p of predicted) if (truth.has(p)) tp += 1;
  const precision = predicted.size === 0 ? null : tp / predicted.size;
  const recall = truth.size === 0 ? null : tp / truth.size;
  if (precision === null || recall === null) return { precision, recall, f1: null };
  return { precision, recall, f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall) };
}

/** Names the phase commit changed in package.json, minus the phase's own packages. */
export function coUpgradedTruth(changes: ReadonlyArray<{ changes: DependencyChange[] | null }>, phasePackages: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const d of changes) for (const ch of d.changes ?? []) if (!phasePackages.includes(ch.name)) out.add(ch.name);
  return out;
}

export interface JudgeEvalPhase {
  caseId: string;
  phaseId: string;
  use: MeasuredUse;
  metrics: Record<string, number | null>;
  /** Asks that reached the client in this phase (cache misses; a gate refusal counts here too, see `spend.refusals`). */
  requests: number;
}

export interface JudgeEvalResult {
  kind: 'judge-eval';
  use: MeasuredUse;
  label: string;
  generatedAt: string;
  visibility: 'public';
  client: 'mock' | 'typesafe';
  status: 'measured' | 'not-measurable';
  reason?: string;
  notes: string[];
  phases: JudgeEvalPhase[];
  /** `--real` only: Jev ledger state around the run (`jevSpendSession`), set by the CLI. */
  spend?: SpendInfo;
}

export interface JudgeEvalDeps {
  /** Pinned clone dir of a case. */
  prepare: (c: LoadedCase) => Promise<string>;
  truth: (c: LoadedCase, dir: string) => Promise<Array<{ phaseId: string; kept: string[]; dependencyDiff: Array<{ projectDir: string; changes: DependencyChange[] | null }> }>>;
  /** v2-graph predicted set per phase (repo-relative, sorted). */
  predicted: (c: LoadedCase, dir: string) => Promise<Map<string, string[]>>;
  /** First import-site window of a repo-relative file (read-only), or null. */
  snippet: (dir: string, relPath: string, packages: readonly string[]) => Promise<string | null>;
  /** Direct deps at the base commit (name → version / range). */
  directDeps: (c: LoadedCase, dir: string) => Promise<Array<{ name: string; version: string | null }>>;
  /** Judge client: mock by default; the real one only via real.ts. */
  client: JudgeClient;
  /** Eval judge cache (`judgeEvalCacheDir`); omitted/null = no cache. */
  cache?: JudgeCache | null;
  log: (line: string) => void;
}

export class JudgeEvalError extends Error {}

/** `<evalCache>/_judge` for real answers (spec 5b.4); mock answers live apart in `_judge-mock`. */
export function judgeEvalCacheDir(evalCacheDir: string, client: 'mock' | 'typesafe'): string {
  return path.join(evalCacheDir, client === 'typesafe' ? '_judge' : '_judge-mock');
}

export function mockJudgeClient(fixtureDir?: string): MockJudgeClient {
  return new MockJudgeClient(fixtureDir !== undefined ? { fixtureDir } : {});
}

export async function runJudgeEval(opts: { use: MeasuredUse; label: string; now: Date; cases: readonly LoadedCase[]; deps: JudgeEvalDeps }): Promise<JudgeEvalResult> {
  for (const c of opts.cases) if (c.visibility !== 'public') throw new JudgeEvalError(`refusing case "${c.id}": private cases never run Jev judgments`);
  const base: Omit<JudgeEvalResult, 'status' | 'phases'> = {
    kind: 'judge-eval',
    use: opts.use,
    label: opts.label,
    generatedAt: opts.now.toISOString(),
    visibility: 'public',
    client: opts.deps.client.kind,
    notes: []
  };
  const notMeasurable = NOT_MEASURABLE[opts.use];
  if (notMeasurable !== undefined) return { ...base, status: 'not-measurable', reason: notMeasurable, phases: [] };
  const flag = opts.use as JFlag;
  // Count at the client, behind the cache: every ask that reaches it is a cache miss,
  // whatever the client type (review 5c M1: only MockJudgeClient requests were counted).
  let asked = 0;
  const inner = opts.deps.client;
  const counted: JudgeClient = {
    kind: inner.kind,
    ask: (input) => {
      asked += 1;
      return inner.ask(input);
    }
  };
  const judge = new Judge({ client: counted, cache: opts.deps.cache ?? null, switches: explicitJudgeSwitches({ enabled: true, flags: { [flag]: true } }) });
  const subject: JudgeSubject = { privacy: 'public' };
  const ctx: JudgeContext = { judge, subject };
  const phases: JudgeEvalPhase[] = [];
  for (const c of opts.cases) {
    const dir = await opts.deps.prepare(c);
    const truths = await opts.deps.truth(c, dir);
    const predicted = opts.use === 'J1' ? await opts.deps.predicted(c, dir) : new Map<string, string[]>();
    const direct = opts.use === 'J1' ? [] : await opts.deps.directDeps(c, dir);
    for (const phase of c.phases) {
      const t = truths.find((x) => x.phaseId === phase.id);
      if (t === undefined) continue;
      const before = asked;
      const pkgs = phase.packages.map((p) => p.name);
      const first = phase.packages[0];
      const from = first?.from ?? '0.0.0';
      const to = first?.to ?? from;
      let metrics: Record<string, number | null> = {};
      if (opts.use === 'J1') {
        const input = predicted.get(phase.id) ?? [];
        const files: Array<{ path: string; snippet: string }> = [];
        for (const p of input) {
          const s = await opts.deps.snippet(dir, p, pkgs);
          if (s !== null) files.push({ path: p, snippet: s });
        }
        const ranked = (await rankFilesJ1(ctx, { pkg: pkgs[0] ?? '', from, to, files }))?.order ?? input;
        const truth = new Set(t.kept);
        const n = truth.size;
        metrics = {
          truth: n,
          candidates: input.length,
          'input@20': recallAtK(input, truth, 20),
          'jev@20': recallAtK(ranked, truth, 20),
          'input@50': recallAtK(input, truth, 50),
          'jev@50': recallAtK(ranked, truth, 50),
          'input@truth': recallAtK(input, truth, n),
          'jev@truth': recallAtK(ranked, truth, n)
        };
      } else if (opts.use === 'J5') {
        const truth = coUpgradedTruth(t.dependencyDiff, pkgs);
        const sugg = (await coUpgradeJ5(ctx, { target: pkgs[0] ?? '', from, to, deps: direct })) ?? [];
        const jev = f1(new Set(sugg.map((x) => x.name)), truth);
        const pairing = new Set((COMMON_PAIRING_MAP[pkgs[0] ?? ''] ?? []).filter((n) => direct.some((d) => d.name === n)));
        const baseline = f1(pairing, truth);
        metrics = { truth: truth.size, 'jev.f1': jev.f1, 'jev.precision': jev.precision, 'jev.recall': jev.recall, 'pairing.f1': baseline.f1 };
      } else if (opts.use === 'J6') {
        const changed = coUpgradedTruth(t.dependencyDiff, pkgs);
        const deps = direct.filter((d) => !pkgs.includes(d.name));
        const out = await relatedUnknownJ6(ctx, { viewedDep: pkgs[0] ?? '', from, to, deps });
        let right = 0;
        let scored = 0;
        for (const d of deps) {
          const a = out?.get(d.name);
          if (a === undefined) continue;
          scored += 1;
          if ((a.action === 'upgrade') === changed.has(d.name)) right += 1;
        }
        metrics = { deps: deps.length, scored, 'jev.accuracy': scored === 0 ? null : right / scored, 'investigate.accuracy': deps.length === 0 ? null : 0 };
      }
      phases.push({ caseId: c.id, phaseId: phase.id, use: opts.use, metrics, requests: asked - before });
    }
  }
  const notes = opts.use === 'J1' ? ['graph order = input order here (the base set is path-sorted)'] : [];
  return { ...base, notes, status: 'measured', phases };
}
