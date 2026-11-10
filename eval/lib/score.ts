/**
 * File-level metrics (pure). Precision/recall are null — never NaN or 0 —
 * when their denominator is 0, so "nothing predicted" is distinguishable
 * from "predicted only wrong files" in every aggregate.
 */
import type {
  Aggregate,
  CaseResult,
  DropReason,
  KindRecall,
  PhaseResult,
  PrecisionRecall,
  TagAggregate,
  TruthKind,
  TruthSet
} from './types';
import { normalizeRepoPath } from './truth';

export const FALSE_POSITIVE_SAMPLE = 20;

function ratio(num: number, den: number): number | null {
  return den === 0 ? null : num / den;
}

function mean(values: Array<number | null>): number | null {
  const xs = values.filter((v): v is number => v !== null);
  return xs.length === 0 ? null : xs.reduce((s, v) => s + v, 0) / xs.length;
}

export interface PhaseMeta {
  id: string;
  packages: string[];
  tags: string[];
}

export function scorePhase(meta: PhaseMeta, truth: TruthSet, predictedPaths: readonly string[]): PhaseResult {
  const predicted = new Set(predictedPaths.map(normalizeRepoPath));
  const truthByPath = new Map(truth.kept.map((t) => [normalizeRepoPath(t.path), t.kind] as const));

  let tp = 0;
  const kindTotals: Record<TruthKind, number> = { source: 0, config: 0, style: 0 };
  const kindHits: Record<TruthKind, number> = { source: 0, config: 0, style: 0 };
  const falseNegatives: string[] = [];
  for (const [p, kind] of truthByPath) {
    kindTotals[kind] += 1;
    if (predicted.has(p)) {
      tp += 1;
      kindHits[kind] += 1;
    } else {
      falseNegatives.push(p);
    }
  }
  const falsePositives = Array.from(predicted).filter((p) => !truthByPath.has(p)).sort();

  const recallByKind: KindRecall = {
    source: ratio(kindHits.source, kindTotals.source),
    config: ratio(kindHits.config, kindTotals.config),
    style: ratio(kindHits.style, kindTotals.style)
  };
  const droppedCounts: Partial<Record<DropReason, number>> = {};
  for (const d of truth.dropped) droppedCounts[d.reason] = (droppedCounts[d.reason] ?? 0) + 1;

  return {
    id: meta.id,
    packages: meta.packages,
    tags: meta.tags,
    truthCount: truthByPath.size,
    predictedCount: predicted.size,
    tp,
    precision: ratio(tp, predicted.size),
    recall: ratio(tp, truthByPath.size),
    recallByKind,
    falseNegatives: falseNegatives.sort(),
    falsePositivesCount: falsePositives.length,
    falsePositivesSample: falsePositives.slice(0, FALSE_POSITIVE_SAMPLE),
    addedCount: truth.addedCount,
    droppedCounts,
    outOfScope: truth.outOfScope
  };
}

function aggregatePhases(phases: readonly PhaseResult[]): { micro: PrecisionRecall; macro: PrecisionRecall } {
  const tp = phases.reduce((s, p) => s + p.tp, 0);
  const predicted = phases.reduce((s, p) => s + p.predictedCount, 0);
  const truth = phases.reduce((s, p) => s + p.truthCount, 0);
  return {
    micro: { precision: ratio(tp, predicted), recall: ratio(tp, truth) },
    macro: { precision: mean(phases.map((p) => p.precision)), recall: mean(phases.map((p) => p.recall)) }
  };
}

/** Micro, macro and by-tag values over ok cases; error cases are only counted. */
export function aggregate(cases: readonly CaseResult[]): Aggregate {
  const ok = cases.filter((c) => c.status === 'ok');
  // Stage 4a: a skipped phase (the predictor had nothing to predict, e.g. v1-ai) is not scored.
  const phases = ok.flatMap((c) => c.phases.filter((p) => p.status !== 'skipped'));
  const overall = aggregatePhases(phases);

  const tagged = new Map<string, PhaseResult[]>();
  for (const p of phases) {
    for (const tag of p.tags) {
      const list = tagged.get(tag);
      if (list === undefined) tagged.set(tag, [p]);
      else list.push(p);
    }
  }
  const byTag: Record<string, TagAggregate> = {};
  for (const tag of Array.from(tagged.keys()).sort()) {
    const list = tagged.get(tag) as PhaseResult[];
    byTag[tag] = { ...aggregatePhases(list), phases: list.length };
  }

  return { micro: overall.micro, macro: overall.macro, byTag, errors: cases.length - ok.length };
}

/**
 * `v2-agent:subset` (5a.7): the same aggregate over each phase's
 * `agent.subset` score. Phases without a subset (other predictors, older
 * files) are left out; null when no phase has one.
 */
export function aggregateSubset(cases: readonly CaseResult[]): Aggregate | null {
  let any = false;
  const mapped = cases.map((c) => ({
    ...c,
    phases: c.phases.flatMap((p) => {
      const s = p.agent?.subset;
      if (s === undefined) return [];
      any = true;
      return [{ ...p, predictedCount: s.predictedCount, tp: s.tp, precision: s.precision, recall: s.recall }];
    })
  }));
  return any ? aggregate(mapped) : null;
}
