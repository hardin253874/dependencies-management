/**
 * AnthropicAgentModel (V2_STAGE4_SPEC 4a.6) against a fake `AnthropicLike`
 * stream — no network, no key.
 */
import { describe, it, expect } from 'vitest';
import Anthropic, { APIUserAbortError, RateLimitError } from '@anthropic-ai/sdk';
import { AnthropicAgentModel, buildAgentRequestParams } from '@/lib/llm/agentAnthropic';
import type { AnthropicLike } from '@/lib/llm/anthropic';
import type { AgentTurnRequest } from '@/core/agent/model';
import { createToolRegistry, toAnthropicTools } from '@/core/agent/registry';
import { graphTools } from '@/core/agent/tools/graph';
import { UPDATE_REPORT_TOOL_SCHEMA } from '@/lib/llm/prompts/update-report';

function message(over: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5-5',
    content: [{ type: 'text', text: 'hi', citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null, cache_read_input_tokens: null } as Anthropic.Usage,
    ...over
  } as Anthropic.Message;
}

function fake(result: Anthropic.Message | Error) {
  const calls: Array<{ params: Anthropic.MessageStreamParams; options?: Anthropic.RequestOptions }> = [];
  const client: AnthropicLike = {
    messages: {
      stream(params, options) {
        calls.push({ params: JSON.parse(JSON.stringify(params)) as Anthropic.MessageStreamParams, options });
        return {
          on: () => undefined,
          finalMessage: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result))
        };
      }
    }
  };
  return { client, calls };
}

const tools = toAnthropicTools(createToolRegistry(graphTools()), [UPDATE_REPORT_TOOL_SCHEMA]);
const thinking = { type: 'thinking' as const, thinking: 'plan', signature: 'sig==' };

function req(over: Partial<AgentTurnRequest> = {}): AgentTurnRequest {
  return {
    model: 'claude-sonnet-5-5',
    system: 'SYSTEM',
    tools,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'seed' }] },
      { role: 'assistant', content: [thinking, { type: 'tool_use', id: 't1', name: 'graph_summary', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{}' }] }
    ],
    maxTokens: 4000,
    effort: 'medium',
    ...over
  };
}

function countBreakpoints(v: unknown): number {
  return (JSON.stringify(v).match(/"cache_control":\{"type":"ephemeral"\}/g) ?? []).length;
}

describe('buildAgentRequestParams (4a.6)', () => {
  it('request params: sorted strict tools, auto tool_choice, effort, ≤ 4 breakpoints, no thinking param', () => {
    const p = buildAgentRequestParams(req());
    const t = p.tools as Anthropic.Tool[];
    expect(t.map((x) => x.name)).toEqual([...tools.map((x) => x.name)]);
    // 4c: only the terminal tool is strict (API limit: 24 optional params across all strict schemas).
    expect(t.filter((x) => x.strict === true).map((x) => x.name)).toEqual(['submit_update_report']);
    expect(t[t.length - 1]!.name).toBe('submit_update_report');
    expect(p.tool_choice).toEqual({ type: 'auto' });
    expect(p.output_config).toEqual({ effort: 'medium' });
    expect(p.max_tokens).toBe(4000);
    expect('thinking' in p).toBe(false);
    expect(countBreakpoints(p)).toBe(3);
    // placement: last tool, system, last block of the last user message
    expect(t[t.length - 1]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(t.slice(0, -1).every((x) => x.cache_control === undefined)).toBe(true);
    expect((p.system as Anthropic.TextBlockParam[])[0]!.cache_control).toEqual({ type: 'ephemeral' });
    const lastUser = p.messages[2]!.content as Anthropic.ContentBlockParam[];
    expect((lastUser[0] as Anthropic.ToolResultBlockParam).cache_control).toEqual({ type: 'ephemeral' });
    expect(JSON.stringify(p.messages[0])).not.toContain('cache_control');
  });

  it('does not mutate the history, and thinking blocks pass back byte-identical', () => {
    const r = req();
    const before = JSON.stringify(r.messages);
    const p = buildAgentRequestParams(r);
    expect(JSON.stringify(r.messages)).toBe(before);
    expect(JSON.stringify((p.messages[1]!.content as unknown[])[0])).toBe(JSON.stringify(thinking));
  });
});

describe('AnthropicAgentModel.turn (4a.6)', () => {
  it('returns content, stop reason, model, and usage with null cache fields mapped to 0', async () => {
    const f = fake(message({ stop_reason: 'tool_use' }));
    const r = await new AnthropicAgentModel({ apiKey: 'test-key', client: f.client }).turn(req());
    expect(r.stopReason).toBe('tool_use');
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
    expect(r.model).toBe('claude-sonnet-5-5');
    expect(f.calls).toHaveLength(1);
  });

  it('max_tokens is returned, not thrown', async () => {
    const r = await new AnthropicAgentModel({ apiKey: 'k', client: fake(message({ stop_reason: 'max_tokens' })).client }).turn(req());
    expect(r.stopReason).toBe('max_tokens');
  });

  it('refusal → LLM_REFUSAL, context window → LLM_TRUNCATED', async () => {
    await expect(new AnthropicAgentModel({ apiKey: 'k', client: fake(message({ stop_reason: 'refusal' })).client }).turn(req())).rejects.toMatchObject({
      code: 'LLM_REFUSAL'
    });
    await expect(
      new AnthropicAgentModel({ apiKey: 'k', client: fake(message({ stop_reason: 'model_context_window_exceeded' })).client }).turn(req())
    ).rejects.toMatchObject({ code: 'LLM_TRUNCATED' });
  });

  it('abort and SDK errors map through mapAnthropicError', async () => {
    await expect(new AnthropicAgentModel({ apiKey: 'k', client: fake(new APIUserAbortError()).client }).turn(req())).rejects.toMatchObject({
      code: 'LLM_CANCELLED'
    });
    const rate = new RateLimitError(429, { type: 'error' }, 'slow down', new Headers());
    await expect(new AnthropicAgentModel({ apiKey: 'k', client: fake(rate).client }).turn(req())).rejects.toMatchObject({ code: 'LLM_RATE_LIMIT' });
    const ac = new AbortController();
    ac.abort();
    const f = fake(message());
    await expect(new AnthropicAgentModel({ apiKey: 'k', client: f.client }).turn(req({ signal: ac.signal }))).rejects.toMatchObject({ code: 'LLM_CANCELLED' });
    expect(f.calls).toHaveLength(0);
  });

  it('passes the abort signal to the SDK and refuses an empty key', async () => {
    const ac = new AbortController();
    const f = fake(message());
    await new AnthropicAgentModel({ apiKey: 'k', client: f.client }).turn(req({ signal: ac.signal }));
    expect(f.calls[0]!.options?.signal).toBe(ac.signal);
    expect(() => new AnthropicAgentModel({ apiKey: '' })).toThrow(/not configured/);
  });
});
