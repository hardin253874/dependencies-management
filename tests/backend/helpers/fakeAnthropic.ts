/**
 * SDK-shaped fakes for the Anthropic adapter (no network). Messages and
 * stream events use `@anthropic-ai/sdk` 1.x types so a shape drift in the SDK
 * breaks typecheck here, not silently in production.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { AnthropicLike, AnthropicStreamLike } from '@/lib/llm/anthropic';

export function makeUsage(over: Partial<Anthropic.Usage> = {}): Anthropic.Usage {
  return {
    cache_creation: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    inference_geo: null,
    input_tokens: 10,
    output_tokens: 5,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: 'standard',
    speed: null,
    ...over
  };
}

export function toolUseBlock(name: string, input: unknown): Anthropic.ToolUseBlock {
  return { type: 'tool_use', id: 'toolu_1', name, input, caller: { type: 'direct' } };
}

export function textBlock(text: string): Anthropic.TextBlock {
  return { type: 'text', text, citations: null };
}

export function makeMessage(over: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    container: null,
    diagnostics: null,
    stop_reason: 'tool_use',
    stop_sequence: null,
    stop_details: null,
    content: [],
    usage: makeUsage(),
    ...over
  };
}

export interface FakeSdkCall {
  params: Anthropic.MessageStreamParams;
  options: Anthropic.RequestOptions | undefined;
}

/**
 * A fake `messages.stream`. `respond` returns the final message or throws;
 * it receives the request options so abort tests can wait on the signal.
 */
export function fakeSdk(
  respond: (call: FakeSdkCall) => Promise<Anthropic.Message> | Anthropic.Message
): { sdk: AnthropicLike; calls: FakeSdkCall[] } {
  const calls: FakeSdkCall[] = [];
  const sdk: AnthropicLike = {
    messages: {
      stream(params, options): AnthropicStreamLike {
        const call = { params, options };
        calls.push(call);
        const listeners: Array<(e: Anthropic.MessageStreamEvent) => void> = [];
        return {
          on(_event, listener) {
            listeners.push(listener);
            return this;
          },
          async finalMessage() {
            const start: Anthropic.MessageStreamEvent = {
              type: 'message_start',
              message: makeMessage({ content: [] })
            };
            for (const l of listeners) l(start);
            return respond(call);
          }
        };
      }
    }
  };
  return { sdk, calls };
}
