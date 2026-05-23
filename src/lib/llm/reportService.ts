/**
 * View [D] orchestrator (spec §11 + §10.7).
 *
 * Inputs (deterministic):
 *   - project.json (direct deps + installed versions)
 *   - target's package.json (peer deps of the candidate target version)
 *   - usage payload (affected files)
 *   - resolver check result (or null when disabled)
 *   - co-upgrade candidates (algorithm output)
 *
 * Steps:
 *   1. Build the deterministic input contract for the LLM.
 *   2. Render the prompt (Mustache).
 *   3. Compute the cache key (sha256 of prompt + tool + model).
 *   4. Call the LLM (or mock).
 *   5. On success: persist envelope with `source: anthropic:<model>` or
 *      `openai:<model>`, cost fields, plus full UpdateReportDetail.
 *   6. On LLM failure (after retries): persist deterministic-partial envelope
 *      with `source: deterministic-partial`, skeleton AI fields.
 *
 * The route handler is responsible for wiring everything together — this file
 * is the pure orchestration logic so it's straightforward to unit-test.
 */
import { renderUpdateReportPrompt, UPDATE_REPORT_TOOL_SCHEMA, type UpdateReportPromptInput, type UpdateReportToolOutput } from './prompts/update-report';
import { SHARED_SYSTEM_PROMPT } from './prompts/shared';
import { computeCacheKey } from './cacheKey';
import { LLMError, type LLMClient } from './client';
import { getLogger } from '../logger';
import { loadEnv } from '../config';
import type {
  AiCostFields,
  BreakingChange,
  CoUpgradeDep,
  FileToModify,
  ResolverCheckBlock,
  RiskLevel,
  UpdateReportDetail,
  DataSource
} from '../api-types';

export interface RunUpdateReportInput {
  promptInput: UpdateReportPromptInput;
  /** `_config.json.llm.model` — included in cache key + persisted envelope. */
  model: string;
  /** Spec §11.3 output cap. */
  maxOutputTokens?: number;
  /** Spec §11.3 input cap. */
  maxInputTokens?: number;
  /** Resolver check block to embed in the persisted detail. */
  resolverBlock: ResolverCheckBlock;
  /** From/to surfaces in the persisted detail without re-render. */
  fromVersion: string;
  toVersion: string;
  /**
   * Optional per-candidate source attribution from `computeCoUpgradeCandidates`.
   * Used by the deterministic-partial skeleton (Stage 3 M2) so the `reason`
   * field reflects peer-conflict precedence on the fallback path.
   */
  candidateSources?: Record<string, ReadonlyArray<string>>;
  /** Forwarded to the LLM client. */
  onPhase?: Parameters<LLMClient['call']>[0]['onPhase'];
  signal?: AbortSignal;
}

export interface UpdateReportRun {
  cacheKey: string;
  detail: UpdateReportDetail;
  source: DataSource;
  /** Set when source === 'deterministic-partial'. */
  llmError?: LLMError;
}

/**
 * Build a deterministic-partial detail used both as a fallback when the LLM
 * fails *and* as the canonical skeleton the LLM fills in.
 *
 * Co-upgrade reason precedence (Stage 3 review M2): when the algorithm flagged
 * a candidate via a peer-range conflict (source `peer-range-conflict`), pick
 * `peer-dep` over `common-pairing` since the constraint is authoritative.
 * Without source info we fall back to the peer-range presence heuristic.
 */
export function buildDeterministicSkeleton(opts: {
  promptInput: UpdateReportPromptInput;
  resolverBlock: ResolverCheckBlock;
  fromVersion: string;
  toVersion: string;
  /** Optional source attribution from `computeCoUpgradeCandidates`. */
  candidateSources?: Record<string, ReadonlyArray<string>>;
}): UpdateReportDetail {
  const coUpgradeDeps: CoUpgradeDep[] = opts.promptInput.candidateCoUpgrades.map((c) => {
    const sources = opts.candidateSources?.[c.name] ?? [];
    const hasPeer = sources.includes('peer-dep') || sources.includes('peer-range-conflict');
    const hasPairing = sources.includes('common-pairing');
    let reason: CoUpgradeDep['reason'];
    if (hasPeer) {
      reason = 'peer-dep';
    } else if (hasPairing) {
      reason = 'common-pairing';
    } else if (c.declaredPeerDepRange !== null) {
      reason = 'peer-dep';
    } else {
      reason = 'common-pairing';
    }
    return {
      name: c.name,
      currentVersion: c.currentVersion ?? 'unknown',
      suggestedVersion: '',
      required: hasPeer, // conservative — peer-conflict implies required
      reason,
      explanation: ''
    };
  });
  return {
    fromVersion: opts.fromVersion,
    toVersion: opts.toVersion,
    summary: '',
    riskLevel: 'medium' as RiskLevel, // conservative default; LLM may override
    resolverCheck: opts.resolverBlock,
    coUpgradeDeps,
    breakingChanges: [],
    filesToModify: [],
    recommendations: []
  };
}

