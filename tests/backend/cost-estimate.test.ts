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
    const expected = costEstimateUsd('claude-opus-4-7', {
      inputTokens: out.estimatedInputTokens,
      outputTokens: out.estimatedOutputTokens
    });
    expect(out.estimatedCostUsd).toBe(expected);
  });

  it('honours the chosen model pricing', () => {
    const haiku = computeDeepReportEstimate({
      provider: 'anthropic',
      model: 'claude-3-5-haiku-latest',
      totalPackages: 500,
      outputBudgetTokens: 8000
    });
    const opus = computeDeepReportEstimate({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      totalPackages: 500,
      outputBudgetTokens: 8000
    });
    // Both estimates depend on input/output prices — they differ by model.
    expect(haiku.estimatedCostUsd).not.toBe(opus.estimatedCostUsd);
    // The small model is cheaper than the top tier — sanity check sign.
    expect(haiku.estimatedCostUsd).toBeLessThan(opus.estimatedCostUsd);
    expect(haiku.estimatedCostUsd).toBeLessThan(0.1);
  });
});

describe('costEstimateUsd — cache-aware pricing (v2 Stage 1.3)', () => {
  it('without cache fields it equals the plain input/output formula', () => {
    // opus-4-7: $5 in / $25 out per MTok.
    expect(costEstimateUsd('claude-opus-4-7', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(30);
    expect(
      costEstimateUsd('claude-opus-4-7', {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0
      })
    ).toBe(costEstimateUsd('claude-opus-4-7', { inputTokens: 1000, outputTokens: 500 }));
  });

  it('1M cache-read tokens on claude-opus-5-5 cost $0.20', () => {
    expect(
      costEstimateUsd('claude-opus-5-5', { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 1_000_000 })
    ).toBe(0.2);
  });

  it('1M 5-minute cache-write tokens cost 1.25× the input price', () => {
    for (const [model, inputPrice] of [
      ['claude-opus-5-5', 4],
      ['claude-sonnet-5-5', 2],
      ['claude-opus-4-7', 5]
    ] as const) {
      expect(
        costEstimateUsd(model, { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 1_000_000 })
      ).toBeCloseTo(inputPrice * 1.25, 6);
    }
  });

  it('claude-haiku-5-5 switches to the long-prompt tier above 100K prompt tokens (cache tokens count)', () => {
    // ≤ 100K prompt: $0.10 in / $0.50 out.
    expect(costEstimateUsd('claude-haiku-5-5', { inputTokens: 100_000, outputTokens: 1_000_000 })).toBe(0.51);
    // 60K uncached + 50K cache read = 110K prompt → every category at the high tier
    // ($0.50 in, $0.05 read, $2.50 out).
    expect(
      costEstimateUsd('claude-haiku-5-5', {
        inputTokens: 60_000,
        outputTokens: 1_000_000,
        cacheReadInputTokens: 50_000
      })
    ).toBeCloseTo(0.06 * 0.5 + 0.05 * 0.05 + 2.5, 6);
  });

  it('an unknown model uses the conservative FALLBACK, never 0', () => {
    const c = costEstimateUsd('claude-unknown-9', { inputTokens: 1_000_000, outputTokens: 0 });
    expect(c).toBeGreaterThan(0);
    expect(c).toBeGreaterThanOrEqual(costEstimateUsd('claude-opus-5-5', { inputTokens: 1_000_000, outputTokens: 0 }));
  });
});
