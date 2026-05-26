/**
 * Shared API types — the canonical typed contract between Frontend and Backend.
 *
 * Every payload defined in spec §9 has a matching type here. Both Frontend and
 * Backend should import from `@/lib/api-types`.
 *
 * Spec authority: §9 (API surface), §6.2 (Add Project validation), §8.6
 * (project.json), §10.1 (Phase 1 scan), §10.10 (jobs), §11.11 (cost).
 *
 * Note: during Stage 1 Frontend developed an interim `src/lib/client/api-types.ts`
 * before this file landed. The two converge on these shapes; Frontend's copy
 * will be retired in favor of importing from here.
 */

// ============================================================================
// Error envelope (§9.5)
// ============================================================================

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    retryable?: boolean;
  };
}

// ============================================================================
// CSRF (§9.3)
// ============================================================================

export interface CsrfResponse {
  token: string;
}

// ============================================================================
// Config (§5.3, §9.3)
// ============================================================================

export type LlmProvider = 'anthropic' | 'openai';
export type ThemeChoice = 'light' | 'dark' | 'system';

export interface ConfigResponse {
  schemaVersion: 1;
  llm: { provider: LlmProvider; model: string };
  ui: {
    sidebarCollapsed: boolean;
    theme: ThemeChoice;
    showDeepAnalyzeWarning: boolean;
    panelWidths?: { left: number; middle: number };
  };
  features: { resolverCheckEnabled: boolean };
  /** Presence booleans only — values never leave the server (§5.5). */
  apiKeys: {
    hasAnthropicKey: boolean;
    hasOpenAIKey: boolean;
  };
}

export type ConfigPatch = {
  llm?: Partial<ConfigResponse['llm']>;
  ui?: Partial<ConfigResponse['ui']>;
  features?: Partial<ConfigResponse['features']>;
};

export interface ApiKeySetRequest {
  provider: LlmProvider;
  apiKey: string;
}

export interface ApiKeyTestResponse {
  ok: boolean;
  message: string;
}

// ============================================================================
// Filesystem picker (§9.3, §6.1)
// ============================================================================

export interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink?: boolean;
  hasPackageJson?: boolean;
  hasLockfile?: boolean;
}

export interface FsListResponse {
  path: string;
  parent: string | null;
  entries: FsEntry[];
}

export type FsValidationCode =
  | 'OK'
  | 'PATH_NOT_ABSOLUTE'
  | 'PATH_NOT_FOUND'
  | 'NOT_A_DIRECTORY'
  | 'NO_PACKAGE_JSON'
  | 'INVALID_PACKAGE_JSON'
  | 'NO_LOCKFILE'
  | 'INSIDE_AGENT'
  | 'DUPLICATE_PROJECT'
  | 'PATH_TRAVERSAL';

export interface FsValidationResponse {
  ok: boolean;
  code: FsValidationCode;
  message: string;
  packageManager?: PackageManager;
  workspacesDetected?: boolean;
  /** Set when validation passes but a soft warning applies (e.g., nested). */
  warning?: string;
}

// ============================================================================
// Projects (§6.2, §8.6, §9.3)
// ============================================================================

export type PackageManager = 'npm' | 'yarn-classic' | 'yarn-berry';
/**
 * Section a dependency entry belongs to.
 *
 * - `dependencies` / `devDependencies` come straight from `package.json`.
 * - `volta` is synthesized client-side from `project.json.volta` so the
 *   toolchain pins (node, npm, yarn) render in the dep tree alongside real
 *   deps and can be clicked to open View [A]. Volta entries are not currently
 *   populated by the Phase 2 scan, so their `badges.lastScannedAt` stays
 *   `null` until a future BE iteration adds toolchain analysis.
 */
export type DepSection = 'dependencies' | 'devDependencies' | 'volta';
export type OutdatedSeverity = 'major' | 'minor' | 'patch' | null;

/** Lightweight project summary for the left-panel list. */
export interface ProjectSummary {
  slug: string;
  name: string;
  path: string;
  packageManager: PackageManager;
  depCount: number;
  lastScanAt: string | null;
  pathExists: boolean;
  orphan?: boolean;
}

export interface ProjectsListResponse {
  projects: ProjectSummary[];
}

export interface AddProjectRequest {
  path: string;
  /** Set true when the target's package.json has a `workspaces` field. */
  acknowledgeWorkspaces?: boolean;
}

