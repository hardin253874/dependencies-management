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

export type PredictorId = 'v1-code-scan' | 'v2-graph' | 'v2-agent' | 'v1-ai';

/** v2 Stage 4a.14/4a.15: what the AI predictors spent on one phase (summed over its runs). */
export interface PhaseAgentInfo {
  /** Worst status over the phase's runs (`submitted` only when every run submitted). */
  status: string;
  /** Agent loop runs (v2-agent, one per projectDir) or v1 requests (v1-ai, one per eligible package). */
  runs: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  /** Reported filesToModify paths that are not graph files (reported, not scored). */
  hallucinatedPaths: number;
  durationMs: number;
  /** v2 Stage 5a.7 (v2-agent): the agent's own pick (confirmed ∪ added), scored separately. Older files lack it. */
  subset?: SubsetScore;
  /** v2 Stage 5a.7 (v2-agent): base set + overlay counts, summed over the phase's runs. Older files lack it. */
  impact?: PhaseImpactInfo;
}

export interface SubsetScore {
  predictedCount: number;
  tp: number;
  precision: number | null;
  recall: number | null;
}

export interface PhaseImpactInfo {
  base: number;
  confirmed: number;
  added: number;
  excluded: number;
  rejectedExclusions: number;
  /** Valid exclusions that are truth files (the recall the exclusions cost). Set when scored. */
  excludedTruePositives: number;
}

export interface CasePrediction {
  filesScanned: number;
  durationMs: number;
  /** phase id → predicted repo-relative POSIX paths (sorted, unique). */
  byPhase: Map<string, string[]>;
  /** Sum of the case's API cost (AI predictors; absent = 0). */
  costUsd?: number;
  /** AI predictors: per-phase run facts. */
  agentByPhase?: Map<string, PhaseAgentInfo>;
  /** Phases the predictor did not predict (excluded from aggregates), with the reason. */
  skippedPhases?: Map<string, string>;
  /** v2-agent (5a.7): phase id → the agent's own pick (confirmed ∪ added), prefixed like byPhase. */
  subsetByPhase?: Map<string, string[]>;
  /** v2-agent (5a.7): phase id → valid exclusions (removed from byPhase), prefixed like byPhase. */
  excludedByPhase?: Map<string, string[]>;
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
  /** v2 Stage 4a: `skipped` phases (e.g. v1-ai with no eligible package) are excluded from aggregates. */
  status?: 'skipped';
  reason?: string;
  /** v2 Stage 4a: AI predictor run facts for this phase. */
  agent?: PhaseAgentInfo;
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

/** v2 Stage 4c: spend-ledger state around a `--real` run (USD, from the ledger outside the repo). */
export interface SpendInfo {
  roundId: string;
  capUsd: number;
  spentBefore: number;
  spentAfter: number;
  /** Open reservations after the run (requests that threw without usage stay reserved). */
  reservedAfter: number;
  /** Requests the gate refused (cap or step ceiling); > 0 means the run stopped at the cap. */
  refusals: number;
  /** Requests that passed the gate. */
  requests: number;
}

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
  /** v2 Stage 5a.7 (v2-agent): aggregate of the `agent.subset` scores ("v2-agent:subset"). Older files lack it. */
  aggregateSubset?: Aggregate;
  /** Stage 4c `--real` runs only. */
  spend?: SpendInfo;
}

// ---------------------------------------------------------------------------
// Findings sheet (§0.8)
// ---------------------------------------------------------------------------

export type FindingVerdict = 'found' | 'partial' | 'missed' | 'n/a';

// ---------------------------------------------------------------------------
// Graph usage measurement (V2_STAGE3_SPEC 3b-B.3, `eval -- graph`)
// ---------------------------------------------------------------------------

export type GraphPackageSource = 'phase' | 'declared';

export interface SetScore {
  truth: number;
  predicted: number;
  tp: number;
  /** null when the denominator is 0, never NaN. */
  precision: number | null;
  recall: number | null;
}

export interface GraphPackageResult extends SetScore {
  name: string;
  /** Wrapper hits (unscored). */
  wrapperHits: number;
  /** Graph hits only through a bundler alias TS cannot see (excluded from scoring). */
  aliasOnlyHits: number;
  /** Graph hits only as config references (excluded from scoring). */
  configRefOnlyHits: number;
  /**
   * A workspace package of the project: the graph links it as a package, the
   * TS truth resolves it to source files (tsconfig paths). Listed, not scored.
   */
  workspace: boolean;
}

export interface GraphSample {
  pkg: string;
  path: string;
}

export interface GraphUnresolved {
  totalEdges: number;
  unresolved: number;
  /** unresolved / totalEdges; null when there are no edges. */
  pct: number | null;
  byReason: Record<string, number>;
}

export interface GraphCaseResult {
  id: string;
  tags: string[];
  status: CaseStatus;
  error?: string;
  files: { graph: number; truth: number };
  buildMs: number;
  truthMs: { direct: number; reexport: number };
  truthCached: boolean;
  /** 'unavailable' when any projectDir hit the time box (then only direct truth is scored there). */
  reexportTruth: 'ok' | 'unavailable';
  /** Packages queried (after the phase/declared selection). */
  packagesQueried: number;
  micro: SetScore;
  macro: { precision: number | null; recall: number | null };
  /** Packages with at least one truth or graph hit, by name. */
  packages: GraphPackageResult[];
  wrapperHits: number;
  aliasOnlyHits: number;
  configRefOnlyHits: number;
  /** Workspace packages listed but left out of micro/macro. */
  workspacePackages: number;
  unresolved: GraphUnresolved;
  truthStats: { specifiers: number; unresolvedRelative: number; bareByName: number };
  /** Public cases only (omitted for private ones): up to 20 each. */
  graphOnlySample?: GraphSample[];
  truthOnlySample?: GraphSample[];
  /** Public cases only: most frequent unresolved specifiers. */
  topUnresolved?: Array<{ projectDir: string; reason: string; specifier: string; count: number }>;
}

export interface GraphTargets {
  recallTarget: number;
  precisionTarget: number;
  unresolvedTarget: number;
  recallMet: boolean;
  precisionMet: boolean;
  unresolvedMet: boolean;
  met: boolean;
}

export interface GraphAggregate {
  micro: SetScore;
  /** Mean of the ok cases' micro precision/recall. */
  macro: { precision: number | null; recall: number | null };
  medianUnresolvedPct: number | null;
  errors: number;
  targets: GraphTargets;
}

export const GRAPH_RESULT_SCHEMA_VERSION = 1;

export interface GraphResultFile {
  kind: 'graph-usage';
  schemaVersion: typeof GRAPH_RESULT_SCHEMA_VERSION;
  label: string;
  generatedAt: string;
  tool: ToolInfo;
  visibility: Visibility;
  packages: GraphPackageSource;
  scoredSet: 'direct+reexport (JS/TS files)';
  truth: { method: string; truthVersion: number; tsVersion: string; limitations: readonly string[] };
  cases: GraphCaseResult[];
  aggregate: GraphAggregate;
}
