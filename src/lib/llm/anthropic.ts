/**
 * Anthropic LLM client adapter (spec §10.2, §11.2, §11.8), `@anthropic-ai/sdk` 1.x.
 *
 * Request shape (v2 Stage 1.4, checked against the installed SDK 1.6.0 types):
 * - One tool, `tool_choice: { type: 'auto', disable_parallel_tool_use: true }`.
 *   Forced tool use (tool_choice of type tool or any) returns 400 on Opus 5.5,
 *   Sonnet 5.5 and Fable 5.1. With `auto` the model may answer in text; that
 *   surfaces as `LLM_TOOL_USE_MISSING` and the service falls back to
 *   deterministic-partial.
 * - `strict: true` is added HERE (not in `ToolSchema`) so `computeCacheKey`,
 *   which hashes the ToolSchema, keeps existing on-disk caches + fixtures valid.
 * - No `thinking` param: every picker model runs adaptive thinking when it is
 *   omitted, and fixed thinking budgets and disabled thinking are 400s on current models.
 *   Depth is controlled by `output_config.effort` (set per view, effort.ts).
 * - Prompt caching: `cache_control: ephemeral` on the (only, hence last) tool
 *   and on the system block. Render order is tools → system → messages, so the
 *   stable prefix is tool schema + shared system prompt; the per-dep user
 *   prompt stays uncached. Prefixes below the model minimum (512 tokens on
 *   current models) silently don't cache — accounting still works (0 tokens).
 *
 * Streaming via `messages.stream()` → `finalMessage()`; the partial JSON of the
 * tool call is NEVER surfaced to the caller (spec forbids it).
 *
 * Retries: the SDK is the single retry layer (`maxRetries`, it retries
 * 408/409/429/5xx + connection errors with backoff). Nothing above the adapter
 * retries LLM calls, so `LLMError.retryable` is informational only.
 */
import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  GatewayTimeoutError,
  InternalServerError,
  RateLimitError,
  RequestTimeoutError
} from '@anthropic-ai/sdk';
import { LLMError, type LLMClient, type LlmCallRequest, type LlmCallResult, type ToolSchema } from './client';
import { costEstimateUsd } from './cost';
import { getLogger } from '../logger';

/** Explicit client settings (ms in the TS SDK). 10 min matches the SDK default; set so it is visible and tested. */
export const ANTHROPIC_TIMEOUT_MS = 600_000;
export const ANTHROPIC_MAX_RETRIES = 2;
/** How much of an unexpected text answer goes into the warn log (never into the envelope). */
const TEXT_LOG_CHARS = 200;

export interface AnthropicAdapterOptions {
  apiKey: string;
  /** Override the underlying SDK client (tests inject a fake). */
  client?: AnthropicLike;
}

/** The part of a `MessageStream` the adapter uses; typed with SDK types. */
export interface AnthropicStreamLike {
  on(event: 'streamEvent', listener: (event: Anthropic.MessageStreamEvent) => void): unknown;
  finalMessage(): Promise<Anthropic.Message>;
}

/**
 * Injection seam: the slice of the SDK client the adapter depends on. The
 * real `Anthropic` instance satisfies it structurally (no cast).
 */
export interface AnthropicLike {
  messages: {
    stream(params: Anthropic.MessageStreamParams, options?: Anthropic.RequestOptions): AnthropicStreamLike;
  };
}

export function createAnthropicSdk(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, timeout: ANTHROPIC_TIMEOUT_MS, maxRetries: ANTHROPIC_MAX_RETRIES });
}

export class AnthropicAdapter implements LLMClient {
  readonly provider = 'anthropic' as const;
  private readonly sdk: AnthropicLike;

  constructor(opts: AnthropicAdapterOptions) {
    if (opts.apiKey === '' || opts.apiKey === undefined) {
      throw new LLMError('LLM_NO_API_KEY', 'Anthropic API key not configured.');
    }
    this.sdk = opts.client ?? createAnthropicSdk(opts.apiKey);
  }

