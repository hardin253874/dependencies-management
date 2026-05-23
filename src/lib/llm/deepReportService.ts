/**
 * View [D-Deep] orchestrator (spec §7.6, §11, §11.6).
 *
 * Inputs (deterministic):
 *   - Pre-computed deep-scan output (lockfileSummary, transitiveDelta, cveDelta)
 *   - Co-upgrade candidate names (from [D] computation upstream)
 *   - Resolver check carry-over (summary string)
 *
 * Steps:
 *   1. Render the deep-update-report prompt.
 *   2. Compute the cache key (sha256 of prompt + tool + model).
 *   3. Call the LLM (or mock).
 *   4. On success: persist envelope with `source: anthropic:<model>` / `openai:<model>` and cost fields.
 *   5. On LLM failure (after retries): persist deterministic-partial envelope with
 *      `source: deterministic-partial`, skeleton AI fields.
 *
 * Pure orchestration — no filesystem writes. The route handler is responsible
 * for persisting the result via `writeEnvelope`.
 */
import {
  renderDeepUpdateReportPrompt,
  DEEP_UPDATE_REPORT_TOOL_SCHEMA,
  type DeepUpdateReportPromptInput,
  type DeepUpdateReportToolOutput
} from './prompts/deep-update-report';
import { SHARED_SYSTEM_PROMPT } from './prompts/shared';
import { computeCacheKey } from './cacheKey';
import { LLMError, type LLMClient } from './client';
import { getLogger } from '../logger';
import { loadEnv } from '../config';
import type {
  AiCostFields,
  CoUpgradeDep,
  CveDelta,
  DataSource,
  DeepCriticalBlocker,
  DeepEstimatedEffort,
  DeepRiskLevel,
  DeepUpdateReportDetail,
  DeepUpgradeStep,
  LockfileSummary,
  ResolverCheckBlock,
  TransitiveDelta
} from '../api-types';

export interface RunDeepUpdateReportInput {
  /** Mostly the rendering inputs the prompt sees. */
  promptInput: DeepUpdateReportPromptInput;
  /** Active model. */
  model: string;
  /** Token budget overrides; defaults from env budgets. */
  maxInputTokens?: number;
  maxOutputTokens?: number;
  /** Deterministic blocks the orchestrator merges into the final detail. */
  fromVersion: string;
  toVersion: string;
  lockfileStateHashShort: string;
  resolverBlock: ResolverCheckBlock;
  coUpgradeDeps: CoUpgradeDep[];
  lockfileSummary: LockfileSummary;
  transitiveDelta: TransitiveDelta;
  cveDelta: CveDelta;
  /** Streaming phase events. */
  onPhase?: Parameters<LLMClient['call']>[0]['onPhase'];
  signal?: AbortSignal;
}

export interface DeepUpdateReportRun {
  cacheKey: string;
  detail: DeepUpdateReportDetail;
  source: DataSource;
  llmError?: LLMError;
}

export function buildDeepDeterministicSkeleton(opts: {
  promptInput: DeepUpdateReportPromptInput;
  fromVersion: string;
  toVersion: string;
  lockfileStateHashShort: string;
  resolverBlock: ResolverCheckBlock;
  coUpgradeDeps: CoUpgradeDep[];
  lockfileSummary: LockfileSummary;
  transitiveDelta: TransitiveDelta;
  cveDelta: CveDelta;
}): DeepUpdateReportDetail {
  // Choose a conservative risk level from the deterministic data:
  //  - critical: any unsatisfied peer-dep OR a new CVE with severity high|critical
  //  - high: any new CVE OR any unsatisfied peer-dep
  //  - medium: default fallback
  const hasUnsatisfiedPeer = opts.lockfileSummary.peerDepsOnTarget.some(
    (p) => !p.satisfiedByCandidate
  );
  const hasCriticalCve = opts.cveDelta.newCves.some(
    (c) => c.severity === 'critical' || c.severity === 'high'
  );
  let riskLevel: DeepRiskLevel = 'medium';
  if (hasCriticalCve || (hasUnsatisfiedPeer && opts.cveDelta.newCves.length > 0)) {
    riskLevel = 'critical';
  } else if (hasUnsatisfiedPeer || opts.cveDelta.newCves.length > 0) {
    riskLevel = 'high';
  }

  return {
    fromVersion: opts.fromVersion,
    toVersion: opts.toVersion,
    lockfileStateHashShort: opts.lockfileStateHashShort,
    summary: '',
    riskLevel,
    narrative: '',
    estimatedEffort: 'medium',
    lockfileSummary: opts.lockfileSummary,
    transitiveDelta: opts.transitiveDelta,
    cveDelta: opts.cveDelta,
    criticalBlockers: [],
    suggestedUpgradeOrder: [],
    resolverCheck: opts.resolverBlock,
    coUpgradeDeps: opts.coUpgradeDeps
  };
}

