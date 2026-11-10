/**
 * Agent run budgets (V2_STAGE4_SPEC §2). All are hard limits per run; the
 * loop never sends a request that could pass one (see `loop.ts`).
 *
 * Defaults: [D] 20 tool calls / 400k input / 16k output / 180 s;
 * [D-Deep] 40 / 1M / 40k / 300 s. `maxUsd: null` = derived from the token
 * budgets at the model's price, assuming 25 % uncached input and 75 % cache
 * reads (the loop resends a growing prefix every turn, so most input is cached).
 */
import type { TokenUsage } from '../../lib/llm/cost';
import type { AgentBudgets } from './loop';

export interface AgentBudgetSettings {
  maxToolCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxWallMs: number;
  /** null = derived (see file comment). */
  maxUsd: number | null;
  perTurnMaxTokens: number;
}

export type AgentBudgetView = 'updateReport' | 'deepReport';

export const DEFAULT_AGENT_BUDGETS: Readonly<Record<AgentBudgetView, Readonly<AgentBudgetSettings>>> = Object.freeze({
  updateReport: Object.freeze({ maxToolCalls: 20, maxInputTokens: 400_000, maxOutputTokens: 16_000, maxWallMs: 180_000, maxUsd: null, perTurnMaxTokens: 8_000 }),
  deepReport: Object.freeze({ maxToolCalls: 40, maxInputTokens: 1_000_000, maxOutputTokens: 40_000, maxWallMs: 300_000, maxUsd: null, perTurnMaxTokens: 16_000 })
});

export function derivedMaxUsd(model: string, s: Pick<AgentBudgetSettings, 'maxInputTokens' | 'maxOutputTokens'>, pricing: (model: string, u: TokenUsage) => number): number {
  return pricing(model, {
    inputTokens: Math.round(s.maxInputTokens * 0.25),
    cacheReadInputTokens: Math.round(s.maxInputTokens * 0.75),
    cacheCreationInputTokens: 0,
    outputTokens: s.maxOutputTokens
  });
}

export function resolveBudgets(s: AgentBudgetSettings, model: string, pricing: (model: string, u: TokenUsage) => number): AgentBudgets {
  return {
    maxToolCalls: s.maxToolCalls,
    maxInputTokens: s.maxInputTokens,
    maxOutputTokens: s.maxOutputTokens,
    maxWallMs: s.maxWallMs,
    maxUsd: s.maxUsd ?? derivedMaxUsd(model, s, pricing),
    perTurnMaxTokens: Math.min(s.perTurnMaxTokens, s.maxOutputTokens)
  };
}

/** Validates a stored settings block; returns the defaults for anything missing or out of range. */
export function normalizeBudgetSettings(raw: unknown, fallback: Readonly<AgentBudgetSettings>): AgentBudgetSettings {
  const o = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const pos = (k: keyof AgentBudgetSettings): number => {
    const v = o[k];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : (fallback[k] as number);
  };
  const usd = o.maxUsd;
  return {
    maxToolCalls: Math.floor(pos('maxToolCalls')),
    maxInputTokens: Math.floor(pos('maxInputTokens')),
    maxOutputTokens: Math.floor(pos('maxOutputTokens')),
    maxWallMs: Math.floor(pos('maxWallMs')),
    maxUsd: typeof usd === 'number' && Number.isFinite(usd) && usd > 0 ? usd : fallback.maxUsd,
    perTurnMaxTokens: Math.floor(pos('perTurnMaxTokens'))
  };
}
