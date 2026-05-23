/**
 * Orchestrator for the view [B] "Related deps upgrade analysis" section.
 *
 * Steps:
 *   1. Deterministic phase (offline): for each related dep, run
 *      `semver.satisfies(targetVersion, reason.range)` per reason and
 *      classify as 'compatible' | 'breaks' | 'unknown'. Always cheap, always
 *      runs.
 *   2. LLM phase: ONE batched call with all related deps + their
 *      deterministic verdicts + per-dep context (latest version, latest
 *      engines, relations). Returns structured JSON via tool schema.
 *   3. Fallback: when the LLM call fails (after retries), persist a
 *      `deterministic-partial` envelope where every dep gets action=keep
 *      when verdict='compatible' / action=investigate otherwise, with empty
 *      LLM-driven fields. UI shows what we know; user can retry later.
 *
 * Mirrors `reportService.ts`'s shape so future maintenance moves between
 * these two services with no surprises.
 */
import semver from 'semver';
import {
  RELATED_UPGRADE_TOOL_SCHEMA,
  renderRelatedUpgradePrompt,
  type RelatedUpgradePromptDep,
  type RelatedUpgradeToolOutput
} from './prompts/related-upgrade';
import { SHARED_SYSTEM_PROMPT } from './prompts/shared';
import { computeCacheKey } from './cacheKey';
import { LLMError, type LLMClient } from './client';
import { getLogger } from '../logger';
import { loadEnv } from '../config';
import type {
  AiCostFields,
  DataSource,
  DepDetail,
  RelatedDep,
  RelatedDepUpgradeRecommendation,
  RelatedUpgradeDetail
} from '../api-types';

export interface DeterministicAnalysisInput {
  viewedDep: string;
  fromVersion: string;
  toVersion: string;
  /** The viewed dep's `relatedDeps[]` from its cached DepDetail. */
  relatedDeps: ReadonlyArray<RelatedDep>;
  /**
   * Per-related-dep cached `DepDetail` payload (or null when no cache
   * exists). Used to surface latest version + latest engines as LLM context.
   * Caller is responsible for unwrapping the envelope.
   */
  relatedDetails: Record<string, DepDetail | null>;
}

/**
 * Compute the deterministic verdict for one related dep against the target
 * version. The relation's `range` was captured at the time of the related-
 * deps scan; we replay the satisfies check against `toVersion` to see whether
 * the constraint still holds.
 *
 * Returns:
 *   - 'compatible' — every relation with a range satisfies the target.
 *   - 'breaks' — at least one relation's range does NOT satisfy.
 *   - 'unknown' — no relation has a range (e.g. naming-only) so we can't
 *     compute a verdict; the LLM is asked to investigate.
 */
export function computeDeterministicVerdict(
  rel: RelatedDep,
  toVersion: string
): { verdict: 'compatible' | 'breaks' | 'unknown'; perReason: Array<boolean | null> } {
  // Track the number of reasons that actually produced a usable boolean
  // signal. A `null` reason (no range, or a malformed range that semver
  // rejected) doesn't count — we only have grounds for a confident verdict
  // when at least one parseable range was checked. This prevents the case
  // where every reason has a garbage range string and we'd otherwise fall
  // through to `compatible` (no breaks detected) when the truthful answer
  // is `unknown`.
  let parsedSignals = 0;
  let anyBreaks = false;
  const perReason: Array<boolean | null> = [];
  for (const reason of rel.reasons ?? []) {
    if (reason.range === null) {
      perReason.push(null);
      continue;
    }
    const validRange = semver.validRange(reason.range);
    if (validRange === null) {
      perReason.push(null);
      continue;
    }
    parsedSignals += 1;
    const ok = semver.satisfies(toVersion, validRange, { includePrerelease: true });
    perReason.push(ok);
    if (!ok) anyBreaks = true;
  }
  if (parsedSignals === 0) return { verdict: 'unknown', perReason };
  return { verdict: anyBreaks ? 'breaks' : 'compatible', perReason };
}

