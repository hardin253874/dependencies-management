/**
 * Model catalog invariants (Settings → LLM and onboarding share this list).
 */
import { describe, it, expect } from 'vitest';
import { MODEL_OPTIONS, defaultModel } from '@/lib/llm/models';
import { DEFAULT_CONFIG } from '@/lib/storage/config';
import { knownModels } from '@/lib/llm/cost';

describe('LLM model catalog', () => {
  it('uses bare first-party Anthropic IDs — no date suffixes, no retired families', () => {
    for (const id of MODEL_OPTIONS.anthropic) {
      expect(id).toMatch(/^claude-(opus|sonnet|haiku|fable)-\d(-\d)?$/);
      expect(id).not.toMatch(/-\d{8}$/);
    }
  });

  it('defaults to the first entry per provider', () => {
    expect(defaultModel('anthropic')).toBe(MODEL_OPTIONS.anthropic[0]);
    expect(defaultModel('openai')).toBe(MODEL_OPTIONS.openai[0]);
  });

  it('ships a default config whose model is in the catalog', () => {
    expect(MODEL_OPTIONS[DEFAULT_CONFIG.llm.provider]).toContain(DEFAULT_CONFIG.llm.model);
  });

  it('has a pricing row for every Anthropic option so cost never falls back', () => {
    const priced = knownModels('anthropic');
    for (const id of MODEL_OPTIONS.anthropic) {
      expect(priced).toContain(id);
    }
  });
});