export async function runUpdateReport(
  client: LLMClient,
  input: RunUpdateReportInput
): Promise<UpdateReportRun> {
  const userPrompt = renderUpdateReportPrompt(input.promptInput);
  const env = loadEnv();
  const maxOutput = input.maxOutputTokens ?? env.budgets.updateReport.output;
  const cacheKey = computeCacheKey({
    systemPrompt: SHARED_SYSTEM_PROMPT,
    userPrompt,
    tool: UPDATE_REPORT_TOOL_SCHEMA,
    model: input.model
  });

  let llmResult: { output: UpdateReportToolOutput; tokens: AiCostFields; source: DataSource } | null = null;
  let llmError: LLMError | undefined;
  try {
    const call = await client.call<UpdateReportToolOutput>({
      model: input.model,
      systemPrompt: SHARED_SYSTEM_PROMPT,
      userPrompt,
      tool: UPDATE_REPORT_TOOL_SCHEMA,
      maxOutputTokens: maxOutput,
      maxInputTokens: input.maxInputTokens ?? env.budgets.updateReport.input,
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
    log.warn({ err: llmError.message, code: llmError.code }, 'Update report LLM call failed');
  }

  if (llmResult !== null) {
    const detail: UpdateReportDetail = {
      fromVersion: input.fromVersion,
      toVersion: input.toVersion,
      summary: llmResult.output.summary,
      riskLevel: llmResult.output.riskLevel,
      resolverCheck: input.resolverBlock,
      breakingChanges: cleanBreakingChanges(llmResult.output.breakingChanges),
      coUpgradeDeps: cleanCoUpgradeDeps(llmResult.output.coUpgradeDeps),
      filesToModify: cleanFilesToModify(llmResult.output.filesToModify),
      recommendations: Array.isArray(llmResult.output.recommendations)
        ? llmResult.output.recommendations.map((s) => String(s))
        : [],
      cost: llmResult.tokens
    };
    return { cacheKey, detail, source: llmResult.source };
  }

  // Deterministic-partial fallback (spec §11.9).
  const skeleton = buildDeterministicSkeleton({
    promptInput: input.promptInput,
    resolverBlock: input.resolverBlock,
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    candidateSources: input.candidateSources
  });
  return { cacheKey, detail: skeleton, source: 'deterministic-partial', llmError };
}

function cleanBreakingChanges(arr: unknown): BreakingChange[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map((e) => ({
      title: String(e.title ?? ''),
      description: String(e.description ?? ''),
      affectsFilesInProject: Boolean(e.affectsFilesInProject)
    }))
    .filter((e) => e.title !== '' || e.description !== '');
}

function cleanCoUpgradeDeps(arr: unknown): CoUpgradeDep[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map((e) => ({
      name: String(e.name ?? ''),
      currentVersion: String(e.currentVersion ?? ''),
      suggestedVersion: String(e.suggestedVersion ?? ''),
      required: Boolean(e.required),
      reason: normalizeReason(e.reason),
      explanation: String(e.explanation ?? '')
    }))
    .filter((e) => e.name !== '');
}

function normalizeReason(value: unknown): CoUpgradeDep['reason'] {
  const allowed: ReadonlyArray<CoUpgradeDep['reason']> = ['peer-dep', 'common-pairing', 'co-version', 'ecosystem'];
  return allowed.includes(value as CoUpgradeDep['reason']) ? (value as CoUpgradeDep['reason']) : 'common-pairing';
}

function cleanFilesToModify(arr: unknown): FileToModify[] {
  if (!Array.isArray(arr)) return [];
  const allowed: ReadonlyArray<FileToModify['estimatedChangeSize']> = ['small', 'medium', 'large'];
  return arr
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map((e) => ({
      path: String(e.path ?? ''),
      brief: String(e.brief ?? ''),
      estimatedChangeSize: allowed.includes(e.estimatedChangeSize as FileToModify['estimatedChangeSize'])
        ? (e.estimatedChangeSize as FileToModify['estimatedChangeSize'])
        : 'medium'
    }))
    .filter((e) => e.path !== '');
}
