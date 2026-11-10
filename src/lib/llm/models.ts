/**
 * Model catalog shown in Settings → LLM and the onboarding LLM step.
 *
 * Single source of truth — both pickers previously carried their own copy and
 * drifted (onboarding even listed a non-existent `claude-haiku-4`). Order is
 * "default first, then by capability/recency"; `defaultModel()` returns the
 * first entry so switching provider always lands on a sane choice.
 *
 * Anthropic IDs are the exact first-party strings — no date suffixes. Snapshot
 * taken 2026-11-09 from the Claude API model table (claude-api reference,
 * cached 2026-10-06, and the pricing page checked 2026-11-09). The live
 * Models API (`client.models.list()`) was NOT called: that is a real API call
 * and stays a user action. A `GET /api/llm/models` backed by it is backlog.
 *
 * Picker = current generation + Fable 5.1 (open question Q5, recommendation
 * taken). Older ids stay priced in `cost.ts`; a stored config naming one is
 * migrated to the default with a one-time notice (`migrateConfig`).
 */
import type { LlmProvider } from '../api-types';

export const MODEL_OPTIONS: Record<LlmProvider, readonly string[]> = {
  anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']
};

export function defaultModel(provider: LlmProvider = 'anthropic'): string {
  return MODEL_OPTIONS[provider][0]!;
}
