/**
 * Model catalog invariants (Settings → LLM and onboarding share this list).
 */
import { describe, it, expect } from 'vitest';
import { MODEL_OPTIONS, defaultModel } from '@/lib/llm/models';
import { DEFAULT_CONFIG } from '@/lib/storage/config';
import { knownModels, pricingFor } from '@/lib/llm/cost';

describe('LLM model catalog', () => {
  it('uses bare first-party Anthropic IDs — no date suffixes, no retired families', () => {
    for (const id of MODEL_OPTIONS.anthropic) {
      expect(id).toMatch(/^claude-(opus|sonnet|haiku|fable)-\d(-\d)?$/);
      expect(id).not.toMatch(/-\d{8}$/);
    }
  });

  it('defaults to the first entry per provider', () => {
    expect(defaultModel('anthropic')).toBe(MODEL_OPTIONS.anthropic[0]);
  });

  it('ships a default config whose model is in the catalog', () => {
    expect(MODEL_OPTIONS[DEFAULT_CONFIG.llm.provider]).toContain(DEFAULT_CONFIG.llm.model);
  });

  it('has a pricing row for every Anthropic option so cost never falls back', () => {
    const priced = knownModels();
    for (const id of MODEL_OPTIONS.anthropic) {
      expect(priced).toContain(id);
    }
  });

  it('defaults to claude-opus-5-5', () => {
    expect(defaultModel()).toBe('claude-opus-5-5');
    expect(DEFAULT_CONFIG.llm.model).toBe('claude-opus-5-5');
  });

  it('every picker id has a pricing row with cache prices', () => {
    for (const id of MODEL_OPTIONS.anthropic) {
      const p = pricingFor(id);
      expect(p.cacheReadPerMillion).toBeGreaterThan(0);
      expect(p.cacheWrite5mPerMillion).toBeGreaterThan(p.inputPerMillion);
    }
  });
});
