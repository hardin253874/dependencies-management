/**
 * Anthropic implementation of the agent model seam (V2_STAGE4_SPEC 4a.6),
 * `@anthropic-ai/sdk` 1.6.0 (types checked in resources/messages/messages.d.ts).
 *
 * Request shape, one turn of the agent loop:
 * - `tool_choice: { type: 'auto' }`, parallel tool use allowed. Forced tool
 *   choice (`any` / `tool`) is a 400 on current models; the loop nudges instead.
 * - Tools arrive from `toAnthropicTools`: only the terminal `submit_*` tool is
 *   `strict` (the API allows ≤ 24 optional params across all strict schemas of
 *   a request; the read tools have 29 and are validated by the registry).
 * - `output_config.effort` always set; no `thinking` param (same rule as the
 *   v1 adapter: omitted → adaptive on the picker models; the SDK doc says the
 *   omitted behaviour "depends on the model", and disabled/fixed budgets are
 *   400s on current models).
 * - Cache breakpoints (≤ 4): the last tool, the system block, and a rolling
 *   breakpoint on the last content block of the last user message. The
 *   history itself is never mutated — the breakpoint goes on a copy — so the
 *   loop's append-only history stays byte-identical (thinking blocks included).
 * - `stop_reason: refusal` → `LLM_REFUSAL`, `model_context_window_exceeded` →
 *   `LLM_TRUNCATED`. `max_tokens` is returned to the loop, which decides.
 * - `maxRetries` is a constructor option: 4c passes 0 so the spend gate sees
 *   every attempt.
 */
import Anthropic from '@anthropic-ai/sdk';
import { LLMError } from './client';
import { ANTHROPIC_MAX_RETRIES, ANTHROPIC_TIMEOUT_MS, mapAnthropicError, type AnthropicLike } from './anthropic';
import type { AgentModel, AgentTurnRequest, AgentTurnResponse } from '../../core/agent/model';

export interface AnthropicAgentModelOptions {
  apiKey: string;
  /** Test seam: a fake SDK client. */
  client?: AnthropicLike;
  maxRetries?: number;
}

const EPHEMERAL = { type: 'ephemeral' } as const;

export class AnthropicAgentModel implements AgentModel {
  private readonly sdk: AnthropicLike;

  constructor(opts: AnthropicAgentModelOptions) {
    if (opts.apiKey === '' || opts.apiKey === undefined) throw new LLMError('LLM_NO_API_KEY', 'Anthropic API key not configured.');
    this.sdk =
      opts.client ??
      new Anthropic({ apiKey: opts.apiKey, timeout: ANTHROPIC_TIMEOUT_MS, maxRetries: opts.maxRetries ?? ANTHROPIC_MAX_RETRIES });
  }

  async turn(req: AgentTurnRequest): Promise<AgentTurnResponse> {
    if (req.signal?.aborted === true) throw new LLMError('LLM_CANCELLED', 'Cancelled before request');
    let msg: Anthropic.Message;
    try {
      msg = await this.sdk.messages.stream(buildAgentRequestParams(req), { signal: req.signal }).finalMessage();
    } catch (err) {
      throw mapAnthropicError(err, req.signal);
    }
    const model = msg.model || req.model;
    if (msg.stop_reason === 'refusal') {
      const category = msg.stop_details?.category ?? null;
      throw new LLMError('LLM_REFUSAL', `Anthropic declined the request (stop_reason: refusal${category !== null ? `, category: ${category}` : ''}).`);
    }
    if (msg.stop_reason === 'model_context_window_exceeded') {
      throw new LLMError('LLM_TRUNCATED', `Anthropic stopped at the model's context window (model_context_window_exceeded) for ${model}.`);
    }
    return {
      content: msg.content,
      stopReason: msg.stop_reason,
      usage: {
        inputTokens: msg.usage.input_tokens,
        outputTokens: msg.usage.output_tokens,
        cacheReadInputTokens: msg.usage.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: msg.usage.cache_creation_input_tokens ?? 0
      },
      model
    };
  }
}

export function buildAgentRequestParams(req: AgentTurnRequest): Anthropic.MessageStreamParams {
  const lastTool = req.tools.length - 1;
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    system: [{ type: 'text', text: req.system, cache_control: EPHEMERAL }],
    tools: req.tools.map((t, i) => (i === lastTool ? { ...t, cache_control: EPHEMERAL } : t)),
    tool_choice: { type: 'auto' },
    messages: withRollingBreakpoint(req.messages),
    output_config: { effort: req.effort }
  };
}

/** Copy of `messages` with a cache breakpoint on the last block of the last user message. */
export function withRollingBreakpoint(messages: readonly Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const m = out[i]!;
    if (m.role !== 'user') continue;
    const blocks: Anthropic.ContentBlockParam[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : [...m.content];
    const last = blocks[blocks.length - 1];
    if (last === undefined) return out;
    blocks[blocks.length - 1] = { ...last, cache_control: EPHEMERAL } as Anthropic.ContentBlockParam;
    out[i] = { role: 'user', content: blocks };
    return out;
  }
  return out;
}