function describeReason(rel: RelatedDep, idx: number, viewedDep: string): string {
  const r = rel.reasons[idx];
  if (r === undefined) return '';
  switch (r.kind) {
    case 'inbound-engine':
      return `[engine ←] ${rel.name} declares engines.${viewedDep}${r.range !== null ? ` = ${r.range}` : ''}`;
    case 'outbound-engine':
      return `[engine →] ${viewedDep} declares engines.${rel.name}${r.range !== null ? ` = ${r.range}` : ''}`;
    case 'inbound-peer-dep':
      return `[peer ←] ${rel.name} declares peerDependencies.${viewedDep}${r.range !== null ? ` = ${r.range}` : ''}`;
    case 'outbound-peer-dep':
      return `[peer →] ${viewedDep} declares peerDependencies.${rel.name}${r.range !== null ? ` = ${r.range}` : ''}`;
    case 'naming':
      return `[naming] typings/companion of ${viewedDep} (moves in lockstep)`;
    default:
      return '';
  }
}

/**
 * Build the deterministic skeleton — used both as input to the LLM and as
 * the persisted output when the LLM call fails. Every related dep gets a
 * verdict, relations array, and a default action derived from the verdict.
 */
export function buildSkeleton(
  input: DeterministicAnalysisInput
): { skeleton: RelatedDepUpgradeRecommendation[]; promptDeps: RelatedUpgradePromptDep[] } {
  const skeleton: RelatedDepUpgradeRecommendation[] = [];
  const promptDeps: RelatedUpgradePromptDep[] = [];
  for (const rel of input.relatedDeps) {
    const { verdict, perReason } = computeDeterministicVerdict(rel, input.toVersion);
    const relations = (rel.reasons ?? []).map((reason, idx) => ({
      kind: reason.kind,
      range: reason.range,
      satisfiedAtTarget: perReason[idx] ?? null
    }));
    skeleton.push({
      name: rel.name,
      installedVersion: rel.installedVersion,
      relations,
      deterministicVerdict: verdict,
      // Defaults — LLM will overwrite when its call succeeds.
      action: verdict === 'compatible' ? 'keep' : 'investigate',
      suggestedVersion: null,
      severity: 'none',
      migrationNotes: '',
      confidence: 'low'
    });
    const detail = input.relatedDetails[rel.name] ?? null;
    promptDeps.push({
      name: rel.name,
      installedVersion: rel.installedVersion,
      deterministicVerdict: verdict,
      relationSummaries: (rel.reasons ?? []).map((_, i) => describeReason(rel, i, input.viewedDep)),
      latestAvailableVersion: detail?.availableVersions[0]?.version ?? null,
      latestEngines: detail?.latestEngines ?? {}
    });
  }
  return { skeleton, promptDeps };
}

export interface RunRelatedUpgradeInput extends DeterministicAnalysisInput {
  model: string;
  maxOutputTokens?: number;
  maxInputTokens?: number;
  onPhase?: Parameters<LLMClient['call']>[0]['onPhase'];
  signal?: AbortSignal;
}

export interface RelatedUpgradeRun {
  cacheKey: string;
  detail: RelatedUpgradeDetail;
  source: DataSource;
  llmError?: LLMError;
}

