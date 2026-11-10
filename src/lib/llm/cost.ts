/**
 * Cost estimation table (spec §11.11).
 *
 * Pricing per **million tokens**, Anthropic first-party API rates. Unknown
 * models use `FALLBACK`, which over-estimates so the Cost panel never
 * under-reports a real spend (never 0).
 *
 * Usage semantics (Messages API): `input_tokens` is the *uncached remainder*
 * of the prompt — cache reads and cache writes are reported separately in
 * `cache_read_input_tokens` / `cache_creation_input_tokens`. So:
 *   cost = input×in + cacheRead×read + cacheWrite×write5m + output×out
 * Stage 1 only uses the 5-minute cache TTL, so 1h writes are not modelled.
 *
 * Rows for retired / older ids stay: stored configs, `estimate.ts` callers and
 * old envelopes may still name them, and a missing row silently falls back.
 *
 * VERIFIED 2026-11-09 against https://platform.claude.com/docs/en/about-claude/pricing
 * (model pricing table). Re-check before changing any number.
 */

export interface Pricing {
  inputPerMillion: number;
  outputPerMillion: number;
  /** Cache hits and refreshes. */
  cacheReadPerMillion: number;
  /** 5-minute TTL cache writes (1.25× input). */
  cacheWrite5mPerMillion: number;
}

export interface TokenUsage {
  /** Uncached input tokens (`usage.input_tokens`). */
  inputTokens: number;
  outputTokens: number;
  /** `usage.cache_read_input_tokens`; absent/null → 0. */
  cacheReadInputTokens?: number;
  /** `usage.cache_creation_input_tokens`; absent/null → 0. */
  cacheCreationInputTokens?: number;
}

/** Standard multipliers (pricing page: cache hits 0.1×, 5m writes 1.25× of input). */
function standard(input: number, output: number): Pricing {
  return {
    inputPerMillion: input,
    outputPerMillion: output,
    cacheReadPerMillion: round6(input * 0.1),
    cacheWrite5mPerMillion: round6(input * 1.25)
  };
}

const ANTHROPIC_PRICING: Record<string, Pricing> = {
  // Current generation.
  'claude-opus-5-5': { inputPerMillion: 4.0, outputPerMillion: 20.0, cacheReadPerMillion: 0.2, cacheWrite5mPerMillion: 5.0 },
  'claude-sonnet-5-5': { inputPerMillion: 2.0, outputPerMillion: 10.0, cacheReadPerMillion: 0.1, cacheWrite5mPerMillion: 2.5 },
  // Haiku 5.5 low tier (prompt ≤ 100K tokens); the high tier is HAIKU_5_5_LONG.
  'claude-haiku-5-5': { inputPerMillion: 0.1, outputPerMillion: 0.5, cacheReadPerMillion: 0.01, cacheWrite5mPerMillion: 0.125 },
  'claude-fable-5-1': { inputPerMillion: 10.0, outputPerMillion: 50.0, cacheReadPerMillion: 0.25, cacheWrite5mPerMillion: 12.5 },
  // Previous generations (kept: stored configs and old envelopes name them).
  'claude-fable-5': { inputPerMillion: 10.0, outputPerMillion: 50.0, cacheReadPerMillion: 1.0, cacheWrite5mPerMillion: 12.5 },
  'claude-opus-5': standard(5.0, 25.0),
  'claude-opus-4-8': standard(5.0, 25.0),
  'claude-opus-4-7': standard(5.0, 25.0),
  'claude-opus-4-6': standard(5.0, 25.0),
  'claude-sonnet-5': standard(2.0, 10.0),
  'claude-sonnet-4-6': standard(3.0, 15.0),
  'claude-haiku-4-5': standard(1.0, 5.0),
  // Claude 3.x (retired; rows kept for old envelopes and estimates).
  'claude-3-5-sonnet-latest': standard(3.0, 15.0),
  'claude-3-5-sonnet-20241022': standard(3.0, 15.0),
  'claude-3-5-haiku-latest': standard(0.8, 4.0),
  'claude-3-5-haiku-20241022': standard(0.8, 4.0),
  'claude-3-opus-latest': standard(15.0, 75.0),
  'claude-3-opus-20240229': standard(15.0, 75.0)
};

/**
 * Haiku 5.5 is priced by prompt length. Per the pricing page the prompt length
 * counts ALL input tokens (uncached + cache reads + cache writes), and a request
 * over 100,000 tokens pays the higher prices for every category.
 */
const HAIKU_5_5_LONG: Pricing = { inputPerMillion: 0.5, outputPerMillion: 2.5, cacheReadPerMillion: 0.05, cacheWrite5mPerMillion: 0.625 };
const HAIKU_5_5_TIER_THRESHOLD = 100_000;

/**
 * Conservative fallback pricing — used when a model name isn't in the table.
 * Better to over-estimate than to silently zero out a real spend.
 */
const FALLBACK: Pricing = standard(10.0, 30.0);

export function pricingFor(model: string, usage?: TokenUsage): Pricing {
  if (model === 'claude-haiku-5-5' && usage !== undefined && promptTokens(usage) > HAIKU_5_5_TIER_THRESHOLD) {
    return HAIKU_5_5_LONG;
  }
  return ANTHROPIC_PRICING[model] ?? FALLBACK;
}

export function costEstimateUsd(model: string, usage: TokenUsage): number {
  const p = pricingFor(model, usage);
  const cost =
    (usage.inputTokens * p.inputPerMillion +
      (usage.cacheReadInputTokens ?? 0) * p.cacheReadPerMillion +
      (usage.cacheCreationInputTokens ?? 0) * p.cacheWrite5mPerMillion +
      usage.outputTokens * p.outputPerMillion) /
    1_000_000;
  // Round to 6 decimals (sub-cent precision) to make accumulation deterministic.
  return round6(cost);
}

/** Test hook — list models with a pricing row. */
export function knownModels(): string[] {
  return Object.keys(ANTHROPIC_PRICING);
}

function promptTokens(usage: TokenUsage): number {
  return usage.inputTokens + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