export interface AddProjectResponse {
  slug: string;
  /** Phase 1 scan is sync, no job is enqueued; reserved for future. */
  jobId: string | null;
}

export interface RelocateRequest {
  newPath: string;
  acknowledgeWorkspaces?: boolean;
}

/**
 * Response from POST /api/projects/:slug/refresh. Phase-1 refresh is a
 * synchronous re-read of package.json + lockfile (<1s typical), so jobId is
 * always null today. Reserved as nullable for future async refreshes.
 */
export interface RefreshResponse {
  slug: string;
  jobId: string | null;
}

// ============================================================================
// project.json shape (§8.6)
// ============================================================================

export interface VoltaInfo {
  node: string | null;
  npm: string | null;
  yarn: string | null;
}

export interface DependencyEntry {
  name: string;
  section: DepSection;
  declaredRange: string;
  installedVersion: string | null;
  badges: {
    outdatedSeverity: OutdatedSeverity;
    /** null = not yet scanned, true/false = scanned result. */
    hasCve: boolean | null;
    deprecated: boolean | null;
    lastScannedAt: string | null;
  };
}

export interface ProjectDetail {
  schemaVersion: 1;
  name: string;
  slug: string;
  path: string;
  packageManager: PackageManager;
  lockfileHash: string;
  lockfileStateHash: string;
  lastFullScanAt: string;
  legacyPeerDeps: boolean;
  volta: VoltaInfo | null;
  workspacesDetected: boolean;
  dependencies: DependencyEntry[];
}

// ============================================================================
// Jobs (§9.3, §10.10)
// ============================================================================

export type JobState = 'queued' | 'running' | 'done' | 'error' | 'cancelled';
export type JobPhase = 'registry' | 'cve' | 'ai' | 'retry' | 'scan' | 'resolver';

export interface JobProgress {
  current: number;
  total: number;
  label: string;
  phase: JobPhase;
  attempt?: number;
  maxAttempts?: number;
}

export interface JobErrorPayload {
  code: string;
  message: string;
  retryable: boolean;
}

export interface JobRecord {
  jobId: string;
  slug: string | null;
  resourceKey: string;
  kind: string;
  state: JobState;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress: JobProgress | null;
  error: JobErrorPayload | null;
  resultUrl: string | null;
}

export interface JobsListResponse {
  jobs: JobRecord[];
}

export interface JobEnqueueResponse {
  jobId: string;
  alreadyRunning: boolean;
}

// SSE event payloads (§9.3)
export type SseEventName = 'progress' | 'state' | 'done' | 'error';

// ============================================================================
// Cost tracking (§11.11)
// ============================================================================

export interface AiCostFields {
  inputTokens: number;
  outputTokens: number;
  model: string;
  costEstimateUsd: number;
}

// ============================================================================
// File envelope (§8.3) — shared shape of every persisted JSON file in
// library/<slug>/{deps,versions,usage,...}. GETs that fetch these surfaces
// return the wrapped envelope so the FE can derive cache freshness.
// ============================================================================

export type DataSource =
  | 'registry'
  | 'deterministic'
  | `anthropic:${string}`
  | `openai:${string}`
  | 'deterministic-partial'
  | 'endoflife.date';

export interface FileEnvelope<T> {
  schemaVersion: 1;
  generatedAt: string;
  source: DataSource;
  /** Null means "never auto-expire". Spec §8.5. */
  ttlHours: number | null;
  data: T;
}

// ============================================================================
// CVE common shape (§8.7, §11.* — used in [A], [B], [D-Deep])
// ============================================================================

export type CveSeverity = 'critical' | 'high' | 'medium' | 'moderate' | 'low' | 'unknown';

export interface CveRecord {
  id: string;
  severity: CveSeverity;
  summary: string;
}

// ============================================================================
// Per-dep view payload (View [A]) — `library/<slug>/deps/<name>.json` (§8.7)
// ============================================================================

export interface AvailableVersion {
  version: string;
  publishedAt: string | null;
  isPrerelease: boolean;
}

export interface DepDeprecation {
  message: string;
  /** Optional replacement suggestion surfaced by registry deprecation notice. */
  replacementSuggestion?: string;
}

export interface DepSupport {
  homepage: string | null;
  repository: string | null;
  lastPublishAt: string | null;
}

