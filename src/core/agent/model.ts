/**
 * Agent model seam (V2_STAGE4_SPEC 4a.6): the one multi-turn request
 * interface the loop depends on. Implementations: `AnthropicAgentModel`
 * (`src/lib/llm/agentAnthropic.ts`, real SDK) and `ScriptedAgentModel` (tests,
 * `MOCK_LLM`, eval `--mock-script`). Uses the SDK's own types, no redefinitions.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { LLMError, type LlmErrorCode } from '../../lib/llm/client';
import type { LlmEffort } from '../../lib/llm/effort';
import type { TokenUsage } from '../../lib/llm/cost';

export interface AgentTurnRequest {
  model: string;
  /** Stable bytes (cache prefix). */
  system: string;
  tools: Anthropic.Tool[];
  /** Append-only history; the model must not mutate it. */
  messages: Anthropic.MessageParam[];
  maxTokens: number;
  effort: LlmEffort;
  signal?: AbortSignal;
}

export interface AgentTurnResponse {
  content: Anthropic.ContentBlock[];
  stopReason: Anthropic.StopReason | null;
  /** API-reported usage with null cache fields mapped to 0. */
  usage: Required<TokenUsage>;
  model: string;
}

export interface AgentModel {
  turn(req: AgentTurnRequest): Promise<AgentTurnResponse>;
}

// ---------------------------------------------------------------- scripted model

/** One scripted turn in JSON-friendly form (fixtures under `test-fixtures/agent/`). */
export interface ScriptedTurn {
  content: ScriptedBlock[];
  stopReason?: Anthropic.StopReason;
  usage?: Partial<Required<TokenUsage>>;
}

export type ScriptedBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'tool_use'; id?: string; name: string; input: unknown };

export interface ScriptedError {
  error: { code: LlmErrorCode; message: string };
}

export type ScriptStep =
  | ScriptedTurn
  | ScriptedError
  | ((req: AgentTurnRequest, index: number) => Promise<AgentTurnResponse | ScriptedTurn> | AgentTurnResponse | ScriptedTurn);

export interface AgentScriptFile {
  /** Scenario id; the file name is `<scenario>.json`. */
  scenario: string;
  description?: string;
  turns: Array<ScriptedTurn | ScriptedError>;
}

export const SCRIPT_DEFAULT_USAGE: Readonly<Required<TokenUsage>> = Object.freeze({
  inputTokens: 1_000,
  outputTokens: 200,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0
});

export function toContentBlocks(blocks: readonly ScriptedBlock[], turnIndex: number): Anthropic.ContentBlock[] {
  return blocks.map((b, i): Anthropic.ContentBlock => {
    switch (b.type) {
      case 'text':
        return { type: 'text', text: b.text, citations: null };
      case 'thinking':
        return { type: 'thinking', thinking: b.thinking, signature: b.signature };
      case 'tool_use':
        return { type: 'tool_use', id: b.id ?? `toolu_t${turnIndex}_${i}`, name: b.name, input: b.input, caller: { type: 'direct' } };
      default: {
        const unknown: never = b;
        throw new Error(`unknown scripted block ${JSON.stringify(unknown)}`);
      }
    }
  });
}

function isAgentTurnResponse(v: AgentTurnResponse | ScriptedTurn): v is AgentTurnResponse {
  return 'model' in v && typeof (v as AgentTurnResponse).model === 'string';
}

function deepCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Returns the scripted turns in order and records every request it received
 * (a deep copy, so later history appends cannot rewrite what a test inspects).
 * Running past the end of the script is a clear error, never a silent default.
 */
export class ScriptedAgentModel implements AgentModel {
  readonly requests: AgentTurnRequest[] = [];
  private index = 0;
  constructor(private readonly script: readonly ScriptStep[]) {}

  get remaining(): number {
    return this.script.length - this.index;
  }

  async turn(req: AgentTurnRequest): Promise<AgentTurnResponse> {
    if (req.signal?.aborted === true) throw new LLMError('LLM_CANCELLED', 'Cancelled before request');
    const i = this.index;
    const step = this.script[i];
    this.requests.push({ ...deepCopy({ ...req, signal: undefined }), signal: req.signal });
    if (step === undefined) {
      throw new LLMError('MOCK_LLM_NO_FIXTURE', `ScriptedAgentModel: script exhausted after ${this.script.length} turn(s) (request #${i + 1}).`);
    }
    this.index += 1;
    if (typeof step === 'function') {
      const out = await step(req, i);
      return isAgentTurnResponse(out) ? out : this.fromScripted(out, req, i);
    }
    if ('error' in step) throw new LLMError(step.error.code, step.error.message);
    return this.fromScripted(step, req, i);
  }

  private fromScripted(step: ScriptedTurn, req: AgentTurnRequest, i: number): AgentTurnResponse {
    const content = toContentBlocks(step.content, i);
    const stopReason = step.stopReason ?? (content.some((c) => c.type === 'tool_use') ? 'tool_use' : 'end_turn');
    return { content, stopReason, usage: { ...SCRIPT_DEFAULT_USAGE, ...step.usage }, model: req.model };
  }
}
