/**
 * Deep-report cost estimate (Stage 4 — first-Deep-Analyze confirmation).
 *
 * Pure-function assertions on the heuristic. Verifies the estimate scales with
 * package count, respects the cap, and uses the same cost-table as the actual
 * persisted cost field.
 */
import { describe, it, expect } from 'vitest';
import {
  computeDeepReportEstimate,
  ESTIMATE_BASE_TOKENS,
  ESTIMATE_TOKENS_PER_PACKAGE,
  ESTIMATE_INPUT_CAP
} from '@/lib/llm/estimate';
import { costEstimateUsd } from '@/lib/llm/cost';

describe('computeDeepReportEstimate', () => {
  it('scales linearly with package count', () => {
    const a = computeDeepReportEstimate({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      totalPackages: 100,
      outputBudgetTokens: 8000
    });
    const b = computeDeepReportEstimate({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      totalPackages: 1000,
      outputBudgetTokens: 8000
    });
    expect(b.estimatedInputTokens).toBeGreaterThan(a.estimatedInputTokens);
    expect(b.estimatedInputTokens - a.estimatedInputTokens).toBe(
      900 * ESTIMATE_TOKENS_PER_PACKAGE
    );
  });

  it('respects the 100k input cap', () => {
    const out = computeDeepReportEstimate({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      totalPackages: 1_000_000,
      outputBudgetTokens: 8000
    });
    expect(out.estimatedInputTokens).toBe(ESTIMATE_INPUT_CAP);
  });

  it('returns ESTIMATE_BASE_TOKENS for an empty project', () => {
    const out = computeDeepReportEstimate({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      totalPackages: 0,
      outputBudgetTokens: 8000
    });
    expect(out.estimatedInputTokens).toBe(ESTIMATE_BASE_TOKENS);
  });

  it('cost matches the same table used for persisted envelopes', () => {
    const totalPackages = 1500;
    const out = computeDeepReportEstimate({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      totalPackages,
      outputBudgetTokens: 8000
    });
    const expected = costEstimateUsd(
      'anthropic',
      'claude-opus-4-7',
      out.estimatedInputTokens,
      out.estimatedOutputTokens
    );
    expect(out.estimatedCostUsd).toBe(expected);
  });

  it('honours the chosen provider/model pricing', () => {
    const anthropic = computeDeepReportEstimate({
      provider: 'anthropic',
      model: 'claude-3-5-haiku-latest',
      totalPackages: 500,
      outputBudgetTokens: 8000
    });
    const openai = computeDeepReportEstimate({
      provider: 'openai',
      model: 'gpt-4o-mini',
      totalPackages: 500,
      outputBudgetTokens: 8000
    });
    // Both estimates depend on input/output prices — they differ by model/provider.
    expect(anthropic.estimatedCostUsd).not.toBe(openai.estimatedCostUsd);
    // Mini models are cheaper than full-tier — sanity check sign.
    expect(openai.estimatedCostUsd).toBeLessThan(0.1);
    expect(anthropic.estimatedCostUsd).toBeLessThan(0.1);
  });
});