/**
 * EOL/LTS status for a dep major version, sourced from endoflife.date.
 * Populated only for tracked products (node, next, react, vue, angular,
 * typescript, eslint, webpack, yarn). Most npm packages → `null`.
 */
export type EolStatus = 'eol' | 'lts' | 'active' | 'future';
export interface EolInfo {
  /** Major version cycle, e.g. '18' for Node 18.x. */
  cycle: string;
  /** ISO date when this cycle reaches EOL. `null` when endoflife.date reports `false` (not yet scheduled). */
  eolDate: string | null;
  status: EolStatus;
}

/**
 * One row in the "Related deps in this project" section of view [A].
 *
 * v0.4 shape: one row per related dep, with potentially multiple `reasons`
 * (e.g. `react-dom` related to `react` via inbound-peer-dep AND naming).
 * Health profile aggregates signals from npm registry + OSV + endoflife.date.
 *
 * `null` fields denote "data unavailable" (e.g. cache miss for `cveCount`,
 * untracked product for `eol`); not "absent / zero".
 */
export type RelatedReasonKind =
  | 'inbound-peer-dep'
  | 'outbound-peer-dep'
  | 'inbound-engine'
  | 'outbound-engine'
  | 'naming';

export interface RelatedDepReason {
  kind: RelatedReasonKind;
  /** semver range carried by the relation (`^18.0.0`, `>=18.17`, …). `null` for `naming`. */
  range: string | null;
  /**
   * Whether the related dep's installed version satisfies `range`.
   * `null` when uncomputable (range is null, dep not installed, version unknown).
   */
  satisfied: boolean | null;
}

export interface RelatedDepHealth {
  /** From the related dep's `DepDetail.deprecation`. `null` if cache missing. */
  deprecated: boolean | null;
  /** Length of related dep's `currentVersionCves`. `null` if cache missing or OSV failed. */
  cveCount: number | null;
  maxCveSeverity: CveSeverity | null;
  /** Populated only for endoflife.date-tracked products; `null` otherwise. */
  eol: EolInfo | null;
  /** Days since the related dep last published on npm. `null` if uncomputable. */
  ageDays: number | null;
}

export interface RelatedDep {
  name: string;
  installedVersion: string | null;
  reasons: RelatedDepReason[];
  health: RelatedDepHealth;
}

export interface DepDetail {
  name: string;
  availableVersions: AvailableVersion[];
  support: DepSupport;
  license: string | null;
  deprecation: DepDeprecation | null;
  /**
   * CVEs affecting the currently installed version. Null = OSV.dev fetch
   * failed (§10.5 graceful failure mode); [] = scanned and clean.
   */
  currentVersionCves: CveRecord[] | null;
  /**
   * Latest version's `peerDependencies` (e.g. `react-dom` → `{ react: '^18' }`).
   * Cached so view [A]'s refresh of *another* dep can compute the inverse
   * relation ("who peers me?") without re-fetching every packument. Always
   * present (empty `{}` when absent in the registry data).
   */
  latestPeerDeps: Record<string, string>;
  /**
   * Latest version's `engines` map (e.g. Next.js → `{ node: '>=18.17' }`).
   * Cached for the same reason as `latestPeerDeps`. Always present.
   */
  latestEngines: Record<string, string>;
  /**
   * Project deps that are related to this one. Computed at refresh time of
   * the current dep by scanning other deps' cached `latestPeerDeps`,
   * `latestEngines`, and naming. May be stale relative to other deps' more
   * recent refreshes — Regenerate to recompute.
   */
  relatedDeps: RelatedDep[];
}

// ============================================================================
// Per-version view payload (View [B]) — `library/<slug>/versions/<name>/<v>.json` (§8.7)
// ============================================================================

export interface VersionDetail {
  version: string;
  publishedAt: string | null;
  cves: CveRecord[] | null;
  changelogUrl: string | null;
  notes: string | null;
}

// ============================================================================
// Per-dep usage payload (View [C]) — `library/<slug>/usage/<name>.json` (§8.7)
// ============================================================================

export type UsageCategory = 'prod' | 'test' | 'story' | 'config';

export interface UsageFile {
  path: string;
  pathHash: string;
  category: UsageCategory;
  importStatements: string[];
  importCount: number;
}

export interface UsageDynamicImport {
  file: string;
  line: number;
  snippet: string;
}

export interface UsageOversized {
  path: string;
  sizeBytes: number;
  reason: string;
}

