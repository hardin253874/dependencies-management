/**
 * Bounded agent loop (V2_STAGE4_SPEC 4a.7). ScriptedAgentModel only — no network.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { createToolRegistry } from '@/core/agent/registry';
import { ScriptedAgentModel, type ScriptStep, type AgentTurnRequest } from '@/core/agent/model';
import { runAgent, READ_PATHS_MAX, budgetNudge, noSubmitNudge, requestTokenUpperBound, type AgentBudgets, type RunAgentOptions, type RequestEstimate } from '@/core/agent/loop';
import { DEFAULT_TOOL_LIMITS, type AgentToolDef, type TerminalToolDef } from '@/core/agent/types';
import { costEstimateUsd } from '@/lib/llm/cost';
import type { GraphDriver } from '@/core/graph/store';
import { fileTools } from '@/core/agent/tools/files';
import { createSandbox, type Sandbox } from '../helpers/sandbox';
import { buildAgentFixture, type BuiltFixture } from '../helpers/agentFixture';
import { writeProjectFile } from '../helpers/graphFixture';

const MODEL = 'claude-sonnet-5-5';

const terminal: TerminalToolDef = {
  name: 'submit_report',
  description: 'Submit.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: { type: 'string' } } }
};

const echo: AgentToolDef = {
  name: 'echo',
  description: 'Echo the input.',
  capability: 'read',
  inputSchema: { type: 'object', additionalProperties: false, required: ['q'], properties: { q: { type: 'string' } } },
  handler: (_ctx, input) => ({ echoed: input.q })
};

const BIG: AgentBudgets = {
  maxToolCalls: 20,
  maxInputTokens: 400_000,
  maxOutputTokens: 16_000,
  maxWallMs: 180_000,
  maxUsd: 5,
  perTurnMaxTokens: 4_000
};

const tool = (name: string, input: unknown, id?: string) => ({ type: 'tool_use' as const, name, input, ...(id !== undefined ? { id } : {}) });
const submit = (summary = 'done') => ({ content: [tool('submit_report', { summary })] });
const call = (q = 'x') => ({ content: [tool('echo', { q })] });
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

function options(model: ScriptedAgentModel, over: Partial<RunAgentOptions> = {}, extraTools: AgentToolDef[] = []): RunAgentOptions {
  return {
    model,
    modelId: MODEL,
    effort: 'medium',
    registry: createToolRegistry([echo, ...extraTools]),
    terminal,
    system: 'You are a test agent.',
    seedMessages: [{ role: 'user', content: [{ type: 'text', text: 'Investigate.' }] }],
    budgets: BIG,
    ctx: { workspaceRoot: '/ws', graph: {} as GraphDriver, intel: {}, limits: { ...DEFAULT_TOOL_LIMITS } },
    pricing: costEstimateUsd,
    ...over
  };
}

function lastUserText(req: AgentTurnRequest): string {
  const last = req.messages[req.messages.length - 1]!;
  expect(last.role).toBe('user');
  if (typeof last.content === 'string') return last.content;
  return last.content.map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? `[${String(b.content)}]` : '')).join('\n');
}

function toolResults(req: AgentTurnRequest): Anthropic.ToolResultBlockParam[] {
  const last = req.messages[req.messages.length - 1]!;
  return (last.content as Anthropic.ContentBlockParam[]).filter((b): b is Anthropic.ToolResultBlockParam => b.type === 'tool_result');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('runAgent — termination (4a.7)', () => {
  it('terminates on a valid submit, with trace, usage and cost from API usage', async () => {
    const model = new ScriptedAgentModel([
      { ...call('a'), usage: { inputTokens: 1200, outputTokens: 300, cacheCreationInputTokens: 800 } },
      { ...submit('all good'), usage: { inputTokens: 300, outputTokens: 500, cacheReadInputTokens: 2000 } }
    ]);
    const r = await runAgent<{ summary: string }>(options(model));
    expect(r.status).toBe('submitted');
    expect(r.output).toEqual({ summary: 'all good' });
    expect(r.trace.calls).toHaveLength(1);
    expect(r.trace.calls[0]).toMatchObject({ turn: 1, tool: 'echo', inputSummary: '{"q":"a"}', isError: false, truncated: false });
    expect(r.usage).toEqual({ inputTokens: 1500, outputTokens: 800, cacheReadInputTokens: 2000, cacheCreationInputTokens: 800, requests: 2, toolCalls: 1 });
    const expected =
      costEstimateUsd(MODEL, { inputTokens: 1200, outputTokens: 300, cacheCreationInputTokens: 800, cacheReadInputTokens: 0 }) +
      costEstimateUsd(MODEL, { inputTokens: 300, outputTokens: 500, cacheReadInputTokens: 2000, cacheCreationInputTokens: 0 });
    expect(r.costUsd).toBeCloseTo(expected, 6);
    expect(r.trace.turns.map((t) => t.turn)).toEqual([1, 2]);
    expect(model.requests[0]!.tools.map((t) => t.name)).toEqual(['echo', 'submit_report']);
  });

  it('text-only end_turn → one nudge turn → no-submit', async () => {
    const model = new ScriptedAgentModel([text('I think it is fine.'), text('Still prose.')]);
    const r = await runAgent(options(model));
    expect(r.status).toBe('no-submit');
    expect(model.requests).toHaveLength(2);
    expect(lastUserText(model.requests[1]!)).toBe(noSubmitNudge('submit_report'));
  });

  it('text-only then submit after the nudge → submitted', async () => {
    const model = new ScriptedAgentModel([text('hmm'), submit()]);
    expect((await runAgent(options(model))).status).toBe('submitted');
  });

  it('LLMError → error with its code', async () => {
    const model = new ScriptedAgentModel([call(), { error: { code: 'LLM_RATE_LIMIT', message: '429' } }]);
    const r = await runAgent(options(model));
    expect(r.status).toBe('error');
    expect(r.stopDetail).toMatchObject({ reason: 'llm-error', code: 'LLM_RATE_LIMIT' });
    expect(r.trace.calls).toHaveLength(1);
  });

  it('refusal stop → error LLM_REFUSAL; context window → LLM_TRUNCATED', async () => {
    const refused = await runAgent(options(new ScriptedAgentModel([{ content: [], stopReason: 'refusal' }])));
    expect(refused).toMatchObject({ status: 'error', stopDetail: { code: 'LLM_REFUSAL' } });
    const ctxw = await runAgent(options(new ScriptedAgentModel([{ content: [], stopReason: 'model_context_window_exceeded' }])));
    expect(ctxw).toMatchObject({ status: 'error', stopDetail: { code: 'LLM_TRUNCATED' } });
  });

  it('max_tokens on the submit turn → error LLM_TRUNCATED', async () => {
    const r = await runAgent(options(new ScriptedAgentModel([{ ...submit(), stopReason: 'max_tokens' }])));
    expect(r).toMatchObject({ status: 'error', stopDetail: { reason: 'truncated', code: 'LLM_TRUNCATED' } });
  });

  it('invalid terminal input → is_error with the validation message, counted as a tool call, then a valid submit', async () => {
    const model = new ScriptedAgentModel([{ content: [tool('submit_report', { summary: 3 })] }, submit()]);
    const r = await runAgent(options(model));
    expect(r.status).toBe('submitted');
    expect(r.usage.toolCalls).toBe(1);
    const [res] = toolResults(model.requests[1]!);
    expect(res).toMatchObject({ is_error: true });
    expect(String(res!.content)).toContain('input.summary must be a string');
  });

  it('a script that runs out is a clear error, not a hang', async () => {
    const r = await runAgent(options(new ScriptedAgentModel([call()])));
    expect(r).toMatchObject({ status: 'error', stopDetail: { code: 'MOCK_LLM_NO_FIXTURE' } });
    expect(r.stopDetail.message).toMatch(/script exhausted/);
  });
});

describe('runAgent — tool execution (4a.7)', () => {
  it('unknown tool and invalid input → is_error results and the loop continues', async () => {
    const model = new ScriptedAgentModel([{ content: [tool('nope', {}, 'a'), tool('echo', { q: 1 }, 'b')] }, submit()]);
    const r = await runAgent(options(model));
    expect(r.status).toBe('submitted');
    const results = toolResults(model.requests[1]!);
    expect(results.map((x) => [x.tool_use_id, x.is_error, x.content])).toEqual([
      ['a', true, 'Unknown tool "nope".'],
      ['b', true, 'Invalid input for echo: input.q must be a string']
    ]);
    expect(r.trace.calls.map((c) => c.isError)).toEqual([true, true]);
  });

  it('parallel tool_use blocks → one user message with all results, in order', async () => {
    const model = new ScriptedAgentModel([{ content: [tool('echo', { q: '1' }, 'x1'), tool('echo', { q: '2' }, 'x2'), tool('echo', { q: '3' }, 'x3')] }, submit()]);
    const r = await runAgent(options(model));
    const req = model.requests[1]!;
    expect(req.messages).toHaveLength(3);
    expect(toolResults(req).map((x) => [x.tool_use_id, x.content])).toEqual([
      ['x1', '{"echoed":"1"}'],
      ['x2', '{"echoed":"2"}'],
      ['x3', '{"echoed":"3"}']
    ]);
    expect(r.trace.calls).toHaveLength(r.usage.toolCalls);
    expect(r.usage.toolCalls).toBe(3);
  });

  it('thinking blocks from turn N are passed back byte-identical in turn N+1 (append-only)', async () => {
    const thinking = { type: 'thinking' as const, thinking: 'Let me look at the graph.', signature: 'sig-AbC==' };
    const model = new ScriptedAgentModel([{ content: [thinking, tool('echo', { q: 'z' }, 't1')] }, submit()]);
    await runAgent(options(model));
    const assistant = model.requests[1]!.messages[1]!;
    expect(assistant.role).toBe('assistant');
    expect(JSON.stringify((assistant.content as unknown[])[0])).toBe(JSON.stringify(thinking));
    expect(JSON.stringify(model.requests[1]!.messages[0])).toBe(JSON.stringify(model.requests[0]!.messages[0]));
  });
});

describe('runAgent — budgets and the final turn (4a.7)', () => {
  it('tool-call budget → final-turn nudge in the next request → submit', async () => {
    const model = new ScriptedAgentModel([call(), call(), submit()]);
    const r = await runAgent(options(model, { budgets: { ...BIG, maxToolCalls: 2 } }));
    expect(r.status).toBe('submitted');
    expect(r.finalTurnReason).toBe('tool-calls');
    expect(lastUserText(model.requests[2]!)).toContain(budgetNudge('submit_report'));
    expect(model.requests[2]!.tools.map((t) => t.name)).toEqual(model.requests[0]!.tools.map((t) => t.name));
  });

  it('model ignores the nudge → is_error "budget exhausted", exactly one more turn, then budget-exhausted', async () => {
    const model = new ScriptedAgentModel([call(), call(), call(), call(), call()]);
    const r = await runAgent(options(model, { budgets: { ...BIG, maxToolCalls: 2 } }));
    expect(r.status).toBe('budget-exhausted');
    expect(r.stopDetail.reason).toBe('tool-calls');
    expect(model.requests).toHaveLength(4);
    expect(toolResults(model.requests[3]!)[0]).toMatchObject({ is_error: true, content: 'budget exhausted: call submit_report now' });
    expect(r.usage.toolCalls).toBe(2);
    expect(r.trace.calls).toHaveLength(2);
  });

  it('parallel calls past the tool-call limit are refused and the final turn follows', async () => {
    const model = new ScriptedAgentModel([{ content: [tool('echo', { q: '1' }), tool('echo', { q: '2' }), tool('echo', { q: '3' })] }, submit()]);
    const r = await runAgent(options(model, { budgets: { ...BIG, maxToolCalls: 2 } }));
    expect(r.status).toBe('submitted');
    expect(r.usage.toolCalls).toBe(2);
    expect(toolResults(model.requests[1]!).map((x) => x.is_error ?? false)).toEqual([false, false, true]);
    expect(lastUserText(model.requests[1]!)).toContain(budgetNudge('submit_report'));
  });

  it('input-token budget → final turn', async () => {
    // Dry run to learn the second request's projected size T2, then leave room for 1.5 × T2.
    const dry = new ScriptedAgentModel([{ ...call(), usage: { inputTokens: 50_000, outputTokens: 100 } }, submit()]);
    await runAgent(options(dry));
    const t2 = requestTokenUpperBound(dry.requests[1]!.system, dry.requests[1]!.tools, dry.requests[1]!.messages);
    const model = new ScriptedAgentModel([{ ...call(), usage: { inputTokens: 50_000, outputTokens: 100 } }, submit()]);
    const r = await runAgent(options(model, { budgets: { ...BIG, maxInputTokens: 50_000 + Math.ceil(1.5 * t2) } }));
    expect(r.status).toBe('submitted');
    expect(r.finalTurnReason).toBe('input-tokens');
    expect(lastUserText(model.requests[1]!)).toContain(budgetNudge('submit_report'));
  });

  it('output-token budget → final turn with max_tokens = what is left', async () => {
    const model = new ScriptedAgentModel([{ ...call(), usage: { inputTokens: 100, outputTokens: 5_500 } }, submit()]);
    const r = await runAgent(options(model, { budgets: { ...BIG, maxOutputTokens: 8_000, perTurnMaxTokens: 4_000 } }));
    expect(r.status).toBe('submitted');
    expect(r.finalTurnReason).toBe('output-tokens');
    expect(model.requests[0]!.maxTokens).toBe(4_000);
    expect(model.requests[1]!.maxTokens).toBe(2_500);
  });

  it('USD budget → final turn', async () => {
    const pricing = (_m: string, u: { outputTokens: number }) => u.outputTokens * 0.0001;
    const model = new ScriptedAgentModel([{ ...call(), usage: { inputTokens: 10, outputTokens: 3_000 } }, submit()]);
    const r = await runAgent(options(model, { pricing, budgets: { ...BIG, maxUsd: 1, maxOutputTokens: 100_000 } }));
    expect(r.status).toBe('submitted');
    expect(r.finalTurnReason).toBe('usd');
  });

  it('projected-cost refusal sends no request (the model saw N requests, not N+1)', async () => {
    const pricing = (_m: string, u: { outputTokens: number }) => u.outputTokens * 0.0001;
    const none = new ScriptedAgentModel([submit()]);
    const r0 = await runAgent(options(none, { pricing, budgets: { ...BIG, maxUsd: 0.1 } }));
    expect(r0.status).toBe('budget-exhausted');
    expect(r0.stopDetail.reason).toBe('usd');
    expect(none.requests).toHaveLength(0);

    // Turn 1 reports more output than its max_tokens (an overrun), so even the final turn no longer fits.
    const one = new ScriptedAgentModel([{ ...call(), usage: { inputTokens: 10, outputTokens: 5_000 } }, call(), submit()]);
    const r1 = await runAgent(options(one, { pricing, budgets: { ...BIG, maxUsd: 0.85, maxOutputTokens: 100_000 } }));
    expect(r1.status).toBe('budget-exhausted');
    expect(r1.stopDetail.reason).toBe('usd');
    expect(one.requests).toHaveLength(1);
    expect(r1.costUsd).toBeLessThanOrEqual(0.85);
  });

  it('spend gate refusal → error SPEND_CAP and nothing is sent', async () => {
    const model = new ScriptedAgentModel([submit()]);
    const gate = { beforeRequest: vi.fn(() => ({ allowed: false, reason: 'cap' })), afterResponse: vi.fn() };
    const r = await runAgent(options(model, { gate }));
    expect(r).toMatchObject({ status: 'error', stopDetail: { reason: 'spend-cap', code: 'SPEND_CAP', message: 'cap' } });
    expect(model.requests).toHaveLength(0);
    expect(gate.afterResponse).not.toHaveBeenCalled();
  });

  it('spend gate sees every request estimate and every API usage', async () => {
    const model = new ScriptedAgentModel([call(), submit()]);
    const estimates: RequestEstimate[] = [];
    const gate = { beforeRequest: vi.fn((e: RequestEstimate) => { estimates.push(e); return { allowed: true }; }), afterResponse: vi.fn() };
    await runAgent(options(model, { gate }));
    expect(gate.beforeRequest).toHaveBeenCalledTimes(2);
    expect(gate.afterResponse).toHaveBeenCalledTimes(2);
    const est = estimates[0]!;
    expect(est.maxTokens).toBe(4_000);
    expect(est.inputTokensUpperBound).toBe(requestTokenUpperBound(model.requests[0]!.system, model.requests[0]!.tools, model.requests[0]!.messages));
    expect(est.projectedUsd).toBeGreaterThan(0);
  });

  it('wall time: 80 % enters the final turn', async () => {
    let clock = 0;
    const slow: AgentToolDef = { ...echo, name: 'slow', handler: () => { clock += 150_000; return 'ok'; } };
    const model = new ScriptedAgentModel([{ content: [tool('slow', { q: 'x' })] }, submit()]);
    const r = await runAgent(options(model, { now: () => clock }, [slow]));
    expect(r.status).toBe('submitted');
    expect(r.finalTurnReason).toBe('wall-time');
  });

  it('wall time: the hard limit aborts an in-flight request (fake timers)', async () => {
    vi.useFakeTimers();
    const hang: ScriptStep = (req) =>
      new Promise((_resolve, reject) => req.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    const model = new ScriptedAgentModel([hang]);
    const p = runAgent(options(model, { budgets: { ...BIG, maxWallMs: 10_000 } }));
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await p;
    expect(r.status).toBe('budget-exhausted');
    expect(r.stopDetail.reason).toBe('wall-time');
  });
});

describe('runAgent — cancel (4a.7)', () => {
  it('cancel mid-tool: no further requests, trace kept', async () => {
    const ac = new AbortController();
    const stopper: AgentToolDef = { ...echo, name: 'stopper', handler: () => { ac.abort(); return 'stopped'; } };
    const model = new ScriptedAgentModel([{ content: [tool('stopper', { q: 'x' })] }, submit()]);
    const r = await runAgent(options(model, { signal: ac.signal }, [stopper]));
    expect(r.status).toBe('cancelled');
    expect(model.requests).toHaveLength(1);
    expect(r.trace.calls).toHaveLength(1);
  });

  it('cancel mid-request aborts the in-flight request', async () => {
    const ac = new AbortController();
    let sawAbort = false;
    const hang: ScriptStep = (req) =>
      new Promise((_resolve, reject) =>
        req.signal?.addEventListener('abort', () => {
          sawAbort = true;
          reject(new Error('aborted'));
        })
      );
    const model = new ScriptedAgentModel([call(), hang]);
    const p = runAgent(options(model, { signal: ac.signal }));
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    const r = await p;
    expect(r.status).toBe('cancelled');
    expect(sawAbort).toBe(true);
    expect(r.trace.calls).toHaveLength(1);
  });

  it('already-aborted signal sends nothing', async () => {
    const ac = new AbortController();
    ac.abort();
    const model = new ScriptedAgentModel([submit()]);
    expect((await runAgent(options(model, { signal: ac.signal }))).status).toBe('cancelled');
    expect(model.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- property check

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('runAgent — property: usage never exceeds any budget (4a.7)', () => {
  it('200 seeded random scripts', async () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const rnd = mulberry32(seed);
      const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
      const budgets: AgentBudgets = {
        maxToolCalls: int(0, 12),
        maxInputTokens: int(2_000, 60_000),
        maxOutputTokens: int(1_500, 20_000),
        maxWallMs: 180_000,
        maxUsd: rnd() * 0.3,
        perTurnMaxTokens: int(1_024, 6_000)
      };
      let prevBound = 0;
      const step: ScriptStep = (req) => {
        const bound = requestTokenUpperBound(req.system, req.tools, req.messages);
        const prefix = Math.min(prevBound, bound);
        prevBound = bound;
        const cacheRead = int(0, prefix);
        const rest = int(0, bound - prefix);
        const creation = int(0, rest);
        const usage = { inputTokens: rest - creation, cacheCreationInputTokens: creation, cacheReadInputTokens: cacheRead, outputTokens: int(0, req.maxTokens) };
        const kind = rnd();
        const blocks =
          kind < 0.15
            ? [{ type: 'text' as const, text: 'prose' }]
            : kind < 0.25
              ? [tool('submit_report', rnd() < 0.5 ? { summary: 'ok' } : { summary: 1 })]
              : Array.from({ length: int(1, 3) }, () => (rnd() < 0.2 ? tool('nope', {}) : tool('echo', { q: 'q'.repeat(int(1, 400)) })));
        return { content: blocks, usage, stopReason: rnd() < 0.05 ? 'max_tokens' : undefined };
      };
      const model = new ScriptedAgentModel(Array.from({ length: 200 }, () => step));
      const r = await runAgent(options(model, { budgets }));
      const inputTotal = r.usage.inputTokens + r.usage.cacheReadInputTokens + r.usage.cacheCreationInputTokens;
      const ctx = `seed ${seed} status ${r.status}`;
      expect(inputTotal, ctx).toBeLessThanOrEqual(budgets.maxInputTokens);
      expect(r.usage.outputTokens, ctx).toBeLessThanOrEqual(budgets.maxOutputTokens);
      expect(r.costUsd, ctx).toBeLessThanOrEqual(budgets.maxUsd + 1e-9);
      expect(r.usage.toolCalls, ctx).toBeLessThanOrEqual(budgets.maxToolCalls);
      expect(r.trace.calls, ctx).toHaveLength(r.usage.toolCalls);
      expect(['submitted', 'budget-exhausted', 'no-submit', 'error'], ctx).toContain(r.status);
      expect(model.remaining, ctx).toBeGreaterThan(0);
    }
  });
});

describe('runAgent — readPaths (5a.3)', () => {
  let sandbox: Sandbox;
  let fx: BuiltFixture;

  beforeAll(async () => {
    sandbox = await createSandbox('agent-loop-readpaths');
    fx = await buildAgentFixture(sandbox, 'wrapper-module', { prepare: (root) => writeProjectFile(root, '.env', 'SENTINEL_SECRET=1\n') });
  }, 60_000);

  afterAll(async () => {
    fx.graph.close();
    await sandbox.dispose();
  });

  it('records successful read_file paths only (normalized, insertion order, deduped); refused reads and search_code are not added', async () => {
    const model = new ScriptedAgentModel([
      {
        content: [
          tool('read_file', { path: './src/lib/http.ts', start_line: 1, end_line: 3 }),
          tool('read_file', { path: '.env' }),
          tool('search_code', { query: 'axios' })
        ]
      },
      { content: [tool('read_file', { path: 'src/features/users.ts' }), tool('read_file', { path: 'src/lib/http.ts' }), tool('read_file', { path: 'src/nope.ts' })] },
      submit()
    ]);
    const r = await runAgent(
      options(model, { registry: createToolRegistry(fileTools()), ctx: { workspaceRoot: fx.projectRoot, graph: fx.graph, intel: {}, limits: { ...DEFAULT_TOOL_LIMITS } } })
    );
    expect(r.status).toBe('submitted');
    expect(r.trace.calls.map((c) => [c.tool, c.isError])).toEqual([
      ['read_file', false],
      ['read_file', true],
      ['search_code', false],
      ['read_file', false],
      ['read_file', false],
      ['read_file', true]
    ]);
    expect(r.readPaths).toEqual(['src/lib/http.ts', 'src/features/users.ts']);
  });

  it('is empty when nothing was read, and capped at READ_PATHS_MAX', async () => {
    const none = await runAgent(options(new ScriptedAgentModel([call('a'), submit()])));
    expect(none.readPaths).toEqual([]);
    const reads: AgentToolDef = { name: 'read_file', description: 'fake read', capability: 'read', inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' } } }, handler: () => ({ ok: true }) };
    const many = Array.from({ length: READ_PATHS_MAX + 20 }, (_, i) => tool('read_file', { path: `src/f${i}.ts` }));
    const r = await runAgent(options(new ScriptedAgentModel([{ content: many }, submit()]), { budgets: { ...BIG, maxToolCalls: READ_PATHS_MAX + 50 }, registry: createToolRegistry([reads]) }));
    expect(r.readPaths).toHaveLength(READ_PATHS_MAX);
    expect(r.readPaths[0]).toBe('src/f0.ts');
  });
});
