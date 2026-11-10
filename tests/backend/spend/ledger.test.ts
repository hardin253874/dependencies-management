/**
 * Spend ledger + gate (V2_STAGE4_SPEC 4c.1). Sandbox ledger paths and fake
 * clients only — nothing here can reach a real API.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { createSandbox, type Sandbox } from '../helpers/sandbox';
import { CAP_USD, LedgerLockError, SpendCapError, SpendLedger, defaultLedgerPath, type LedgerFile } from '@/core/spend/ledger';
import { SpendGuard, estimateRequestUsd, SAFETY_MARGIN } from '@/core/spend/gate';
import { costEstimateUsd } from '@/lib/llm/cost';
import { LLMError, type LLMClient, type LlmCallRequest, type LlmCallResult } from '@/lib/llm/client';
import { ScriptedAgentModel } from '@/core/agent/model';
import { runAgent, type AgentBudgets } from '@/core/agent/loop';
import { createToolRegistry } from '@/core/agent/registry';
import { DEFAULT_TOOL_LIMITS, type TerminalToolDef } from '@/core/agent/types';
import type { GraphDriver } from '@/core/graph/store';

const SONNET = 'claude-sonnet-5-5';
let sandbox: Sandbox;
let ledgerPath: string;
const open: SpendLedger[] = [];

async function openLedger(): Promise<SpendLedger> {
  const l = await SpendLedger.open(ledgerPath);
  open.push(l);
  return l;
}

async function seedLedger(entries: LedgerFile['entries'], extra: Partial<LedgerFile> = {}): Promise<void> {
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.writeFile(ledgerPath, JSON.stringify({ roundId: 'stage4-round1', capUsd: CAP_USD, entries, spentUsd: 0, reservedUsd: 0, ...extra }), 'utf8');
}

function settled(usd: number): LedgerFile['entries'] {
  return [
    { id: 'a', at: '2026-11-10T00:00:00Z', step: 'seed', model: SONNET, kind: 'reserve', usd: usd + 1 },
    { id: 'a', at: '2026-11-10T00:00:01Z', step: 'seed', model: SONNET, kind: 'settle', usd }
  ];
}

function request(over: Partial<LlmCallRequest> = {}): LlmCallRequest {
  return {
    model: SONNET,
    systemPrompt: 'system',
    userPrompt: 'user prompt',
    tool: { name: 'submit', description: 'd', inputSchema: { type: 'object', additionalProperties: false, required: [], properties: {} } },
    maxOutputTokens: 6000,
    effort: 'medium',
    ...over
  };
}

class FakeClient implements LLMClient {
  readonly provider = 'anthropic' as const;
  calls = 0;
  constructor(private readonly behave: 'ok' | 'throw' = 'ok') {}
  async call<T>(req: LlmCallRequest): Promise<LlmCallResult<T>> {
    this.calls += 1;
    if (this.behave === 'throw') throw new LLMError('LLM_TRUNCATED', 'cut off');
    const usage = { inputTokens: 1000, outputTokens: 2000, cacheReadInputTokens: 3000, cacheCreationInputTokens: 4000 };
    return { output: {} as T, ...usage, model: req.model, provider: 'anthropic', costEstimateUsd: costEstimateUsd(req.model, usage) };
  }
}

beforeEach(async () => {
  sandbox = await createSandbox('spend-ledger');
  ledgerPath = path.join(sandbox.scratchRoot, '_spend', 'stage4-round1.json');
});

afterEach(async () => {
  for (const l of open.splice(0)) await l.close();
  delete process.env.DEP_AGENT_SPEND_CAP_USD;
  await sandbox.dispose();
});

describe('estimateRequestUsd', () => {
  it('prices input at the worst (cache-write) rate plus max_tokens output, times the safety margin', () => {
    // Sonnet 5.5: write $2.50/M, out $10/M.
    expect(estimateRequestUsd(SONNET, 10_000, 6_000)).toBeCloseTo(((10_000 * 2.5 + 6_000 * 10) / 1e6) * SAFETY_MARGIN, 6);
  });

  it('switches Haiku 5.5 to the > 100k tier when the estimate passes 100k tokens', () => {
    const low = estimateRequestUsd('claude-haiku-5-5', 100_000, 0);
    const high = estimateRequestUsd('claude-haiku-5-5', 100_001, 0);
    expect(low).toBeCloseTo(((100_000 * 0.125) / 1e6) * SAFETY_MARGIN, 6);
    expect(high).toBeCloseTo(((100_001 * 0.625) / 1e6) * SAFETY_MARGIN, 6);
  });

  it('refuses a model without a pricing row (never the fallback price)', () => {
    expect(() => estimateRequestUsd('claude-unknown-9', 10, 10)).toThrow(SpendCapError);
  });
});

describe('SpendLedger', () => {
  it('lives under <LOCALAPPDATA>/dep-agent-eval/_spend by default', () => {
    expect(defaultLedgerPath('C:\\L')).toBe(path.join('C:\\L', 'dep-agent-eval', '_spend', 'stage4-round1.json'));
  });

  it('refuses a request whose estimate would cross the cap: nothing sent, nothing reserved', async () => {
    await seedLedger(settled(9.99));
    const ledger = await openLedger();
    const guard = new SpendGuard({ ledger, step: 't' });
    const inner = new FakeClient();
    const client = guard.wrapLlmClient(inner);
    await expect(client.call(request())).rejects.toThrow(SpendCapError);
    expect(inner.calls).toBe(0);
    expect(guard.refusals).toBe(1);
    expect(ledger.entries().filter((e) => e.kind === 'reserve')).toHaveLength(1);
    expect(ledger.state().reservedUsd).toBe(0);
  });

  it('settles from API usage including cache fields and replaces the reservation', async () => {
    const ledger = await openLedger();
    const guard = new SpendGuard({ ledger, step: '4c.5' });
    guard.caseId = 'public-case';
    const res = await guard.wrapLlmClient(new FakeClient()).call(request());
    const expected = costEstimateUsd(SONNET, { inputTokens: 1000, outputTokens: 2000, cacheReadInputTokens: 3000, cacheCreationInputTokens: 4000 });
    expect(ledger.state()).toMatchObject({ spentUsd: expected, reservedUsd: 0 });
    const settle = ledger.entries().find((e) => e.kind === 'settle')!;
    expect(settle).toMatchObject({ step: '4c.5', caseId: 'public-case', model: SONNET, usd: expected, usage: { cacheReadInputTokens: 3000, cacheCreationInputTokens: 4000 } });
    expect(res.costEstimateUsd).toBe(expected);
    const onDisk = JSON.parse(await fs.readFile(ledgerPath, 'utf8')) as LedgerFile;
    expect(onDisk.spentUsd).toBe(expected);
  });

  it('keeps the reservation when the request throws without usage', async () => {
    const ledger = await openLedger();
    const guard = new SpendGuard({ ledger, step: 't' });
    await expect(guard.wrapLlmClient(new FakeClient('throw')).call(request())).rejects.toThrow(LLMError);
    expect(ledger.state().spentUsd).toBe(0);
    expect(ledger.state().reservedUsd).toBeGreaterThan(0);
  });

  it('uses count_tokens when it answers, and the local bound when it fails', async () => {
    const ledger = await openLedger();
    const guard = new SpendGuard({ ledger, step: 't' });
    await guard.wrapLlmClient(new FakeClient(), async () => 100).call(request());
    const counted = ledger.entries().find((e) => e.kind === 'reserve')!;
    expect(counted.usd).toBeCloseTo(estimateRequestUsd(SONNET, 100, 6000), 6);
    await guard.wrapLlmClient(new FakeClient(), async () => {
      throw new Error('429');
    }).call(request({ userPrompt: 'x'.repeat(4000) }));
    expect(guard.countFailures).toBe(1);
    const bound = ledger.entries().filter((e) => e.kind === 'reserve')[1]!;
    expect(bound.usd).toBeGreaterThan(estimateRequestUsd(SONNET, 2000, 6000));
  });

  it('refuses an unknown model before sending', async () => {
    const ledger = await openLedger();
    const inner = new FakeClient();
    await expect(new SpendGuard({ ledger, step: 't' }).wrapLlmClient(inner).call(request({ model: 'claude-unknown-9' }))).rejects.toThrow(/no pricing row/);
    expect(inner.calls).toBe(0);
  });

  it('cannot be raised: env var, the file capUsd field and a step ceiling above the cap are all ignored', async () => {
    process.env.DEP_AGENT_SPEND_CAP_USD = '1000';
    await seedLedger(settled(9.99), { capUsd: 1000 });
    const ledger = await openLedger();
    expect(ledger.state().capUsd).toBe(10);
    expect(CAP_USD).toBe(10);
    await expect(ledger.reserve({ step: 't', model: SONNET, usd: 0.02, ceilingUsd: 500 })).rejects.toThrow(SpendCapError);
    const onDisk = JSON.parse(await fs.readFile(ledgerPath, 'utf8')) as LedgerFile;
    expect(onDisk.capUsd).toBe(10);
  });

  it('a step ceiling lowers the limit', async () => {
    const ledger = await openLedger();
    await ledger.reserve({ step: 't', model: SONNET, usd: 0.4, ceilingUsd: 0.5 });
    await expect(ledger.reserve({ step: 't', model: SONNET, usd: 0.2, ceilingUsd: 0.5 })).rejects.toThrow(/step ceiling/);
  });

  it('refuses a second user of the ledger while the first holds the lock', async () => {
    await openLedger();
    await expect(SpendLedger.open(ledgerPath)).rejects.toThrow(LedgerLockError);
  });

  it('survives a crash between reserve and settle: the open reservation still counts', async () => {
    const first = await SpendLedger.open(ledgerPath);
    await first.reserve({ step: 't', model: SONNET, usd: 9.5 });
    // Simulated crash: no settle, no close; the lock is left behind with a dead pid.
    await fs.writeFile(`${ledgerPath}.lock`, '999999999', 'utf8');
    const second = await openLedger();
    expect(second.state()).toMatchObject({ reservedUsd: 9.5, spentUsd: 0, remainingUsd: 0.5 });
    await expect(second.reserve({ step: 't', model: SONNET, usd: 0.6 })).rejects.toThrow(SpendCapError);
  });

  it('recomputes totals from entries, not from the stored sums', async () => {
    await seedLedger(settled(9.99), { spentUsd: 0, reservedUsd: 0 });
    const ledger = await openLedger();
    expect(ledger.state().spentUsd).toBe(9.99);
  });
});

describe('SpendGuard.agentGate in runAgent', () => {
  const terminal: TerminalToolDef = {
    name: 'submit_report',
    description: 'Submit.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: { type: 'string' } } }
  };
  const budgets: AgentBudgets = { maxToolCalls: 5, maxInputTokens: 400_000, maxOutputTokens: 16_000, maxWallMs: 60_000, maxUsd: 5, perTurnMaxTokens: 4_000 };
  const base = {
    modelId: SONNET,
    effort: 'medium' as const,
    registry: createToolRegistry([]),
    terminal,
    system: 'You are a test agent.',
    seedMessages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Investigate.' }] }],
    budgets,
    ctx: { workspaceRoot: '/ws', graph: {} as GraphDriver, intel: {}, limits: { ...DEFAULT_TOOL_LIMITS } },
    pricing: costEstimateUsd
  };

  it('refuses a request that would exceed the cap before it is sent', async () => {
    await seedLedger(settled(9.999));
    const ledger = await openLedger();
    const guard = new SpendGuard({ ledger, step: 't' });
    const model = new ScriptedAgentModel([{ content: [{ type: 'tool_use', name: 'submit_report', input: { summary: 'x' } }] }]);
    const result = await runAgent({ ...base, model, gate: guard.agentGate() });
    expect(model.requests).toHaveLength(0);
    expect(result.status).toBe('error');
    expect(result.stopDetail).toMatchObject({ reason: 'spend-cap', code: 'SPEND_CAP' });
    expect(guard.refusals).toBe(1);
  });

  it('reserves before and settles after every turn from API usage', async () => {
    const ledger = await openLedger();
    const guard = new SpendGuard({ ledger, step: 't' });
    const usage = { inputTokens: 500, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 2000 };
    const model = new ScriptedAgentModel([
      { content: [{ type: 'text', text: 'thinking' }], usage },
      { content: [{ type: 'tool_use', name: 'submit_report', input: { summary: 'x' } }], usage }
    ]);
    const counts: number[] = [];
    const result = await runAgent({ ...base, model, gate: guard.agentGate(async (req) => (counts.push(req.messages.length), 1234)) });
    expect(result.status).toBe('submitted');
    expect(counts).toEqual([1, 3]);
    expect(ledger.state()).toMatchObject({ spentUsd: Math.round(costEstimateUsd(SONNET, usage) * 2 * 1e6) / 1e6, reservedUsd: 0 });
    expect(ledger.state().spentUsd).toBeCloseTo(result.costUsd, 6);
  });

  it('keeps the reservation when the model throws', async () => {
    const ledger = await openLedger();
    const guard = new SpendGuard({ ledger, step: 't' });
    const model = new ScriptedAgentModel([{ error: { code: 'LLM_NETWORK', message: 'reset' } }]);
    const result = await runAgent({ ...base, model, gate: guard.agentGate() });
    expect(result.status).toBe('error');
    expect(ledger.state().reservedUsd).toBeGreaterThan(0);
    expect(ledger.state().spentUsd).toBe(0);
  });
});
