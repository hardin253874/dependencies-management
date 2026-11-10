/**
 * v2 Stage 1.4 — Anthropic adapter on `@anthropic-ai/sdk` 1.x.
 *
 * All with injected SDK-shaped fakes; no network, no API key. Covers the
 * request shape (auto + strict, effort, cache_control, no budget_tokens),
 * refusal / truncation / text-only handling, prompt-cache usage accounting,
 * abort wiring, the error-mapping table, client settings, and a strict-mode
 * guard over every view's tool schema.
 */
import { describe, it, expect } from 'vitest';
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError
} from '@anthropic-ai/sdk';
import {
  ANTHROPIC_MAX_RETRIES,
  ANTHROPIC_TIMEOUT_MS,
  AnthropicAdapter,
  createAnthropicSdk,
  mapAnthropicError
} from '@/lib/llm/anthropic';
import { LLMError, type LlmCallRequest, type ToolSchema } from '@/lib/llm/client';
import { costEstimateUsd } from '@/lib/llm/cost';
import { CVE_IMPACT_TOOL_SCHEMA } from '@/lib/llm/prompts/cve-impact';
import { DEEP_UPDATE_REPORT_TOOL_SCHEMA } from '@/lib/llm/prompts/deep-update-report';
import { FILE_REVIEW_TOOL_SCHEMA } from '@/lib/llm/prompts/file-review';
import { RELATED_UPGRADE_TOOL_SCHEMA } from '@/lib/llm/prompts/related-upgrade';
import { UPDATE_REPORT_TOOL_SCHEMA } from '@/lib/llm/prompts/update-report';
import { fakeSdk, makeMessage, makeUsage, textBlock, toolUseBlock } from './helpers/fakeAnthropic';

const TOOL: ToolSchema = {
  name: 'submit',
  description: 'Submit the analysis',
  inputSchema: {
    type: 'object',
    properties: { summary: { type: 'string' } },
    required: ['summary'],
    additionalProperties: false
  }
};

function req(over: Partial<LlmCallRequest> = {}): LlmCallRequest {
  return {
    model: 'claude-opus-5-5',
    systemPrompt: 'You are a dependency analyst.',
    userPrompt: 'Analyse react 17 → 18.',
    tool: TOOL,
    maxOutputTokens: 4000,
    effort: 'high',
    ...over
  };
}

const OK = makeMessage({ content: [toolUseBlock('submit', { summary: 'ok' })] });

describe('1. request shape', () => {
  it('auto tool choice (single call), strict tool, explicit effort, cache_control on system + last tool', async () => {
    const { sdk, calls } = fakeSdk(() => OK);
    await new AnthropicAdapter({ apiKey: 'k', client: sdk }).call(req({ effort: 'medium' }));
    expect(calls).toHaveLength(1);
    const p = calls[0]!.params;
    expect(p.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    const tools = p.tools as Array<{ name: string; strict?: boolean; cache_control?: unknown }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]!.strict).toBe(true);
    expect(tools[tools.length - 1]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(p.output_config).toEqual({ effort: 'medium' });
    expect(p.system).toEqual([
      { type: 'text', text: 'You are a dependency analyst.', cache_control: { type: 'ephemeral' } }
    ]);
    expect(p.messages).toEqual([{ role: 'user', content: 'Analyse react 17 → 18.' }]);
    expect(p.max_tokens).toBe(4000);
  });

  it('sends no thinking budget, no forced tool choice and no stream flag', async () => {
    const { sdk, calls } = fakeSdk(() => OK);
    await new AnthropicAdapter({ apiKey: 'k', client: sdk }).call(req());
    const json = JSON.stringify(calls[0]!.params);
    expect(json).not.toContain('budget_tokens');
    expect(calls[0]!.params).not.toHaveProperty('thinking');
    expect(calls[0]!.params).not.toHaveProperty('stream');
    expect((calls[0]!.params.tool_choice as { type: string }).type).toBe('auto');
  });

  it('does not mutate the ToolSchema (strict lives in the adapter, so cache keys are stable)', async () => {
    const before = JSON.stringify(TOOL);
    const { sdk } = fakeSdk(() => OK);
    await new AnthropicAdapter({ apiKey: 'k', client: sdk }).call(req());
    expect(JSON.stringify(TOOL)).toBe(before);
    expect(TOOL).not.toHaveProperty('strict');
  });
});

