/**
 * Shared types of the read-only agent tool set (V2_STAGE4_SPEC §2, 4a.1).
 *
 * Tools are MCP-first: defined once here, served in-process to the agent loop
 * (`loop.ts`) and over stdio by the Stage 4b MCP adapter. Every tool takes
 * `workspaceRoot` through its context and never reads `project.path` itself
 * (design §8 seam), so L3 can point the same tools at a disposable worktree.
 */
import type { GraphDriver } from '../graph/store';

/** Design §8 seam: v2 registers only `read`; `write`/`execute` exist so L3 can add an approval gate. */
export type ToolCapability = 'read' | 'write' | 'execute';

export type AgentSchemaScalarType = 'string' | 'integer' | 'number' | 'boolean';

/**
 * The JSON Schema subset of `lib/llm/client.ts` (`JsonSchemaObject`) plus the
 * numeric/array bounds the registry validates locally. Those bounds are NOT
 * sent to the API (see `toAnthropicTools`): strict tool schemas accept only a
 * subset of JSON Schema, and a local check is enough for our own handlers.
 */
export interface AgentSchemaScalar {
  type: AgentSchemaScalarType;
  description?: string;
  enum?: ReadonlyArray<string | number>;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
}

export interface AgentSchemaArray {
  type: 'array';
  items: AgentSchemaProperty;
  description?: string;
  maxItems?: number;
}

export interface AgentSchemaObject {
  type: 'object';
  properties: Record<string, AgentSchemaProperty>;
  required?: string[];
  additionalProperties?: false;
  description?: string;
}

export type AgentSchemaProperty = AgentSchemaScalar | AgentSchemaArray | AgentSchemaObject;

export interface ToolResult {
  /** JSON text (or a plain error message when `isError`). */
  content: string;
  truncated: boolean;
  isError: boolean;
}

export interface ToolLimits {
  /** Hard cap on one tool result, in UTF-8 bytes (default 16 KB). */
  maxResultBytes: number;
}

export interface PackumentVersionLike {
  version?: string;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  types?: string;
  typings?: string;
  exports?: unknown;
  dist?: { tarball?: string };
}

export interface PackumentLike {
  name?: string;
  versions?: Record<string, PackumentVersionLike>;
}

/**
 * Dependency-intelligence services a tool may use. All network access is
 * injected so tests use fakes and the core never picks a registry client.
 * Every implementation must apply its own timeout (CLAUDE.md "always set a timeout").
 */
export interface IntelContext {
  fetchPackument?: (name: string, signal?: AbortSignal) => Promise<PackumentLike>;
  fetchTarball?: (url: string, signal?: AbortSignal) => Promise<Uint8Array>;
  /** Directory for `api_diff` caches + extracted type files. Never inside `workspaceRoot`. */
  apiDiffCacheDir?: string;
}

export interface ToolContext {
  /** Absolute path of the target project (read-only). */
  workspaceRoot: string;
  graph: GraphDriver;
  intel: IntelContext;
  limits: ToolLimits;
  signal?: AbortSignal;
}

/** A tool handler either returns a JSON-serialisable value or throws `ToolError` for an `isError` result. */
export interface AgentToolDef {
  name: string;
  description: string;
  inputSchema: AgentSchemaObject;
  capability: ToolCapability;
  /** Per-tool result cap overriding `ctx.limits.maxResultBytes` (read_file returns up to 32 KB of text plus JSON escaping). */
  maxResultBytes?: number;
  handler(ctx: ToolContext, input: Record<string, unknown>): unknown;
}

/**
 * Agent-only terminal tool (`submit_update_report`, `submit_deep_report`). Its
 * input IS the run's output; it is never executed and never registered with MCP.
 */
export interface TerminalToolDef {
  name: string;
  description: string;
  inputSchema: AgentSchemaObject;
}

/** A failure the model should see as an `is_error` tool result (safe message, no stack, no absolute paths). */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export class ToolRegistrationError extends Error {
  readonly toolName: string;
  constructor(toolName: string, message: string) {
    super(`Tool "${toolName}": ${message}`);
    this.name = 'ToolRegistrationError';
    this.toolName = toolName;
  }
}

export const DEFAULT_TOOL_LIMITS: Readonly<ToolLimits> = Object.freeze({ maxResultBytes: 16 * 1024 });