export interface UsageDetail {
  files: UsageFile[];
  dynamicImports: UsageDynamicImport[];
  totalFiles: number;
  declaredButUnused: boolean;
  oversizedSkipped: UsageOversized[];
}

// ============================================================================
// Per-update-report payload (View [D]) — Stage 3
// `library/<slug>/reports/<name>/<from>__<to>.json` (§8.7 + Appendix A.3)
// ============================================================================

export type RiskLevel = 'low' | 'medium' | 'high';
export type ChangeSize = 'small' | 'medium' | 'large';

export interface ResolverConflict {
  package: string;
  reason: string;
}

/**
 * Resolver-check result block on view [D].
 * - `{ kind: 'enabled', ... }` — resolver ran; conflicts may be empty.
 * - `{ kind: 'disabled', reason: 'yarn' | 'kill-switch' | 'failure', ... }`
 *   — resolver was skipped or failed. UI renders the disabled banner with the
 *   reason copy from `WIREFRAMES.md` Wireframe 12.
 */
export type ResolverCheckBlock =
  | {
      kind: 'enabled';
      wouldResolve: boolean;
      conflicts: ResolverConflict[];
      legacyPeerDepsUsed: boolean;
    }
  | {
      kind: 'disabled';
      reason: 'yarn' | 'kill-switch' | 'failure';
      failureMessage?: string;
    };

export interface BreakingChange {
  title: string;
  description: string;
  /** True when the change affects at least one file in the user's project. */
  affectsFilesInProject: boolean;
}

export type CoUpgradeReason = 'peer-dep' | 'common-pairing' | 'co-version' | 'ecosystem';

export interface CoUpgradeDep {
  name: string;
  currentVersion: string;
  suggestedVersion: string;
  required: boolean;
  reason: CoUpgradeReason;
  explanation: string;
}

export interface FileToModify {
  path: string;
  brief: string;
  estimatedChangeSize: ChangeSize;
}

export interface UpdateReportDetail {
  fromVersion: string;
  toVersion: string;
  summary: string;
  riskLevel: RiskLevel;
  resolverCheck: ResolverCheckBlock;
  coUpgradeDeps: CoUpgradeDep[];
  breakingChanges: BreakingChange[];
  filesToModify: FileToModify[];
  recommendations: string[];
  /** Cost tracking (§11.11). Present on AI-generated payloads; absent on `deterministic-partial`. */
  cost?: AiCostFields;
}

// ============================================================================
// Related-deps upgrade analysis — view [B] new section
// ============================================================================

/**
 * One related dep's upgrade recommendation given a `<viewedDep>` version bump.
 *
 * Shape mirrors the LLM tool-schema output but with the deterministic
 * verdict prefixed (so the FE can render even when the LLM call fails and
 * the envelope falls back to `deterministic-partial`).
 */
export interface RelatedDepUpgradeRecommendation {
  /** The related dep's npm name. */
  name: string;
  /** Currently installed in this project. `null` for Volta-toolchain entries that aren't in package.json. */
  installedVersion: string | null;
  /**
   * Echo of why this dep is "related" to the viewed dep. Lets the FE explain
   * `engine ←` / `peer-dep →` / `naming` without re-deriving from the
   * viewed dep's cache.
   */
  relations: ReadonlyArray<{
    kind: RelatedReasonKind;
    /** Constraint range (e.g. `'>=10.0.0'`) or null for naming relations. */
    range: string | null;
    /** True when the installed range still satisfies the target version. */
    satisfiedAtTarget: boolean | null;
  }>;
  /**
   * Deterministic verdict from the offline check (always present):
   *   - `compatible` — installed range satisfies the target → no upgrade required.
   *   - `breaks`     — installed range does NOT satisfy → upgrade needed.
   *   - `unknown`    — relation has no range (e.g. naming) or data missing.
   */
  deterministicVerdict: 'compatible' | 'breaks' | 'unknown';
  /** LLM-suggested action. */
  action: 'keep' | 'upgrade' | 'investigate';
  /** LLM-suggested target version (string like '24.x' or '15.0.0'); null when action='keep'. */
  suggestedVersion: string | null;
  /** Semver-diff severity from installed → suggested. */
  severity: 'patch' | 'minor' | 'major' | 'none';
  /** Migration notes — typically 1–3 sentences. */
  migrationNotes: string;
  /** LLM's self-reported confidence. */
  confidence: 'high' | 'medium' | 'low';
}

