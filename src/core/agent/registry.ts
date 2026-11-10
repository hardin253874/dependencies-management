/**
 * Tool registry + capability guard (V2_STAGE4_SPEC 4a.1, design §8).
 *
 * The single place tools are defined. Registration refuses anything that is
 * not `capability: 'read'` (the L3 seam: write/execute tools need an approval
 * gate that v2 does not have), duplicate or non-snake_case names, and schemas
 * outside the strict subset. `call` validates the raw model input, runs the
 * handler and turns every failure into an `isError` result with a safe
 * message, then caps the result size.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { apiSchemaOf, checkSchemaDef, validateInput } from './schema';
import { ToolError, ToolRegistrationError, type AgentToolDef, type TerminalToolDef, type ToolContext, type ToolResult } from './types';

const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

export const TRUNCATION_MARKER = '\n[TRUNCATED — tool result exceeded the size cap. Narrow the query (limit/offset, path_prefix, line range).]';

export interface ToolRegistry {
  /** Sorted by name (stable cache prefix). */
  readonly tools: readonly AgentToolDef[];
  has(name: string): boolean;
  call(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export function createToolRegistry(defs: readonly AgentToolDef[]): ToolRegistry {
  const byName = new Map<string, AgentToolDef>();
  for (const def of defs) {
    const name = typeof def?.name === 'string' ? def.name : '<unnamed>';
    if (!NAME_RE.test(name)) throw new ToolRegistrationError(name, 'name must be snake_case');
    if (byName.has(name)) throw new ToolRegistrationError(name, 'duplicate name');
    // v2 is L2 (report-only, D7): only read tools may exist.
    if (def.capability !== 'read') throw new ToolRegistrationError(name, `capability must be 'read' (got '${String(def.capability)}')`);
    if (typeof def.handler !== 'function') throw new ToolRegistrationError(name, 'handler missing');
    if (typeof def.description !== 'string' || def.description.trim() === '') throw new ToolRegistrationError(name, 'description missing');
    const problem = checkSchemaDef(def.inputSchema);
    if (problem !== null) throw new ToolRegistrationError(name, problem);
    byName.set(name, def);
  }
  const tools = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return {
    tools,
    has: (name) => byName.has(name),
    async call(name, rawInput, ctx) {
      const def = byName.get(name);
      if (def === undefined) return errorResult(`Unknown tool "${String(name)}".`);
      const problem = validateInput(def.inputSchema, rawInput);
      if (problem !== null) return errorResult(`Invalid input for ${name}: ${problem}`);
      let value: unknown;
      try {
        value = await def.handler(ctx, rawInput as Record<string, unknown>);
      } catch (err) {
        return errorResult(`${name} failed: ${safeMessage(err, ctx.workspaceRoot)}`);
      }
      const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
      return { ...truncateToolResult(text, def.maxResultBytes ?? ctx.limits.maxResultBytes), isError: false };
    }
  };
}

/** Validates terminal tool schemas the same way (they reach the API with `strict: true`). */
export function checkTerminalTools(defs: readonly TerminalToolDef[]): void {
  for (const def of defs) {
    if (!NAME_RE.test(def.name)) throw new ToolRegistrationError(def.name, 'name must be snake_case');
    const problem = checkSchemaDef(def.inputSchema);
    if (problem !== null) throw new ToolRegistrationError(def.name, problem);
  }
}

/** Caps `text` at `maxBytes` UTF-8 bytes including the marker; never splits a code point. */
export function truncateToolResult(text: string, maxBytes: number): { content: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { content: text, truncated: false };
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
  const budget = Math.max(0, maxBytes - markerBytes);
  const buf = Buffer.from(text, 'utf8');
  let end = Math.min(budget, buf.length);
  // Back off continuation bytes (10xxxxxx) so the cut lands on a code point boundary.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return { content: buf.subarray(0, end).toString('utf8') + TRUNCATION_MARKER, truncated: true };
}

/**
 * API tool list: read tools sorted by name, then terminal tools in the given order (stable cached prefix).
 *
 * Only the terminal (`submit_*`) tools are `strict`. The API caps strict
 * schemas per REQUEST (structured-outputs docs: ≤ 24 optional parameters, ≤ 20
 * strict tools, ≤ 16 union-typed parameters, summed over all strict schemas);
 * the read tools alone have 29 optional parameters, which the real API
 * rejected with a 400 in Stage 4c. The docs' first remedy is "mark only
 * critical tools as strict". The read tools lose nothing: `call()` validates
 * every input against the same schema before a handler runs and returns an
 * error result the model can correct.
 */
export function toAnthropicTools(registry: ToolRegistry, terminal: readonly TerminalToolDef[]): Anthropic.Tool[] {
  const map =
    (strict: boolean) =>
    (t: { name: string; description: string; inputSchema: AgentToolDef['inputSchema'] }): Anthropic.Tool => ({
      name: t.name,
      description: t.description,
      input_schema: { ...apiSchemaOf(t.inputSchema), type: 'object' },
      ...(strict ? { strict: true } : {})
    });
  return [...registry.tools.map(map(false)), ...terminal.map(map(true))];
}

function errorResult(message: string): ToolResult {
  return { content: message, truncated: false, isError: true };
}

/**
 * Message only (never the stack), with the workspace root made relative and
 * any other absolute path redacted, so a tool error cannot leak where things
 * live on the machine.
 */
export function safeMessage(err: unknown, workspaceRoot: string): string {
  let msg = err instanceof Error ? err.message : String(err);
  if (!(err instanceof ToolError) && !(err instanceof Error)) msg = 'unexpected error';
  for (const root of [workspaceRoot, workspaceRoot.replace(/\\/g, '/')]) {
    if (root !== '') msg = msg.split(root).join('.');
  }
  return msg
    .replace(/\\\\[?.]\\[^\s'"`]*/g, '<path>')
    .replace(/\\\\[^\s'"`]+/g, '<path>')
    .replace(/[A-Za-z]:[\\/][^\s'"`]*/g, '<path>')
    .replace(/(^|[\s'"`(])\/(?:[^\s'"`/]+\/)+[^\s'"`]*/g, '$1<path>')
    .slice(0, 500);
}
