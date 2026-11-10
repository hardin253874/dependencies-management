/**
 * The provider adapter must refuse output cut off at the max-output-token limit.
 *
 * Regression for 2026-09-24: a deep-report tool_use came back without its
 * `summary` + `narrative` strings, the service persisted `undefined`, JSON
 * dropped the keys, and the app shell crashed on boot with
 * "Cannot read properties of undefined (reading 'split')".
 *
 * v2 Stage 1.4: ported to SDK 1.x-shaped fakes (`messages.stream`).
 */
import { describe, it, expect } from 'vitest';
import { AnthropicAdapter } from '@/lib/llm/anthropic';
import type { LlmCallRequest } from '@/lib/llm/client';
import { fakeSdk, makeMessage, makeUsage, toolUseBlock } from './helpers/fakeAnthropic';

const REQ: LlmCallRequest = {
  model: 'test-model',
  systemPrompt: 'sys',
  userPrompt: 'user',
  tool: {
    name: 'submit',
    description: 'd',
    inputSchema: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
      additionalProperties: false
    }
  },
  maxOutputTokens: 100,
  effort: 'medium'
};

describe('Anthropic adapter — max_tokens truncation', () => {
  it('throws LLM_TRUNCATED when stop_reason is max_tokens, even if a tool_use block exists', async () => {
    const { sdk } = fakeSdk(() =>
      makeMessage({
        stop_reason: 'max_tokens',
        content: [toolUseBlock('submit', { riskLevel: 'high' })],
        usage: makeUsage({ input_tokens: 10, output_tokens: 100 })
      })
    );
    const adapter = new AnthropicAdapter({ apiKey: 'k', client: sdk });
    await expect(adapter.call(REQ)).rejects.toMatchObject({
      name: 'LLMError',
      code: 'LLM_TRUNCATED'
    });
  });

  it('returns the tool input when stop_reason is tool_use', async () => {
    const { sdk } = fakeSdk(() =>
      makeMessage({ stop_reason: 'tool_use', content: [toolUseBlock('submit', { summary: 'ok' })] })
    );
    const adapter = new AnthropicAdapter({ apiKey: 'k', client: sdk });
    const res = await adapter.call<{ summary: string }>(REQ);
    expect(res.output.summary).toBe('ok');
  });
});
