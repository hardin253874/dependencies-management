/**
 * Model catalog shown in Settings → LLM and the onboarding LLM step.
 *
 * Single source of truth — both pickers previously carried their own copy and
 * drifted (onboarding even listed a non-existent `claude-haiku-4`). Order is
 * "default first, then by capability/recency"; `defaultModel()` returns the
 * first entry so switching provider always lands on a sane choice.
 *
 * Anthropic IDs are the exact first-party strings — no date suffixes. Snapshot
 * taken 2026-09-24 from the Claude API model table. v1.x may replace this with
 * `GET /api/llm/models?provider=…` backed by the providers' live model lists.
 */
import type { LlmProvider } from '../api-types';

export const MODEL_OPTIONS: Record<LlmProvider, readonly string[]> = {
  anthropic: [
    'claude-opus-5',
    'claude-fable-5-1',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-5',
    'claude-sonnet-4-6',
    'claude-haiku-4-5'
  ],
  openai: ['gpt-5.5', 'gpt-5', 'gpt-5-mini', 'gpt-4o', 'gpt-4o-mini']
};

export function defaultModel(provider: LlmProvider): string {
  return MODEL_OPTIONS[provider][0]!;
}
