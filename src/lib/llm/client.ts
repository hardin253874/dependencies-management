/**
 * LLM Client interface (spec §10.2, §11.2).
 *
 * Internal abstraction over the official Anthropic + OpenAI SDKs. All Stage 3
 * call sites depend on this interface only; provider-specific adapters live in
 * `anthropic.ts` and `openai.ts`. The `MockLLMClient` short-circuits to fixture
 * responses when `MOCK_LLM=true` per spec §11.12.
 *
 * Tool-use is enforced: every call expects a single `ToolSchema` and the result
 * is the parsed tool-call input object. Free-text responses are NOT supported —
 * the spec requires structured JSON output for every view.
 *
 * Streaming phase events are forwarded via the `onPhase` callback so the SSE
 * bridge can surface status text. Partial tool-use JSON is NEVER emitted to
 * the client (spec §11.8).
 */

import type { LlmProvider } from '../api-types';

// ---------------------------------------------------------------------------
// Tool schema — provider-agnostic shape (spec §11.2)
// ---------------------------------------------------------------------------

/**
 * Provider-agnostic tool schema. Adapters translate this into:
 *   - Anthropic: `{ name, description, input_schema: jsonSchema }`
 *   - OpenAI: `{ type: 'function', function: { name, description, parameters } }`
 * The JSON Schema dialect used is a strict subset compatible with both
 * providers' tool-use payloads (object + properties + required + enum +
 * array.items + type, no $ref or oneOf).
 */
export interface ToolSchema {
  name: string;
  description: string;
  /**
   * A JSON-schema-compatible object describing the tool's expected input.
   * Must be `{ type: 'object', properties: {...}, required: [...] }` at the
   * top level. We don't generalize further — view tool schemas are written by
   * hand against this constraint.
   */
  inputSchema: JsonSchemaObject;
}

export type JsonSchemaScalarType = 'string' | 'integer' | 'number' | 'boolean';
export type JsonSchemaType = JsonSchemaScalarType | 'object' | 'array' | 'null';

export interface JsonSchemaObject {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: false;
  description?: string;
}

export type JsonSchemaProperty =
  | { type: JsonSchemaScalarType; description?: string; enum?: ReadonlyArray<string | number> }
  | { type: 'array'; items: JsonSchemaProperty | JsonSchemaObject; description?: string }
  | JsonSchemaObject;

// ---------------------------------------------------------------------------
// Call shape
// ---------------------------------------------------------------------------

export interface LlmCallRequest {
  /** Provider-specific model identifier, e.g. 'claude-3-5-sonnet-latest'. */
  model: string;
  /** Shared §11.1 system prompt prepended to whatever the caller adds. */
  systemPrompt: string;
  /** Rendered user prompt (already Mustache-substituted). */
  userPrompt: string;
  tool: ToolSchema;
  /** Forced max tokens for the model's output. */
  maxOutputTokens: number;
  /** Optional max input tokens cap; the adapter only uses this for telemetry. */
  maxInputTokens?: number;
  /** Abort signal for cancel support. */
  signal?: AbortSignal;
  /** Forwarded streaming-phase events. */
  onPhase?: (phase: LlmPhaseEvent) => void;
}

export type LlmPhaseName =
  | 'calling'            // initial SDK call dispatched
  | 'streaming'          // first token / event received
  | 'finalizing'         // tool_use stop / message_stop received
  | 'retry';             // a retryable error fired, retrying

export interface LlmPhaseEvent {
  phase: LlmPhaseName;
  /** Human-readable status string for the status bar. */
  message: string;
  attempt?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
}

export interface LlmCallResult<T = unknown> {
  /** Parsed tool input object — already validated to match `tool.inputSchema`. */
  output: T;
  /** Token usage (spec §11.11). */
  inputTokens: number;
  outputTokens: number;
  model: string;
  /** Provider name for the `source` field on persisted envelopes. */
  provider: LlmProvider;
  /** Computed at write time by the caller via `costFor`. */
  costEstimateUsd: number;
}

// ---------------------------------------------------------------------------
// Error codes (spec §9.5 envelope codes — surfaced over SSE on AI calls)
// ---------------------------------------------------------------------------

export type LlmErrorCode =
  | 'LLM_NO_API_KEY'
  | 'LLM_RATE_LIMIT'
  | 'LLM_TIMEOUT'
  | 'LLM_NETWORK'
  | 'LLM_INVALID_RESPONSE'
  | 'LLM_TOOL_USE_MISSING'
  | 'LLM_TOOL_USE_INVALID'
  | 'LLM_CANCELLED'
  | 'LLM_UNSUPPORTED_PROVIDER'
  | 'MOCK_LLM_NO_FIXTURE';

export class LLMError extends Error {
  readonly code: LlmErrorCode;
  readonly retryable: boolean;
  constructor(code: LlmErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'LLMError';
    this.code = code;
    this.retryable = retryable;
  }
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface LLMClient {
  /** Provider identity for logging + `source` field. */
  readonly provider: LlmProvider;
  /**
   * Run a tool-use-constrained call. Streams events through `onPhase`. Returns
   * the parsed tool input object on success; throws `LLMError` on any failure.
   */
  call<T = unknown>(req: LlmCallRequest): Promise<LlmCallResult<T>>;
}
