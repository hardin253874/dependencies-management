/**
 * Anthropic LLM client adapter (spec §10.2, §11.2, §11.8).
 *
 * Wraps `@anthropic-ai/sdk` and exposes the `LLMClient` interface. Tool-use is
 * mandatory: every call sends a single tool with `tool_choice` forcing the
 * model to invoke it. Streaming is enabled so phase events fire while the
 * response is generated; the partial JSON of the tool call is NEVER surfaced
 * to the caller (the spec forbids client-side rendering of partial JSON).
 *
 * Retry handling lives one level up in the call-site (`p-retry`); this adapter
 * focuses on translating SDK events into `LlmCallResult` + `LLMError`.
 */
import Anthropic from '@anthropic-ai/sdk';
import { LLMError, type LLMClient, type LlmCallRequest, type LlmCallResult, type ToolSchema } from './client';
import { costEstimateUsd } from './cost';
import { getLogger } from '../logger';

export interface AnthropicAdapterOptions {
  apiKey: string;
  /** Override the underlying SDK client (tests inject a stub). */
  client?: AnthropicLike;
}

/**
 * Minimal subset of `@anthropic-ai/sdk` we depend on. Defined as an
 * interface so tests can inject a fake without coupling to the SDK internals.
 */
export interface AnthropicLike {
  messages: {
    create(params: AnthropicCreateParams): Promise<AnthropicMessageResponse>;
    stream?(params: AnthropicCreateParams): AnthropicStreamHandle;
  };
}

export interface AnthropicCreateParams {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  tools: Array<{ name: string; description: string; input_schema: unknown }>;
  tool_choice?: { type: 'tool'; name: string };
  stream?: boolean;
}

export interface AnthropicMessageResponse {
  id: string;
  model: string;
  stop_reason: string | null;
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
  >;
  usage: { input_tokens: number; output_tokens: number };
}

export interface AnthropicStreamHandle {
  on(event: string, listener: (...args: unknown[]) => void): void;
  finalMessage(): Promise<AnthropicMessageResponse>;
  abort?(): void;
}

export class AnthropicAdapter implements LLMClient {
  readonly provider = 'anthropic' as const;
  private readonly sdk: AnthropicLike;

  constructor(opts: AnthropicAdapterOptions) {
    if (opts.apiKey === '' || opts.apiKey === undefined) {
      throw new LLMError('LLM_NO_API_KEY', 'Anthropic API key not configured.');
    }
    this.sdk =
      opts.client ??
      (new Anthropic({ apiKey: opts.apiKey }) as unknown as AnthropicLike);
  }

  async call<T = unknown>(req: LlmCallRequest): Promise<LlmCallResult<T>> {
    req.onPhase?.({ phase: 'calling', message: 'Calling Anthropic…' });
    if (req.signal?.aborted) throw new LLMError('LLM_CANCELLED', 'Cancelled before request');

    const params: AnthropicCreateParams = {
      model: req.model,
      max_tokens: req.maxOutputTokens,
      system: req.systemPrompt,
      messages: [{ role: 'user', content: req.userPrompt }],
      tools: [translateTool(req.tool)],
      tool_choice: { type: 'tool', name: req.tool.name }
    };

    let response: AnthropicMessageResponse;
    try {
      // Use streaming when available so we can fire phase events before the
      // final tool call settles. Either branch returns the same shape, so
      // downstream parsing is identical.
      if (typeof this.sdk.messages.stream === 'function') {
        const handle = this.sdk.messages.stream({ ...params, stream: true });
        let firstEventSeen = false;
        const onEvent = (): void => {
          if (firstEventSeen) return;
          firstEventSeen = true;
          req.onPhase?.({ phase: 'streaming', message: 'Generating analysis…' });
        };
        handle.on('text', onEvent);
        handle.on('streamEvent', onEvent);
        if (req.signal !== undefined) {
          req.signal.addEventListener('abort', () => handle.abort?.(), { once: true });
        }
        response = await handle.finalMessage();
      } else {
        response = await this.sdk.messages.create(params);
      }
    } catch (err) {
      throw mapAnthropicError(err);
    }

    req.onPhase?.({ phase: 'finalizing', message: 'Finalizing structured output…' });

    const tool = response.content.find((c) => c.type === 'tool_use');
    if (tool === undefined) {
      throw new LLMError('LLM_TOOL_USE_MISSING', 'Anthropic response did not include a tool_use block.');
    }
    if (tool.type !== 'tool_use') {
      throw new LLMError('LLM_TOOL_USE_INVALID', 'Anthropic tool_use entry malformed.');
    }
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;

    return {
      output: tool.input as T,
      inputTokens,
      outputTokens,
      model: response.model || req.model,
      provider: 'anthropic',
      costEstimateUsd: costEstimateUsd('anthropic', response.model || req.model, inputTokens, outputTokens)
    };
  }
}

export function translateTool(tool: ToolSchema): { name: string; description: string; input_schema: unknown } {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema
  };
}

function mapAnthropicError(err: unknown): LLMError {
  // The SDK throws typed errors with `status` + `name`. We map the well-known
  // ones to our LlmErrorCode taxonomy; anything else is `LLM_NETWORK`.
  const e = err as { name?: string; status?: number; message?: string };
  if (e?.name === 'AbortError' || (err as Error).name === 'AbortError') {
    return new LLMError('LLM_CANCELLED', 'Cancelled');
  }
  const status = typeof e.status === 'number' ? e.status : undefined;
  const message = e.message ?? 'Anthropic call failed';
  if (status === 401) return new LLMError('LLM_NO_API_KEY', message);
  if (status === 429) return new LLMError('LLM_RATE_LIMIT', message, true);
  if (status === 408 || status === 504) return new LLMError('LLM_TIMEOUT', message, true);
  if (status !== undefined && status >= 500) return new LLMError('LLM_NETWORK', message, true);
  // Fire-and-forget log — never block error mapping on logger init.
  void getLogger().then((log) => log.warn({ err }, 'Anthropic call failed')).catch(() => undefined);
  return new LLMError('LLM_NETWORK', message, true);
}