export interface RelatedUpgradeDetail {
  /** The viewed dep being upgraded (e.g. `'node'`). */
  viewedDep: string;
  fromVersion: string;
  toVersion: string;
  /** LLM's overall context — 1–2 short paragraphs (ordering, gotchas, ecosystem-level notes). */
  globalNotes: string;
  recommendations: RelatedDepUpgradeRecommendation[];
  /** Cost tracking — present on AI-generated payloads, absent on `deterministic-partial`. */
  cost?: AiCostFields;
}

export interface RelatedUpgradeEnqueueResponse {
  jobId: string;
  alreadyRunning: boolean;
}

// ============================================================================
// CVE impact analysis (v0.6) — view [A] "Analyze Usage" feature
// ============================================================================

/**
 * Per-CVE verdict on whether THIS project's code actually reaches the
 * vulnerable code path. Driven by the LLM analysis; the deterministic
 * skeleton populates it with `inconclusive` + low confidence as a fallback.
 */
export type CveImpactVerdict = 'not-affected' | 'likely-affected' | 'inconclusive';

export interface CveImpactRow {
  /** The CVE ID being assessed (echoes the input). */
  cveId: string;
  /** CVE severity from the OSV record (echoes the input). */
  severity: CveSeverity;
  /** Human-readable CVE summary from OSV (echoes the input). */
  summary: string;
  /** LLM's verdict for this CVE against this project's usage. */
  verdict: CveImpactVerdict;
  /** LLM's self-reported confidence. Conservative: 'low' when uncertain. */
  confidence: 'high' | 'medium' | 'low';
  /** 1–3 sentence explanation — must cite the API surface / call pattern. */
  reasoning: string;
  /**
   * Relative file paths the LLM cited as evidence (drawn from the context
   * windows passed in). Empty for `not-affected` verdicts that have no
   * positive citations.
   */
  citedFiles: string[];
}

export interface CveImpactDetail {
  /** Dep name + installed version this analysis is for. */
  depName: string;
  installedVersion: string;
  /** Per-CVE rows, in the same order the LLM received them. */
  rows: CveImpactRow[];
  /** LLM's cross-CVE summary — 1 paragraph covering overall impact + caveats. */
  globalNotes: string;
  /**
   * Inputs the analysis was based on, so the report has provenance:
   * - `filesAnalyzed`: count of source files whose context made it into the prompt.
   * - `cveCount`: count of CVEs analyzed.
   * - `contextTokensUsed`: approximate input-token budget consumed by code context.
   * - `contextTruncated`: true when the 30k-token cap dropped some files.
   */
  inputs: {
    filesAnalyzed: number;
    cveCount: number;
    contextTokensUsed: number;
    contextTruncated: boolean;
  };
  /** Cost tracking — absent on `deterministic-partial` envelopes. */
  cost?: AiCostFields;
}

export interface CveImpactEnqueueResponse {
  jobId: string;
  alreadyRunning: boolean;
}

/**
 * Cost estimate for the "Analyze Usage" confirmation modal. Same shape
 * idea as DeepReportEstimateResponse but tuned to this feature's inputs
 * (CVE count + file count drive the estimate, not transitive package count).
 */
export interface CveImpactEstimateResponse {
  /** Number of CVEs that will be analyzed (== `currentVersionCves.length`). */
  cveCount: number;
  /** Number of source files in `usage/<dep>.json` that import this dep. */
  filesInUsage: number;
  /** Whether the usage cache exists yet; FE warns when false (cascade will run a scan first). */
  usageCacheExists: boolean;
  /** Heuristic input-token estimate based on cveCount × filesInUsage × avgContextSize. */
  estimatedInputTokens: number;
  /** Output cap from budget. */
  estimatedOutputTokens: number;
  /** Conservative pricing × estimated tokens. */
  estimatedCostUsd: number;
  provider: LlmProvider;
  model: string;
}

// ============================================================================
// Library "Open in file explorer" — Stage 4 (best-effort per OS).
// The BE may not implement this in v1; the FE falls back to a friendly message
// derived from this shape.
// ============================================================================

export interface OpenInExplorerRequest {
  /** Absolute path to open. BE rejects anything outside the library root. */
  path: string;
}

export interface OpenInExplorerResponse {
  ok: boolean;
  message?: string;
}