export async function runRelatedUpgrade(
  client: LLMClient,
  input: RunRelatedUpgradeInput
): Promise<RelatedUpgradeRun> {
  const { skeleton, promptDeps } = buildSkeleton(input);
  const promptInput = {
    viewedDep: {
      name: input.viewedDep,
      fromVersion: input.fromVersion,
      toVersion: input.toVersion
    },
    deps: promptDeps
  };
  const userPrompt = renderRelatedUpgradePrompt(promptInput);
  const env = loadEnv();
  const maxOutput = input.maxOutputTokens ?? env.budgets.updateReport.output;
  const maxInput = input.maxInputTokens ?? env.budgets.updateReport.input;
  const cacheKey = computeCacheKey({
    systemPrompt: SHARED_SYSTEM_PROMPT,
    userPrompt,
    tool: RELATED_UPGRADE_TOOL_SCHEMA,
    model: input.model
  });

  // Empty list short-circuit — no point calling the LLM with 0 deps.
  if (input.relatedDeps.length === 0) {
    return {
      cacheKey,
      detail: {
        viewedDep: input.viewedDep,
        fromVersion: input.fromVersion,
        toVersion: input.toVersion,
        globalNotes: 'No related deps detected. Re-run the related-deps scan from view [A] if you expected entries here.',
        recommendations: []
      },
      source: 'deterministic-partial'
    };
  }

  let llmResult: { output: RelatedUpgradeToolOutput; tokens: AiCostFields; source: DataSource } | null = null;
  let llmError: LLMError | undefined;
  try {
    const call = await client.call<RelatedUpgradeToolOutput>({
      model: input.model,
      systemPrompt: SHARED_SYSTEM_PROMPT,
      userPrompt,
      tool: RELATED_UPGRADE_TOOL_SCHEMA,
      maxOutputTokens: maxOutput,
      maxInputTokens: maxInput,
      onPhase: input.onPhase,
      signal: input.signal
    });
    llmResult = {
      output: call.output,
      tokens: {
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        model: call.model,
        costEstimateUsd: call.costEstimateUsd
      },
      source: `${call.provider}:${call.model}` as DataSource
    };
  } catch (err) {
    llmError = err instanceof LLMError ? err : new LLMError('LLM_NETWORK', (err as Error).message, false);
    const log = await getLogger();
    log.warn(
      { err: llmError.message, code: llmError.code },
      'Related-upgrade analysis LLM call failed'
    );
  }

  if (llmResult !== null) {
    // Merge LLM output back onto the deterministic skeleton — match by name,
    // fall back to skeleton defaults for any dep the LLM skipped or mangled.
    const byName = new Map<string, RelatedUpgradeToolOutput['deps'][number]>();
    for (const d of llmResult.output.deps ?? []) {
      if (typeof d?.name === 'string') byName.set(d.name, d);
    }
    const recommendations: RelatedDepUpgradeRecommendation[] = skeleton.map((s) => {
      const llm = byName.get(s.name);
      if (llm === undefined) return s;
      return {
        ...s,
        action: cleanAction(llm.action) ?? s.action,
        suggestedVersion: typeof llm.suggestedVersion === 'string' && llm.suggestedVersion !== ''
          ? llm.suggestedVersion
          : null,
        severity: cleanSeverity(llm.severity) ?? s.severity,
        migrationNotes: typeof llm.migrationNotes === 'string' ? llm.migrationNotes : '',
        confidence: cleanConfidence(llm.confidence) ?? s.confidence
      };
    });
    return {
      cacheKey,
      detail: {
        viewedDep: input.viewedDep,
        fromVersion: input.fromVersion,
        toVersion: input.toVersion,
        globalNotes:
          typeof llmResult.output.globalNotes === 'string' ? llmResult.output.globalNotes : '',
        recommendations,
        cost: llmResult.tokens
      },
      source: llmResult.source
    };
  }

  // Deterministic-partial fallback — same shape, no LLM-driven fields filled.
  return {
    cacheKey,
    detail: {
      viewedDep: input.viewedDep,
      fromVersion: input.fromVersion,
      toVersion: input.toVersion,
      globalNotes:
        'AI analysis unavailable. Showing deterministic compatibility verdict only. Click Regenerate to retry.',
      recommendations: skeleton
    },
    source: 'deterministic-partial',
    llmError
  };
}

function cleanAction(value: unknown): RelatedDepUpgradeRecommendation['action'] | null {
  const allowed: ReadonlyArray<RelatedDepUpgradeRecommendation['action']> = ['keep', 'upgrade', 'investigate'];
  return allowed.includes(value as RelatedDepUpgradeRecommendation['action'])
    ? (value as RelatedDepUpgradeRecommendation['action'])
    : null;
}

function cleanSeverity(value: unknown): RelatedDepUpgradeRecommendation['severity'] | null {
  const allowed: ReadonlyArray<RelatedDepUpgradeRecommendation['severity']> = ['patch', 'minor', 'major', 'none'];
  return allowed.includes(value as RelatedDepUpgradeRecommendation['severity'])
    ? (value as RelatedDepUpgradeRecommendation['severity'])
    : null;
}

function cleanConfidence(value: unknown): RelatedDepUpgradeRecommendation['confidence'] | null {
  const allowed: ReadonlyArray<RelatedDepUpgradeRecommendation['confidence']> = ['high', 'medium', 'low'];
  return allowed.includes(value as RelatedDepUpgradeRecommendation['confidence'])
    ? (value as RelatedDepUpgradeRecommendation['confidence'])
    : null;
}
