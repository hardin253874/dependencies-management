import { describe, it, expect } from 'vitest';
import { migrateConfig, reportEngineOf, DEFAULT_CONFIG } from '@/lib/storage/config';
import { DEFAULT_AGENT_BUDGETS, derivedMaxUsd, resolveBudgets } from '@/core/agent/budgets';
import { costEstimateUsd } from '@/lib/llm/cost';
import { estimateAgentRun } from '@/lib/llm/agentEstimate';
import { toAnthropicTools } from '@/core/agent/registry';
import { createReadToolRegistry } from '@/core/agent/tools';
import { UPDATE_REPORT_TERMINAL } from '@/lib/llm/agentReportService';

describe('agent config (4a.12)', () => {
  it('a pre-Stage-4 config gets the default agent budgets; reportEngine absent = agent', () => {
    const old = { schemaVersion: 1, llm: { provider: 'anthropic', model: 'claude-opus-5-5' }, ui: DEFAULT_CONFIG.ui, features: DEFAULT_CONFIG.features };
    const { config, notices } = migrateConfig(old);
    expect(notices).toEqual([]);
    expect(config.agentBudgets).toEqual({ updateReport: DEFAULT_AGENT_BUDGETS.updateReport, deepReport: DEFAULT_AGENT_BUDGETS.deepReport });
    expect(config.llm.reportEngine).toBeUndefined();
    expect(reportEngineOf(config.llm.reportEngine)).toBe('agent');
  });

  it('keeps valid stored values, repairs invalid ones, normalizes an unknown engine', () => {
    const { config } = migrateConfig({
      ...DEFAULT_CONFIG,
      llm: { provider: 'anthropic', model: 'claude-opus-5-5', reportEngine: 'v1' },
      agentBudgets: { updateReport: { maxToolCalls: 5, maxInputTokens: -1, maxUsd: 0.5 }, deepReport: 'junk' }
    });
    expect(config.llm.reportEngine).toBe('v1');
    expect(config.agentBudgets.updateReport).toEqual({ ...DEFAULT_AGENT_BUDGETS.updateReport, maxToolCalls: 5, maxUsd: 0.5 });
    expect(config.agentBudgets.deepReport).toEqual(DEFAULT_AGENT_BUDGETS.deepReport);
    expect(migrateConfig({ ...DEFAULT_CONFIG, llm: { provider: 'anthropic', model: 'claude-opus-5-5', reportEngine: 'x' } }).config.llm.reportEngine).toBe('agent');
  });
});

describe('budgets + estimate (§2, 4a.12)', () => {
  it('maxUsd null is derived from the token budgets (25 % uncached, 75 % cache read)', () => {
    const b = resolveBudgets(DEFAULT_AGENT_BUDGETS.updateReport, 'claude-sonnet-5-5', costEstimateUsd);
    const expected = costEstimateUsd('claude-sonnet-5-5', { inputTokens: 100_000, cacheReadInputTokens: 300_000, outputTokens: 16_000 });
    expect(b.maxUsd).toBeCloseTo(expected, 6);
    expect(derivedMaxUsd('claude-sonnet-5-5', DEFAULT_AGENT_BUDGETS.updateReport, costEstimateUsd)).toBeCloseTo(expected, 6);
    expect(resolveBudgets({ ...DEFAULT_AGENT_BUDGETS.updateReport, maxUsd: 1 }, 'claude-sonnet-5-5', costEstimateUsd).maxUsd).toBe(1);
  });

  it('expected cost is positive, grows with the tool-call budget, and never passes maxUsd', () => {
    const tools = toAnthropicTools(createReadToolRegistry(), [UPDATE_REPORT_TERMINAL]);
    const b = resolveBudgets(DEFAULT_AGENT_BUDGETS.updateReport, 'claude-sonnet-5-5', costEstimateUsd);
    const small = estimateAgentRun({ model: 'claude-sonnet-5-5', budgets: { ...b, maxToolCalls: 5 }, seedPromptBytes: 6000, systemBytes: 2000, tools });
    const big = estimateAgentRun({ model: 'claude-sonnet-5-5', budgets: b, seedPromptBytes: 6000, systemBytes: 2000, tools });
    expect(small.expectedUsd).toBeGreaterThan(0);
    expect(big.expectedUsd).toBeGreaterThan(small.expectedUsd);
    expect(big.expectedUsd).toBeLessThanOrEqual(big.maxUsd);
    const tight = estimateAgentRun({ model: 'claude-sonnet-5-5', budgets: { ...b, maxUsd: 0.001 }, seedPromptBytes: 6000, systemBytes: 2000, tools });
    expect(tight.expectedUsd).toBe(0.001);
  });
});