export async function runDeepUpdateReport(
  client: LLMClient,
  input: RunDeepUpdateReportInput
): Promise<DeepUpdateReportRun> {
  const userPrompt = renderDeepUpdateReportPrompt(input.promptInput);
  const env = loadEnv();
  const maxInput = input.maxInputTokens ?? env.budgets.deepReport.input;
  const maxOutput = input.maxOutputTokens ?? env.budgets.deepReport.output;
  const cacheKey = computeCacheKey({
    systemPrompt: SHARED_SYSTEM_PROMPT,
    userPrompt,
    tool: DEEP_UPDATE_REPORT_TOOL_SCHEMA,
    model: input.model
  });

  let llmResult: {
    output: DeepUpdateReportToolOutput;
    tokens: AiCostFields;
    source: DataSource;
  } | null = null;
  let llmError: LLMError | undefined;

  try {
    const call = await client.call<DeepUpdateReportToolOutput>({
      model: input.model,
      systemPrompt: SHARED_SYSTEM_PROMPT,
      userPrompt,
      tool: DEEP_UPDATE_REPORT_TOOL_SCHEMA,
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
    log.warn({ err: llmError.message, code: llmError.code }, 'Deep update report LLM call failed');
  }

  if (llmResult !== null) {
    const detail: DeepUpdateReportDetail = {
      fromVersion: input.fromVersion,
      toVersion: input.toVersion,
      lockfileStateHashShort: input.lockfileStateHashShort,
      summary: llmResult.output.summary,
      riskLevel: normalizeRiskLevel(llmResult.output.riskLevel),
      narrative: llmResult.output.narrative,
      estimatedEffort: normalizeEffort(llmResult.output.estimatedEffort),
      lockfileSummary: input.lockfileSummary,
      transitiveDelta: input.transitiveDelta,
      cveDelta: input.cveDelta,
      criticalBlockers: cleanBlockers(llmResult.output.criticalBlockers),
      suggestedUpgradeOrder: cleanSteps(llmResult.output.suggestedUpgradeOrder),
      resolverCheck: input.resolverBlock,
      coUpgradeDeps: input.coUpgradeDeps,
      cost: llmResult.tokens
    };
    return { cacheKey, detail, source: llmResult.source };
  }

  // Deterministic-partial fallback (spec §11.9).
  const skeleton = buildDeepDeterministicSkeleton({
    promptInput: input.promptInput,
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    lockfileStateHashShort: input.lockfileStateHashShort,
    resolverBlock: input.resolverBlock,
    coUpgradeDeps: input.coUpgradeDeps,
    lockfileSummary: input.lockfileSummary,
    transitiveDelta: input.transitiveDelta,
    cveDelta: input.cveDelta
  });
  return { cacheKey, detail: skeleton, source: 'deterministic-partial', llmError };
}

function normalizeRiskLevel(value: unknown): DeepRiskLevel {
  const allowed: ReadonlyArray<DeepRiskLevel> = ['low', 'medium', 'high', 'critical'];
  return allowed.includes(value as DeepRiskLevel) ? (value as DeepRiskLevel) : 'high';
}

function normalizeEffort(value: unknown): DeepEstimatedEffort {
  const allowed: ReadonlyArray<DeepEstimatedEffort> = ['small', 'medium', 'large', 'very-large'];
  return allowed.includes(value as DeepEstimatedEffort)
    ? (value as DeepEstimatedEffort)
    : 'medium';
}

function cleanBlockers(arr: unknown): DeepCriticalBlocker[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map((e) => ({
      title: String(e.title ?? ''),
      description: String(e.description ?? ''),
      package: String(e.package ?? '')
    }))
    .filter((e) => e.title !== '' || e.description !== '');
}

function cleanSteps(arr: unknown): DeepUpgradeStep[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map((e, i) => ({
      step: typeof e.step === 'number' ? Math.floor(e.step) : i + 1,
      action: String(e.action ?? ''),
      rationale: String(e.rationale ?? '')
    }))
    .filter((e) => e.action !== '');
}