  async call<T = unknown>(req: LlmCallRequest): Promise<LlmCallResult<T>> {
    req.onPhase?.({ phase: 'calling', message: 'Calling Anthropic…' });
    if (req.signal?.aborted) throw new LLMError('LLM_CANCELLED', 'Cancelled before request');

    const params = buildRequestParams(req);

    let response: Anthropic.Message;
    try {
      const stream = this.sdk.messages.stream(params, { signal: req.signal });
      let firstEventSeen = false;
      // Any first event (thinking deltas usually arrive before text/tool input)
      // flips the phase to "streaming".
      stream.on('streamEvent', () => {
        if (firstEventSeen) return;
        firstEventSeen = true;
        req.onPhase?.({ phase: 'streaming', message: 'Generating analysis…' });
      });
      response = await stream.finalMessage();
    } catch (err) {
      throw mapAnthropicError(err, req.signal);
    }

    req.onPhase?.({ phase: 'finalizing', message: 'Finalizing structured output…' });
    const model = response.model || req.model;

    // Order matters: check stop_reason before reading content.
    if (response.stop_reason === 'refusal') {
      const category = response.stop_details?.category ?? null;
      throw new LLMError(
        'LLM_REFUSAL',
        `Anthropic declined the request (stop_reason: refusal${category !== null ? `, category: ${category}` : ''}).`
      );
    }
    // A response cut off by `max_tokens` carries a truncated (or absent)
    // tool_use input — required fields silently go missing. Fail loudly so the
    // service takes its deterministic-partial path instead of caching junk.
    if (response.stop_reason === 'max_tokens') {
      throw new LLMError(
        'LLM_TRUNCATED',
        `Anthropic response truncated at max_tokens (${req.maxOutputTokens}); structured output incomplete.`
      );
    }

    const tool = response.content.find(
      (c): c is Anthropic.ToolUseBlock => c.type === 'tool_use' && c.name === req.tool.name
    );
    if (tool === undefined) {
      logTextAnswer(response, model);
      throw new LLMError('LLM_TOOL_USE_MISSING', 'Anthropic response did not include a tool_use block.');
    }
    if (typeof tool.input !== 'object' || tool.input === null) {
      throw new LLMError('LLM_TOOL_USE_INVALID', 'Anthropic tool_use entry malformed.');
    }

    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0
    };
    return {
      output: tool.input as T,
      ...usage,
      model,
      provider: 'anthropic',
      costEstimateUsd: costEstimateUsd(model, usage)
    };
  }
}

export function buildRequestParams(req: LlmCallRequest): Anthropic.MessageStreamParams {
  const tool: Anthropic.Tool = {
    ...translateTool(req.tool),
    // Last (only) tool definition carries the tools-prefix cache breakpoint.
    cache_control: { type: 'ephemeral' }
  };
  return {
    model: req.model,
    max_tokens: req.maxOutputTokens,
    system: [{ type: 'text', text: req.systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: req.userPrompt }],
    tools: [tool],
    tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    output_config: { effort: req.effort }
  };
}

export function translateTool(tool: ToolSchema): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    // Spread: JsonSchemaObject has no index signature; a fresh literal does.
    input_schema: { ...tool.inputSchema },
    strict: true
  };
}

function logTextAnswer(response: Anthropic.Message, model: string): void {
  const text = response.content
    .filter((c): c is Anthropic.TextBlock => c.type === 'text')
    .map((c) => c.text)
    .join(' ')
    .slice(0, TEXT_LOG_CHARS);
  void getLogger()
    .then((log) =>
      log.warn(
        { model, stopReason: response.stop_reason, textPreview: text },
        'Anthropic answered without calling the tool (tool_choice auto)'
      )
    )
    .catch(() => undefined);
}

/** Most specific first; SDK 1.x typed errors (verified in core/error.d.ts). */
export function mapAnthropicError(err: unknown, signal?: AbortSignal): LLMError {
  if (err instanceof LLMError) return err;
  if (err instanceof APIUserAbortError || signal?.aborted === true) {
    return new LLMError('LLM_CANCELLED', 'Cancelled');
  }
  const message = err instanceof Error ? err.message : 'Anthropic call failed';
  if (err instanceof AuthenticationError) return new LLMError('LLM_NO_API_KEY', message);
  if (err instanceof RateLimitError) return new LLMError('LLM_RATE_LIMIT', message, true);
  if (
    err instanceof APIConnectionTimeoutError ||
    err instanceof RequestTimeoutError ||
    err instanceof GatewayTimeoutError
  ) {
    return new LLMError('LLM_TIMEOUT', message, true);
  }
  if (err instanceof InternalServerError) return new LLMError('LLM_NETWORK', message, true);
  if (err instanceof BadRequestError) return new LLMError('LLM_BAD_REQUEST', message);
  if (err instanceof APIConnectionError) return new LLMError('LLM_NETWORK', message, true);
  if (err instanceof APIError && typeof err.status === 'number' && err.status >= 400 && err.status < 500) {
    // 403 / 404 (unknown model) / 413 / 422…: retrying the same request cannot help.
    return new LLMError('LLM_BAD_REQUEST', message);
  }
  // Fire-and-forget log — never block error mapping on logger init.
  void getLogger().then((log) => log.warn({ err }, 'Anthropic call failed')).catch(() => undefined);
  return new LLMError('LLM_NETWORK', message, true);
}
