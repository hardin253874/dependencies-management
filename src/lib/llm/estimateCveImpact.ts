/**
 * Cost estimation for the CVE impact analyzer (v0.6, view [A] "Analyze Usage").
 *
 * Heuristic: input tokens scale with (cveCount × per-CVE overhead) + (files
 * × average context-window size). Output tokens are capped at the budget.
 * Same pattern as `estimate.ts` (Deep Report) but tuned to this feature's
 * inputs. Intentionally overestimates so the confirmation prompt shows the
 * worst-case number.
 *
 * Mirrors the Deep Report estimate's contract: the modal shows the resulting
 * USD figure plus context (cveCount, filesInUsage, model/provider).
 */
import { costEstimateUsd } from './cost';
import type { CveImpactEstimateResponse, LlmProvider } from '../api-types';

/** Fixed prompt template overhead (system prompt + instructions). */
export const CVE_IMPACT_ESTIMATE_BASE_TOKENS = 1500;
/** Per-CVE prompt overhead — id + severity + summary line. */
export const CVE_IMPACT_ESTIMATE_TOKENS_PER_CVE = 80;
/**
 * Average tokens per file's coalesced context. Conservative: a typical file
 * with 1–2 use sites + the import line at ±20-line radius runs ~600 chars =
 * ~150 tokens; we round up for safety. The extractor's hard cap is 30k
 * tokens regardless of this estimate.
 */
export const CVE_IMPACT_ESTIMATE_TOKENS_PER_FILE = 250;
/** Mirror the runtime cap from importSiteContext.ts. */
export const CVE_IMPACT_ESTIMATE_INPUT_CAP = 30_000;

export interface CveImpactEstimateInput {
  provider: LlmProvider;
  model: string;
  cveCount: number;
  filesInUsage: number;
  usageCacheExists: boolean;
  outputBudgetTokens: number;
}

export function computeCveImpactEstimate(
  input: CveImpactEstimateInput
): CveImpactEstimateResponse {
  const rawInput =
    CVE_IMPACT_ESTIMATE_BASE_TOKENS +
    input.cveCount * CVE_IMPACT_ESTIMATE_TOKENS_PER_CVE +
    input.filesInUsage * CVE_IMPACT_ESTIMATE_TOKENS_PER_FILE;
  const estimatedInputTokens = Math.min(rawInput, CVE_IMPACT_ESTIMATE_INPUT_CAP);
  const estimatedOutputTokens = input.outputBudgetTokens;
  const estimatedCostUsd = costEstimateUsd(
    input.provider,
    input.model,
    estimatedInputTokens,
    estimatedOutputTokens
  );
  return {
    cveCount: input.cveCount,
    filesInUsage: input.filesInUsage,
    usageCacheExists: input.usageCacheExists,
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedCostUsd,
    provider: input.provider,
    model: input.model
  };
}
