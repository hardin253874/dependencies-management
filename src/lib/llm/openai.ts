/**
 * OpenAI LLM client adapter (spec §10.2, §11.2, §11.8).
 *
 * Wraps the `openai` SDK and exposes the `LLMClient` interface. Uses
 * Chat Completions with `tools` + `tool_choice` forcing the model to invoke
 * the single tool we provide. Streaming is enabled so phase events fire while
 * the response generates; partial tool-call JSON is never surfaced to the
 * caller (spec §11.8).
 */
import OpenAI from 'openai';
import { LLMError, type LLMClient, type LlmCallRequest, type LlmCallResult, type ToolSchema } from './client';
import { costEstimateUsd } from './cost';
import { getLogger } from '../logger';

export interface OpenAIAdapterOptions {
  apiKey: string;
  /** Override the underlying SDK client (tests inject a stub). */
  client?: OpenAILike;
}

/**
 * Minimal subset of `openai` SDK used here. Tests inject a fake that satisfies
 * this shape without depending on the full SDK type surface.
 */
export interface OpenAILike {
  chat: {
    completions: {
      create(params: OpenAICreateParams): Promise<OpenAIChatCompletion> | AsyncIterable<OpenAIChunk>;
    };
  };
}

export interface OpenAICreateParams {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  tools: Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }>;
  tool_choice: { type: 'function'; function: { name: string } };
  max_tokens?: number;
  max_completion_tokens?: number;
  stream?: boolean;
}

export interface OpenAIChatCompletion {
  id: string;
  model: string;
  choices: Array<{
    finish_reason: string | null;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export interface OpenAIChunk {
  choices: Array<{
    delta?: {
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
      content?: string;
    };
    finish_reason: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
  model?: string;
}

export class OpenAIAdapter implements LLMClient {
  readonly provider = 'openai' as const;
  private readonly sdk: OpenAILike;

  constructor(opts: OpenAIAdapterOptions) {
    if (opts.apiKey === '' || opts.apiKey === undefined) {
      throw new LLMError('LLM_NO_API_KEY', 'OpenAI API key not configured.');
    }
    this.sdk = opts.client ?? (new OpenAI({ apiKey: opts.apiKey }) as unknown as OpenAILike);
  }

  async call<T = unknown>(req: LlmCallRequest): Promise<LlmCallResult<T>> {
    req.onPhase?.({ phase: 'calling', message: 'Calling OpenAI…' });
    if (req.signal?.aborted) throw new LLMError('LLM_CANCELLED', 'Cancelled before request');

    const params: OpenAICreateParams = {
      model: req.model,
      messages: [
        { role: 'system', content: req.systemPrompt },
        { role: 'user', content: req.userPrompt }
      ],
      tools: [translateTool(req.tool)],
      tool_choice: { type: 'function', function: { name: req.tool.name } },
      max_tokens: req.maxOutputTokens,
      stream: true
    };

    let argumentsJson = '';
    let model = req.model;
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      const resp = await this.sdk.chat.completions.create(params);
      if (isAsyncIterable<OpenAIChunk>(resp)) {
        let sawFirstEvent = false;
        for await (const chunk of resp) {
          if (req.signal?.aborted) throw new LLMError('LLM_CANCELLED', 'Cancelled mid-stream');
          if (!sawFirstEvent) {
            sawFirstEvent = true;
            req.onPhase?.({ phase: 'streaming', message: 'Generating analysis…' });
          }
          if (typeof chunk.model === 'string' && chunk.model !== '') model = chunk.model;
          const delta = chunk.choices[0]?.delta;
          if (delta?.tool_calls !== undefined) {
            for (const tc of delta.tool_calls) {
              if (typeof tc.function?.arguments === 'string') {
                argumentsJson += tc.function.arguments;
              }
            }
          }
          if (chunk.usage !== undefined) {
            inputTokens = chunk.usage.prompt_tokens;
            outputTokens = chunk.usage.completion_tokens;
          }
        }
      } else {
        const completion = resp;
        if (typeof completion.model === 'string') model = completion.model;
        const toolCall = completion.choices[0]?.message.tool_calls?.[0];
        if (toolCall === undefined) {
          throw new LLMError('LLM_TOOL_USE_MISSING', 'OpenAI response did not include a tool_call.');
        }
        argumentsJson = toolCall.function.arguments;
        if (completion.usage !== undefined) {
          inputTokens = completion.usage.prompt_tokens;
          outputTokens = completion.usage.completion_tokens;
        }
      }
    } catch (err) {
      if (err instanceof LLMError) throw err;
      throw mapOpenAIError(err);
    }

    req.onPhase?.({ phase: 'finalizing', message: 'Finalizing structured output…' });

    if (argumentsJson === '') {
      throw new LLMError('LLM_TOOL_USE_MISSING', 'OpenAI tool_call arguments were empty.');
    }
    let parsed: T;
    try {
      parsed = JSON.parse(argumentsJson) as T;
    } catch (err) {
      throw new LLMError(
        'LLM_TOOL_USE_INVALID',
        `OpenAI tool_call arguments not valid JSON: ${(err as Error).message}`
      );
    }

    return {
      output: parsed,
      inputTokens,
      outputTokens,
      model,
      provider: 'openai',
      costEstimateUsd: costEstimateUsd('openai', model, inputTokens, outputTokens)
    };
  }
}

export function translateTool(tool: ToolSchema): {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
} {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  };
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return value !== null && typeof value === 'object' && Symbol.asyncIterator in (value as object);
}

function mapOpenAIError(err: unknown): LLMError {
  const e = err as { name?: string; status?: number; message?: string };
  if (e?.name === 'AbortError') return new LLMError('LLM_CANCELLED', 'Cancelled');
  const status = typeof e.status === 'number' ? e.status : undefined;
  const message = e.message ?? 'OpenAI call failed';
  if (status === 401) return new LLMError('LLM_NO_API_KEY', message);
  if (status === 429) return new LLMError('LLM_RATE_LIMIT', message, true);
  if (status === 408 || status === 504) return new LLMError('LLM_TIMEOUT', message, true);
  if (status !== undefined && status >= 500) return new LLMError('LLM_NETWORK', message, true);
  // Fire-and-forget log — never block error mapping on logger init.
  void getLogger().then((log) => log.warn({ err }, 'OpenAI call failed')).catch(() => undefined);
  return new LLMError('LLM_NETWORK', message, true);
}
