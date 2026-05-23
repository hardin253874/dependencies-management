/**
 * Deep-report cost estimation (Stage 4 — first-Deep-Analyze confirmation).
 *
 * Conservative heuristic: total prompt tokens scale roughly linearly with the
 * lockfile package count, plus a base for the prompt template. Pricing comes
 * from `cost.ts` (the same table that powers the Cost panel).
 *
 * The estimate is intentionally overestimated so the actual call rarely
 * exceeds it. The user sees the worst-case number in the confirmation prompt.
 *
 * Spec §7.6, §11.11, §13 iteration point #7.
 */
import { costEstimateUsd } from './cost';
import type { DeepReportEstimateResponse, LlmProvider } from '../api-types';

export interface EstimateInput {
  provider: LlmProvider;
  model: string;
  /** Total packages in the lockfile (sum of direct + transitives). */
  totalPackages: number;
  /** Output budget cap (used as-is for output estimate). */
  outputBudgetTokens: number;
}

/**
 * Heuristic: each transitive contributes ~6 tokens to the prompt (name + range
 * + minimal metadata). Add a 1.5k-token base for template + instructions.
 * Cap at the deep-report budget (100k input).
 */
export const ESTIMATE_BASE_TOKENS = 1500;
export const ESTIMATE_TOKENS_PER_PACKAGE = 6;
export const ESTIMATE_INPUT_CAP = 100_000;

export function computeDeepReportEstimate(input: EstimateInput): DeepReportEstimateResponse {
  const rawInput = ESTIMATE_BASE_TOKENS + input.totalPackages * ESTIMATE_TOKENS_PER_PACKAGE;
  const estimatedInputTokens = Math.min(rawInput, ESTIMATE_INPUT_CAP);
  const estimatedOutputTokens = input.outputBudgetTokens;
  const estimatedCostUsd = costEstimateUsd(
    input.provider,
    input.model,
    estimatedInputTokens,
    estimatedOutputTokens
  );
  return {
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedCostUsd,
    provider: input.provider,
    model: input.model,
    totalPackages: input.totalPackages
  };
}
