/**
 * Real-LLM smoke test (spec §16; v2 Stage 1 exit item, run in Stage 4c.4).
 *
 * Hits the real Anthropic API and is normally SKIPPED. It runs only with
 * `RUN_REAL_LLM_TESTS=1`:
 *
 *   $env:RUN_REAL_LLM_TESTS='1'; npx vitest run tests/backend/real-llm.test.ts
 *
 * The key is loaded by code (`loadApiKey`: environment, else `<repo>/.env`
 * parsed for ANTHROPIC_API_KEY only) and never printed. The request goes
 * through the Stage 4c spend gate and ledger
 * (`%LOCALAPPDATA%\dep-agent-eval\_spend\stage4-round1.json`) with a $0.50
 * step ceiling and `maxRetries: 0`, exactly like the eval's `--real` runs.
 *
 * One view ([D] update report) on claude-opus-5-5 through the real adapter:
 * schema-valid tool output, no refusal / truncation (the adapter throws
 * LLM_REFUSAL / LLM_TRUNCATED for those), cache usage fields present, cost > 0.
 *
 * Local devs do NOT run these by default — spec §11.12 mandates MOCK_LLM=true
 * for all standard test runs.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import { VIEW_EFFORT } from '@/lib/llm/effort';
import { SHARED_SYSTEM_PROMPT } from '@/lib/llm/prompts/shared';
import {
  renderUpdateReportPrompt,
  UPDATE_REPORT_TOOL_SCHEMA,
  type UpdateReportPromptInput
} from '@/lib/llm/prompts/update-report';
import { defaultLedgerPath } from '@/core/spend/ledger';
import { startRealSession } from '../../eval/lib/real';

const SHOULD_RUN = process.env.RUN_REAL_LLM_TESTS === '1';
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SMOKE_CEILING_USD = 0.5;

const PROMPT_INPUT: UpdateReportPromptInput = {
  dep: { name: 'react', fromVersion: '18.3.1', toVersion: '19.0.0', releaseNotesBetween: null },
  resolverCheck: { wouldResolve: true, conflicts: [], legacyPeerDepsUsed: false },
  candidateCoUpgrades: [{ name: 'react-dom', currentVersion: '18.3.1', declaredPeerDepRange: null }],
  affectedFiles: []
};

describe.skipIf(!SHOULD_RUN)('Real LLM — view [D] (Anthropic)', () => {
  it('returns a schema-valid update report with cache usage fields', async () => {
    const localAppData = process.env.LOCALAPPDATA;
    expect(localAppData).toBeTruthy();
    const smokeCase = { id: 'stage1-smoke', repo: 'https://github.com/facebook/react', visibility: 'public' as const };
    const lines: string[] = [];
    const session = await startRealSession({
      cases: [smokeCase],
      privateIds: new Set(),
      envFile: path.join(REPO_ROOT, '.env'),
      ledgerPath: defaultLedgerPath(localAppData!),
      step: '4c.4-smoke',
      ceilingUsd: SMOKE_CEILING_USD,
      // Ledger lines only (no key is ever in them); vitest shows them on failure.
      log: (l) => lines.push(l)
    });
    try {
      const client = session.clientFor(smokeCase).llm;
      const res = await client.call<Record<string, unknown>>({
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
      const info = session.spendInfo();
      expect(info.refusals).toBe(0);
      expect(info.spentAfter - info.spentBefore).toBeLessThanOrEqual(SMOKE_CEILING_USD);
      expect(info.reservedAfter).toBe(0);
    } finally {
      await session.close();
      process.stderr.write(`${lines.join('\n')}\n`);
    }
  }, 300_000);
});
