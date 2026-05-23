/**
 * Cost estimation table (spec §11.11).
 *
 * Pricing per **million tokens** for production models. Values are a snapshot
 * at v1 cut and intentionally conservative — they over-estimate slightly so
 * the Cost panel never under-reports. v1.x can move these to `_config.json`
 * (Settings → Cost section) for user-editable refresh.
 *
 * Numbers are USD per 1M tokens (input | output). Unknown models default to
 * the family's highest tier so we never under-estimate.
 */

import type { LlmProvider } from '../api-types';

interface Pricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

const ANTHROPIC_PRICING: Record<string, Pricing> = {
  // Claude 3.5 family
  'claude-3-5-sonnet-latest': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  'claude-3-5-sonnet-20241022': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  'claude-3-5-haiku-latest': { inputPerMillion: 0.8, outputPerMillion: 4.0 },
  'claude-3-5-haiku-20241022': { inputPerMillion: 0.8, outputPerMillion: 4.0 },
  // Claude 3 family
  'claude-3-opus-latest': { inputPerMillion: 15.0, outputPerMillion: 75.0 },
  'claude-3-opus-20240229': { inputPerMillion: 15.0, outputPerMillion: 75.0 },
  // Opus 4 family (placeholder pricing — refine when public pricing lands)
  'claude-opus-4-7': { inputPerMillion: 15.0, outputPerMillion: 75.0 }
};

const OPENAI_PRICING: Record<string, Pricing> = {
  // GPT-4o family
  'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10.0 },
  'gpt-4o-2024-11-20': { inputPerMillion: 2.5, outputPerMillion: 10.0 },
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  // GPT-5 placeholder — over-estimate
  'gpt-5': { inputPerMillion: 5.0, outputPerMillion: 20.0 },
  'gpt-5.5': { inputPerMillion: 5.0, outputPerMillion: 20.0 }
};

/**
 * Conservative fallback pricing — used when a model name isn't in the table.
 * Better to over-estimate than to silently zero out a real spend.
 */
const FALLBACK: Pricing = { inputPerMillion: 10.0, outputPerMillion: 30.0 };

export function costEstimateUsd(
  provider: LlmProvider,
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const table = provider === 'anthropic' ? ANTHROPIC_PRICING : OPENAI_PRICING;
  const pricing = table[model] ?? FALLBACK;
  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMillion;
  // Round to 6 decimals (sub-cent precision) to make accumulation deterministic.
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}

/** Test hook — list registered models for a provider. */
export function knownModels(provider: LlmProvider): string[] {
  return Object.keys(provider === 'anthropic' ? ANTHROPIC_PRICING : OPENAI_PRICING);
}