describe('2. refusal', () => {
  it('stop_reason refusal with stop_details → LLM_REFUSAL (category in message), content not read', async () => {
    const content = [toolUseBlock('submit', { summary: 'should not be used' })];
    const { sdk } = fakeSdk(() =>
      makeMessage({
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber', explanation: null },
        content
      })
    );
    const err = await new AnthropicAdapter({ apiKey: 'k', client: sdk }).call(req()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect((err as LLMError).code).toBe('LLM_REFUSAL');
    expect((err as LLMError).retryable).toBe(false);
    expect((err as LLMError).message).toContain('cyber');
  });

  it('stop_reason refusal without stop_details → LLM_REFUSAL', async () => {
    const { sdk } = fakeSdk(() => makeMessage({ stop_reason: 'refusal', stop_details: null, content: [] }));
    await expect(new AnthropicAdapter({ apiKey: 'k', client: sdk }).call(req())).rejects.toMatchObject({
      code: 'LLM_REFUSAL'
    });
  });
});

describe('3–4. truncation and text-only answers', () => {
  it('max_tokens → LLM_TRUNCATED', async () => {
    const { sdk } = fakeSdk(() =>
      makeMessage({ stop_reason: 'max_tokens', content: [toolUseBlock('submit', { summary: 'par' })] })
    );
    await expect(new AnthropicAdapter({ apiKey: 'k', client: sdk }).call(req())).rejects.toMatchObject({
      code: 'LLM_TRUNCATED'
    });
  });

  it('model_context_window_exceeded → LLM_TRUNCATED naming the context window', async () => {
    const { sdk } = fakeSdk(() => makeMessage({ stop_reason: 'model_context_window_exceeded', content: [] }));
    const err = await new AnthropicAdapter({ apiKey: 'k', client: sdk }).call(req()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect((err as LLMError).code).toBe('LLM_TRUNCATED');
    expect((err as LLMError).message).toMatch(/context window/);
  });

  it('end_turn with only a text block → LLM_TOOL_USE_MISSING', async () => {
    const { sdk } = fakeSdk(() =>
      makeMessage({ stop_reason: 'end_turn', content: [textBlock('Here is my analysis in prose…')] })
    );
    await expect(new AnthropicAdapter({ apiKey: 'k', client: sdk }).call(req())).rejects.toMatchObject({
      code: 'LLM_TOOL_USE_MISSING'
    });
  });
});

describe('5. prompt-cache usage accounting', () => {
  it('carries input/output/cache_read/cache_creation and prices them', async () => {
    const { sdk } = fakeSdk(() =>
      makeMessage({
        model: 'claude-opus-5-5',
        content: [toolUseBlock('submit', { summary: 'ok' })],
        usage: makeUsage({
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 200
        })
      })
    );
    const res = await new AnthropicAdapter({ apiKey: 'k', client: sdk }).call(req());
    expect(res).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 1000,
      cacheCreationInputTokens: 200,
      model: 'claude-opus-5-5'
    });
    // Hand-computed, opus-5-5: 100×$4 + 1000×$0.20 + 200×$5 + 50×$20 per MTok.
    const expected = (100 * 4 + 1000 * 0.2 + 200 * 5 + 50 * 20) / 1_000_000;
    expect(res.costEstimateUsd).toBeCloseTo(expected, 9);
    expect(res.costEstimateUsd).toBe(
      costEstimateUsd('claude-opus-5-5', {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 1000,
        cacheCreationInputTokens: 200
      })
    );
  });

  it('null cache fields → 0', async () => {
    const { sdk } = fakeSdk(() => OK);
    const res = await new AnthropicAdapter({ apiKey: 'k', client: sdk }).call(req());
    expect(res.cacheReadInputTokens).toBe(0);
    expect(res.cacheCreationInputTokens).toBe(0);
  });

  it('result.model comes from the response, not the request', async () => {
    const { sdk } = fakeSdk(() => makeMessage({ ...OK, model: 'claude-sonnet-5-5' }));
    const res = await new AnthropicAdapter({ apiKey: 'k', client: sdk }).call(req({ model: 'claude-opus-5-5' }));
    expect(res.model).toBe('claude-sonnet-5-5');
  });
});

describe('6. abort', () => {
  it('an already-aborted signal → LLM_CANCELLED without an SDK call', async () => {
    const { sdk, calls } = fakeSdk(() => OK);
    const controller = new AbortController();
    controller.abort();
    await expect(
      new AnthropicAdapter({ apiKey: 'k', client: sdk }).call(req({ signal: controller.signal }))
    ).rejects.toMatchObject({ code: 'LLM_CANCELLED' });
    expect(calls).toHaveLength(0);
  });

  it('aborting mid-stream → LLM_CANCELLED; the signal is passed as the SDK request option', async () => {
    const controller = new AbortController();
    const { sdk, calls } = fakeSdk(
      (call) =>
        new Promise((_resolve, reject) => {
          call.options?.signal?.addEventListener('abort', () => reject(new APIUserAbortError()), {
            once: true
          });
        })
    );
    const pending = new AnthropicAdapter({ apiKey: 'k', client: sdk }).call(req({ signal: controller.signal }));
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'LLM_CANCELLED' });
    expect(calls[0]!.options?.signal).toBe(controller.signal);
  });

  it('emits calling → streaming → finalizing phases', async () => {
    const phases: string[] = [];
    const { sdk } = fakeSdk(() => OK);
    await new AnthropicAdapter({ apiKey: 'k', client: sdk }).call(req({ onPhase: (e) => phases.push(e.phase) }));
    expect(phases).toEqual(['calling', 'streaming', 'finalizing']);
  });
});

