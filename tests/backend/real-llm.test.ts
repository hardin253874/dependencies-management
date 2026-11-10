/**
 * Real-LLM smoke test (spec §16; v2 Stage 1 exit item — USER ACTION ONLY).
 *
 * Hits the real Anthropic API and is normally SKIPPED. It runs only when
 * `RUN_REAL_LLM_TESTS=1` and `ANTHROPIC_API_KEY` are set in the shell. Agents
 * never run it; the user runs it once with their own key:
 *
 *   RUN_REAL_LLM_TESTS=1 ANTHROPIC_API_KEY=... npx vitest run tests/backend/real-llm.test.ts
 *
 * One view ([D] update report) on claude-opus-5-5 through the real adapter:
 * schema-valid tool output, no refusal / truncation (the adapter throws
 * LLM_REFUSAL / LLM_TRUNCATED for those), and cache usage fields present.
 * Cost: one small request (a few thousand tokens).
 *
 * Local devs do NOT run these by default — spec §11.12 mandates MOCK_LLM=true
 * for all standard test runs.
 */
import { describe, it, expect } from 'vitest';
import { AnthropicAdapter } from '@/lib/llm/anthropic';
import { VIEW_EFFORT } from '@/lib/llm/effort';
import { SHARED_SYSTEM_PROMPT } from '@/lib/llm/prompts/shared';
import {
  renderUpdateReportPrompt,
  UPDATE_REPORT_TOOL_SCHEMA,
  type UpdateReportPromptInput
} from '@/lib/llm/prompts/update-report';

const SHOULD_RUN = process.env.RUN_REAL_LLM_TESTS === '1';

const PROMPT_INPUT: UpdateReportPromptInput = {
  dep: { name: 'react', fromVersion: '18.3.1', toVersion: '19.0.0', releaseNotesBetween: null },
  resolverCheck: { wouldResolve: true, conflicts: [], legacyPeerDepsUsed: false },
  candidateCoUpgrades: [{ name: 'react-dom', currentVersion: '18.3.1', declaredPeerDepRange: null }],
  affectedFiles: []
};

describe.skipIf(!SHOULD_RUN)('Real LLM — view [D] (Anthropic)', () => {
  it('returns a schema-valid update report with cache usage fields', async () => {
    const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
    expect(apiKey).not.toBe('');
    const adapter = new AnthropicAdapter({ apiKey });
    const res = await adapter.call<Record<string, unknown>>({
      model: 'claude-opus-5-5',
      systemPrompt: SHARED_SYSTEM_PROMPT,
      userPrompt: renderUpdateReportPrompt(PROMPT_INPUT),
      tool: UPDATE_REPORT_TOOL_SCHEMA,
      maxOutputTokens: 6000,
      effort: VIEW_EFFORT.updateReport
    });
    for (const key of UPDATE_REPORT_TOOL_SCHEMA.inputSchema.required ?? []) {
      expect(res.output).toHaveProperty(key);
    }
    expect(typeof res.cacheReadInputTokens).toBe('number');
    expect(typeof res.cacheCreationInputTokens).toBe('number');
    expect(res.costEstimateUsd).toBeGreaterThan(0);
  }, 300_000);
});