// ============================================================================
// Per-file-review payload (View [E]) — Stage 3
// `library/<slug>/file-reviews/<name>/<pathHash>.json` (§8.7 + Appendix A.2)
// ============================================================================

export type DepUsageQuality = 'good' | 'outdated' | 'incorrect' | 'risky' | 'unknown';

export type FindingKind =
  | 'outdated-pattern'
  | 'incorrect-usage'
  | 'security-risk'
  | 'deprecation-warning'
  | 'performance'
  | 'info';

export type FindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export type FindingConfidence = 'low' | 'medium' | 'high';

export interface ReviewFinding {
  kind: FindingKind;
  severity: FindingSeverity;
  message: string;
  /** 1-based line in the file (Appendix A.2). Optional. */
  line?: number;
  suggestion?: string;
  confidence: FindingConfidence;
}

export interface FileReviewDetail {
  /** Relative path within the target project. */
  filePath: string;
  /** 12-char sha1 prefix of `filePath` (§8.2). Mirrored from BE so the FE can
   * round-trip the route without recomputing the hash. */
  pathHash: string;
  /** Hash of the file content as it was at the time of the AI review. */
  fileHashAtReview: string;
  /** ISO timestamp. */
  lastReviewedAt: string;
  /** True when the BE compared `fileHashAtReview` against the current file
   * hash and they differ. UI shows the StaleCacheBanner per §7.6. */
  stale: boolean;
  summary: string;
  depUsageQuality: DepUsageQuality;
  findings: ReviewFinding[];
  /** Cost tracking (§11.11). */
  cost?: AiCostFields;
}

// ============================================================================
// Envelope GET response shape — wraps the persisted FileEnvelope with a
// derived `stale` flag so the FE doesn't need its own TTL math.
// ============================================================================

export interface EnvelopeMeta {
  schemaVersion: number;
  generatedAt: string;
  source: DataSource;
  ttlHours: number | null;
  /** True when generatedAt + ttlHours < now (or when reading failed gracefully). */
  stale: boolean;
}

export interface DepDetailResponse {
  meta: EnvelopeMeta;
  data: DepDetail;
}

export interface VersionDetailResponse {
  meta: EnvelopeMeta;
  data: VersionDetail;
}

export interface UsageDetailResponse {
  meta: EnvelopeMeta;
  data: UsageDetail;
}

// ============================================================================
// Phase 2 scan + refresh enqueue (§9.1, §10.1)
// ============================================================================

export interface ScanEnqueueResponse {
  jobId: string;
  alreadyRunning: boolean;
}

// ============================================================================
// Related-deps usage batch refresh (view [C] §7.6 supplement)
// ============================================================================

/**
 * Response for `POST /api/projects/:slug/usage/related/:name/refresh` — enqueue
 * a single `scanCode` job that writes a usage envelope for every related dep
 * of `:name` in one pass (instead of N separate scans). `names` is the list
 * of dependency names that will have their `usage/<n>.json` written when the
 * job completes; the client can then `getUsageDetail` each in parallel.
 */
export interface RelatedUsageEnqueueResponse {
  jobId: string;
  alreadyRunning: boolean;
  /** Names of related deps the job will scan + cache. */
  names: string[];
}

// ============================================================================
// Cache management (§9.3)
// ============================================================================

export interface PruneCount {
  files: number;
  bytes: number;
}

/** Categories of cached data the prune endpoint reports on. */
export type PruneKind = 'deps' | 'versions' | 'usage' | 'reports' | 'deep-reports' | 'file-reviews';

export interface CachePruneResponse {
  dryRun: boolean;
  olderThanDays: number;
  pruned: PruneCount;
  byKind: Record<PruneKind, PruneCount>;
}

export interface LibrarySizeResponse {
  totalBytes: number;
  /** Per-category byte totals for the Settings display. */
  byKind: Record<string, number>;
}

// ============================================================================
// Job orphan detection on boot (§10.10)
// ============================================================================

export interface JobOrphan {
  slug: string;
  jobId: string;
  kind: string;
  resourceKey: string;
  /** ISO timestamp from the stale journal file. */
  createdAt: string;
  /** ISO timestamp the orphan was detected (boot time). */
  detectedAt: string;
}

/** `GET /api/jobs` now also surfaces orphans for the UI re-run/discard banner. */
export interface JobsListWithOrphansResponse {
  jobs: JobRecord[];
  orphans: JobOrphan[];
}