describe('7. error mapping (SDK typed errors)', () => {
  const h = new Headers();
  const cases: Array<[string, unknown, string, boolean]> = [
    ['401', APIError.generate(401, { type: 'error' }, 'bad key', h), 'LLM_NO_API_KEY', false],
    ['429', APIError.generate(429, { type: 'error' }, 'slow down', h), 'LLM_RATE_LIMIT', true],
    ['400', APIError.generate(400, { type: 'error' }, 'tool_choice not supported', h), 'LLM_BAD_REQUEST', false],
    ['404', APIError.generate(404, { type: 'error' }, 'model not found', h), 'LLM_BAD_REQUEST', false],
    ['500', APIError.generate(500, { type: 'error' }, 'boom', h), 'LLM_NETWORK', true],
    ['529', APIError.generate(529, { type: 'error' }, 'overloaded', h), 'LLM_NETWORK', true],
    ['504', APIError.generate(504, { type: 'error' }, 'gateway timeout', h), 'LLM_TIMEOUT', true],
    ['408', APIError.generate(408, { type: 'error' }, 'request timeout', h), 'LLM_TIMEOUT', true],
    ['client timeout', new APIConnectionTimeoutError(), 'LLM_TIMEOUT', true],
    ['connection', new APIConnectionError({ message: 'ECONNRESET' }), 'LLM_NETWORK', true],
    ['user abort', new APIUserAbortError(), 'LLM_CANCELLED', false]
  ];
  for (const [label, err, code, retryable] of cases) {
    it(`${label} → ${code} (retryable: ${retryable})`, () => {
      const mapped = mapAnthropicError(err);
      expect(mapped.code).toBe(code);
      expect(mapped.retryable).toBe(retryable);
    });
  }

  it('errors thrown by the stream reach the caller mapped', async () => {
    const { sdk } = fakeSdk(() => {
      throw APIError.generate(400, { type: 'error' }, 'tool_choice: type "tool" is not supported', new Headers());
    });
    await expect(new AnthropicAdapter({ apiKey: 'k', client: sdk }).call(req())).rejects.toMatchObject({
      code: 'LLM_BAD_REQUEST',
      retryable: false
    });
  });
});

describe('client settings (single retry layer)', () => {
  it('the real SDK client gets an explicit timeout (ms) and maxRetries; nothing is sent', () => {
    const client = createAnthropicSdk('sk-ant-test-not-a-real-key');
    expect(client.timeout).toBe(ANTHROPIC_TIMEOUT_MS);
    expect(client.maxRetries).toBe(ANTHROPIC_MAX_RETRIES);
  });
});

describe('8. strict-mode guard over every view tool schema', () => {
  const SCHEMAS: Record<string, ToolSchema> = {
    cveImpact: CVE_IMPACT_TOOL_SCHEMA,
    deepUpdateReport: DEEP_UPDATE_REPORT_TOOL_SCHEMA,
    fileReview: FILE_REVIEW_TOOL_SCHEMA,
    relatedUpgrade: RELATED_UPGRADE_TOOL_SCHEMA,
    updateReport: UPDATE_REPORT_TOOL_SCHEMA
  };
  // Not supported by strict tool use (structured-outputs docs, checked 2026-11-09).
  const UNSUPPORTED = ['minimum', 'maximum', 'multipleOf', 'minLength', 'maxLength', 'maxItems', 'pattern', '$ref'];
  // Strict limit: 24 optional params across all strict schemas in one request.
  const MAX_OPTIONAL = 24;

  interface Walk {
    problems: string[];
    optional: number;
  }

  function walk(node: unknown, path: string, acc: Walk): void {
    if (typeof node !== 'object' || node === null) return;
    const n = node as Record<string, unknown>;
    for (const k of UNSUPPORTED) if (k in n) acc.problems.push(`${path}: unsupported keyword ${k}`);
    if ('minItems' in n && (n.minItems as number) > 1) acc.problems.push(`${path}: minItems > 1`);
    if (n.type === 'object') {
      if (n.additionalProperties !== false) acc.problems.push(`${path}: additionalProperties must be false`);
      if (!Array.isArray(n.required)) acc.problems.push(`${path}: missing required[]`);
      const props = (n.properties ?? {}) as Record<string, unknown>;
      const required = new Set(Array.isArray(n.required) ? (n.required as string[]) : []);
      for (const r of required) if (!(r in props)) acc.problems.push(`${path}: required '${r}' not in properties`);
      for (const [k, v] of Object.entries(props)) {
        if (!required.has(k)) acc.optional += 1;
        walk(v, `${path}.${k}`, acc);
      }
    }
    if (n.type === 'array') walk(n.items, `${path}[]`, acc);
    if (Array.isArray(n.enum) && n.enum.some((v) => typeof v === 'object' && v !== null)) {
      acc.problems.push(`${path}: complex enum values`);
    }
  }

  for (const [name, schema] of Object.entries(SCHEMAS)) {
    it(`${name}: every object has additionalProperties:false + required[], no unsupported keywords`, () => {
      const acc: Walk = { problems: [], optional: 0 };
      walk(schema.inputSchema, name, acc);
      expect(acc.problems).toEqual([]);
      expect(acc.optional).toBeLessThanOrEqual(MAX_OPTIONAL);
    });
  }
});
