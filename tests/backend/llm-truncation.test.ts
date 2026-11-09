/**
 * Provider adapters must refuse output cut off at the max-output-token limit.
 *
 * Regression for 2026-09-24: a deep-report tool_use came back without its
 * `summary` + `narrative` strings, the service persisted `undefined`, JSON
 * dropped the keys, and the app shell crashed on boot with
 * "Cannot read properties of undefined (reading 'split')".
 */
import { describe, it, expect } from 'vitest';
import { AnthropicAdapter, type AnthropicLike } from '@/lib/llm/anthropic';
import { OpenAIAdapter, type OpenAILike, type OpenAIChunk } from '@/lib/llm/openai';
import type { LlmCallRequest } from '@/lib/llm/client';

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
      required: ['summary']
    }
  },
  maxOutputTokens: 100
};

describe('Anthropic adapter — max_tokens truncation', () => {
  it('throws LLM_TRUNCATED when stop_reason is max_tokens, even if a tool_use block exists', async () => {
    const sdk: AnthropicLike = {
      messages: {
        create: async () => ({
          id: 'm1',
          model: 'test-model',
          stop_reason: 'max_tokens',
          content: [{ type: 'tool_use', id: 't1', name: 'submit', input: { riskLevel: 'high' } }],
          usage: { input_tokens: 10, output_tokens: 100 }
        })
      }
    };
    const adapter = new AnthropicAdapter({ apiKey: 'k', client: sdk });
    await expect(adapter.call(REQ)).rejects.toMatchObject({
      name: 'LLMError',
      code: 'LLM_TRUNCATED'
    });
  });

  it('returns the tool input when stop_reason is tool_use', async () => {
    const sdk: AnthropicLike = {
      messages: {
        create: async () => ({
          id: 'm1',
          model: 'test-model',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 't1', name: 'submit', input: { summary: 'ok' } }],
          usage: { input_tokens: 10, output_tokens: 5 }
        })
      }
    };
    const adapter = new AnthropicAdapter({ apiKey: 'k', client: sdk });
    const res = await adapter.call<{ summary: string }>(REQ);
    expect(res.output.summary).toBe('ok');
  });
});

describe('OpenAI adapter — length truncation', () => {
  function streamOf(chunks: OpenAIChunk[]): AsyncIterable<OpenAIChunk> {
    return {
      async *[Symbol.asyncIterator]() {
        for (const c of chunks) yield c;
      }
    };
  }

  it('throws LLM_TRUNCATED when a streamed choice finishes with reason length', async () => {
    const sdk: OpenAILike = {
      chat: {
        completions: {
          create: () =>
            streamOf([
              {
                choices: [
                  {
                    delta: { tool_calls: [{ index: 0, function: { arguments: '{"summary":"par' } }] },
                    finish_reason: null
                  }
                ]
              },
              { choices: [{ delta: {}, finish_reason: 'length' }] }
            ])
        }
      }
    };
    const adapter = new OpenAIAdapter({ apiKey: 'k', client: sdk });
    await expect(adapter.call(REQ)).rejects.toMatchObject({
      name: 'LLMError',
      code: 'LLM_TRUNCATED'
    });
  });

  it('parses the tool_call when the stream finishes with tool_calls', async () => {
    const sdk: OpenAILike = {
      chat: {
        completions: {
          create: () =>
            streamOf([
              {
                choices: [
                  {
                    delta: { tool_calls: [{ index: 0, function: { arguments: '{"summary":"ok"}' } }] },
                    finish_reason: null
                  }
                ]
              },
              { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
            ])
        }
      }
    };
    const adapter = new OpenAIAdapter({ apiKey: 'k', client: sdk });
    const res = await adapter.call<{ summary: string }>(REQ);
    expect(res.output.summary).toBe('ok');
  });
});