// ============================================================================
// View [D-Deep] — Deep Update Report (Stage 4, spec §7.6, §11.6, Appendix A.4)
// `library/<slug>/deep-reports/<name>/<from>__<to>__lf-<5chars>.json`
// ============================================================================

export type DeepRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type DeepEstimatedEffort = 'small' | 'medium' | 'large' | 'very-large';

/** One package in the lockfile that declares a peer-dep on the target dep. */
export interface PeerDepOnTarget {
  package: string;
  version: string;
  peerRange: string;
  satisfiedByCandidate: boolean;
}

export interface LockfileSummary {
  totalPackages: number;
  /** Best-effort attribution of transitives to direct deps (npm v3 lockfile). */
  packagesByDirectDep: Record<string, number>;
  peerDepsOnTarget: PeerDepOnTarget[];
}

export interface TransitivePackageRef {
  name: string;
  version: string;
}

export interface UpgradedPackage {
  name: string;
  from: string;
  to: string;
}

export interface TransitiveDelta {
  packagesAdded: TransitivePackageRef[];
  packagesRemoved: TransitivePackageRef[];
  packagesUpgraded: UpgradedPackage[];
}

export interface CveDeltaEntry {
  id: string;
  package: string;
  severity: CveSeverity;
  summary: string;
}

export interface CveDelta {
  newCves: CveDeltaEntry[];
  resolvedCves: CveDeltaEntry[];
}

export interface DeepCriticalBlocker {
  title: string;
  description: string;
  package: string;
}

export interface DeepUpgradeStep {
  step: number;
  action: string;
  rationale: string;
}

/** Full [D-Deep] payload — extends [D]'s deterministic data with L2 + L3 narration. */
export interface DeepUpdateReportDetail {
  fromVersion: string;
  toVersion: string;
  /** Lockfile-state hash captured at time of run (5-char short suffix). */
  lockfileStateHashShort: string;
  /** AI summary — same purpose as [D]'s summary, slightly broader scope. */
  summary: string;
  riskLevel: DeepRiskLevel;
  /** Adaptive prose; length scales with riskLevel (§7.6). */
  narrative: string;
  estimatedEffort: DeepEstimatedEffort;
  /** Deterministic pre-attached for the LLM (§11.6). */
  lockfileSummary: LockfileSummary;
  transitiveDelta: TransitiveDelta;
  cveDelta: CveDelta;
  /** LLM-judged critical blockers (peer conflicts, new high CVEs, abandonments). */
  criticalBlockers: DeepCriticalBlocker[];
  /** LLM-suggested ordering (topology-aware). */
  suggestedUpgradeOrder: DeepUpgradeStep[];
  /** Resolver block carried forward from [D]. */
  resolverCheck: ResolverCheckBlock;
  /** Co-upgrade deps from [D] (deterministic + LLM-categorized when available). */
  coUpgradeDeps: CoUpgradeDep[];
  /** Cost tracking (§11.11). Absent on deterministic-partial fallback. */
  cost?: AiCostFields;
}

// ============================================================================
// Cost summary (Stage 4 — Settings → Cost)
// ============================================================================

export interface CostSummaryEntry {
  provider: LlmProvider;
  model: string;
  count: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface CostSummaryResponse {
  slug: string;
  totalUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  count: number;
  /** Per-provider rollup. */
  byProvider: Record<LlmProvider, CostSummaryEntry[]>;
  /** Per-kind rollup (reports / deep-reports / file-reviews). */
  byKind: Record<string, { count: number; costUsd: number }>;
}

// ============================================================================
// Deep-report cost estimate (Stage 4 — first-Deep-Analyze confirmation prompt)
// ============================================================================

export interface DeepReportEstimateResponse {
  /** Heuristic input-token estimate based on lockfile size. */
  estimatedInputTokens: number;
  /** Output cap from budget. */
  estimatedOutputTokens: number;
  /** Conservative pricing × estimated tokens. */
  estimatedCostUsd: number;
  /** Active model / provider this estimate was computed for. */
  provider: LlmProvider;
  model: string;
  /** Total packages in the lockfile (visible in the FE prompt). */
  totalPackages: number;
}

// ============================================================================
// Logs clear (Stage 4 — Settings → Cache)
// ============================================================================

export interface LogsClearResponse {
  filesRemoved: number;
  bytesRemoved: number;
}
