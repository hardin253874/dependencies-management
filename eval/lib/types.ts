/**
 * Shared eval-harness contracts (v2 Stage 0, round 1).
 *
 * Every eval module codes against these shapes; none of them redefines a
 * shape locally. Result files carry `schemaVersion: 1` — bump it (and teach
 * `compare` about it) whenever a field here changes meaning.
 */

// ---------------------------------------------------------------------------
// Corpus (§3.1)
// ---------------------------------------------------------------------------

export interface PackageChange {
  name: string;
  /** Version before the phase, or null when the package was added. */
  from: string | null;
  /** Version after the phase, or null when the package was removed. */
  to: string | null;
}

export interface CorpusPhase {
  id: string;
  /** Truth range = previous phase's toCommit (or baseCommit) .. toCommit. */
  toCommit: string;
  packages: PackageChange[];
  tags?: string[];
}

export type GoldenExpected = 'yes' | 'partial' | 'no' | 'l3';

export interface GoldenFinding {
  id: string;
  phase: string;
  title: string;
  category: string;
  expected: GoldenExpected;
  evidenceFiles?: string[];
  /** True only after a person checked the item. */
  verified: boolean;
}

export interface CorpusCase {
  id: string;
  /** https URL, or an absolute local path (private cases only). */
  repo: string;
  baseCommit: string;
  /** Repo-relative POSIX dirs to scan; defaults to ["."]. */
  projectDirs: string[];
  phases: CorpusPhase[];
  tags: string[];
  truthExcludeGlobs?: string[];
  source?: Record<string, string>;
  goldenFindings?: GoldenFinding[];
  notes?: string;
}

export type Visibility = 'public' | 'private';

/** A case after loading: defaults applied, visibility set by the loader. */
export interface LoadedCase extends CorpusCase {
  visibility: Visibility;
  /** File the case came from (for error messages only; never serialised). */
  sourceFile: string;
}

// ---------------------------------------------------------------------------
// Truth set (§3.2)
// ---------------------------------------------------------------------------

export type TruthKind = 'source' | 'config' | 'style';

export type DropReason =
  | 'env'
  | 'lockfile'
  | 'package-json'
  | 'excluded'
  | 'snapshot'
  | 'docs'
  | 'binary'
  | 'formatting'
  | 'added'
  | 'other';

export interface TruthEntry {
  /** Path at base (for a rename: the old path). */
  path: string;
  kind: TruthKind;
  /** git status letter: M, D, R, T … */
  status: string;
  /** Rename target, kept for display. */
  newPath?: string;
}

export interface DroppedEntry {
  path: string;
  reason: DropReason;
  status: string;
}

export interface TruthSet {
  kept: TruthEntry[];
  dropped: DroppedEntry[];
  addedCount: number;
  /** Kept-kind paths outside every projectDir (shown, not scored). */
  outOfScope: string[];
}

// ---------------------------------------------------------------------------
// Prediction
// ---------------------------------------------------------------------------

export type PredictorId = 'v1-code-scan';

export interface CasePrediction {
  filesScanned: number;
  durationMs: number;
  /** phase id → predicted repo-relative POSIX paths (sorted, unique). */
  byPhase: Map<string, string[]>;
}

// ---------------------------------------------------------------------------
// Result file (§3.4)
// ---------------------------------------------------------------------------

export interface KindRecall {
  source: number | null;
  config: number | null;
  style: number | null;
}

export interface PhaseResult {
  id: string;
  packages: string[];
  /** Case tags merged with phase tags (sorted, unique) — drives byTag. */
  tags: string[];
  truthCount: number;
  predictedCount: number;
  tp: number;
  /** null when the denominator is 0, never NaN or 0. */
  precision: number | null;
  recall: number | null;
  recallByKind: KindRecall;
  falseNegatives: string[];
  falsePositivesCount: number;
  /** At most 20 paths. */
  falsePositivesSample: string[];
  addedCount: number;
  droppedCounts: Partial<Record<DropReason, number>>;
  outOfScope: string[];
}

export interface FindingGroupScore {
  /** Scored items in the group (unscored excluded). */
  n: number;
  /** found = 1, partial = 0.5, missed = 0. */
  score: number;
  /** score / n, null when n is 0. */
  recall: number | null;
}

export interface FindingsScore {
  scoredAt: string;
  expectedYes: FindingGroupScore;
  expectedPartial: FindingGroupScore;
  expectedNo: FindingGroupScore;
  l3: FindingGroupScore;
  unscored: number;
  unverifiedGoldenSet: boolean;
}

export type CaseStatus = 'ok' | 'error';

export interface CaseResult {
  id: string;
  tags: string[];
  status: CaseStatus;
  error?: string;
  filesScanned: number;
  durationMs: number;
  costUsd: number;
  phases: PhaseResult[];
  findings: FindingsScore | null;
}

export interface PrecisionRecall {
  precision: number | null;
  recall: number | null;
}

export interface TagAggregate {
  micro: PrecisionRecall;
  macro: PrecisionRecall;
  phases: number;
}

export interface Aggregate {
  /** Summed tp / summed denominators across ok phases. */
  micro: PrecisionRecall;
  /** Mean of non-null phase values. */
  macro: PrecisionRecall;
  byTag: Record<string, TagAggregate>;
  errors: number;
}

export interface ToolInfo {
  commit: string;
  dirty: boolean;
}

export const RESULT_SCHEMA_VERSION = 1;

export interface ResultFile {
  schemaVersion: typeof RESULT_SCHEMA_VERSION;
  label: string;
  generatedAt: string;
  predictor: PredictorId;
  tool: ToolInfo;
  /** One file never mixes the two. */
  visibility: Visibility;
  cases: CaseResult[];
  aggregate: Aggregate;
}

// ---------------------------------------------------------------------------
// Findings sheet (§0.8)
// ---------------------------------------------------------------------------

export type FindingVerdict = 'found' | 'partial' | 'missed' | 'n/a';
