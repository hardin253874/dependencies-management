/**
 * MCP adapter over the read-only agent tools (V2_STAGE4_SPEC 4b.2,
 * V2_AI_OVER_GRAPH §5). Thin by design: every tool of the 4a registry is
 * served as-is (name, description, JSON Schema) plus a required `project`
 * slug, and one extra read-only `list_projects`. No terminal `submit_*` tools,
 * no graph build, no write or execute tools (D7).
 *
 * Imports are relative: `npm run mcp` runs under vite-node, which has no `@/`
 * alias (same rule as src/core, D23).
 */
import { McpServer, type CallToolResult, type StandardSchemaWithJSON, type ToolAnnotations } from '@modelcontextprotocol/server';
import { createReadToolRegistry } from '../core/agent/tools';
import { safeMessage, type ToolRegistry } from '../core/agent/registry';
import { validateInput } from '../core/agent/schema';
import { DEFAULT_TOOL_LIMITS, type AgentSchemaObject, type IntelContext, type ToolResult } from '../core/agent/types';
import { GraphNotBuiltError, type GraphDriver } from '../core/graph/store';

/** Kept equal to package.json `name` / `version` (adapter.test.ts). */
export const MCP_SERVER_NAME = 'dependencies-management-agent';
export const MCP_SERVER_VERSION = '0.1.0';

export const LIST_PROJECTS_TOOL = 'list_projects';

/** Tools that reach the npm registry (through the injected intel), so their results depend on the outside world. */
export const NETWORK_TOOLS: ReadonlySet<string> = new Set(['api_diff', 'peer_requirements']);

export const GRAPH_NOT_BUILT_MESSAGE = 'Graph not built — open the project in the web UI and refresh [C] Usage.';

const INSTRUCTIONS =
  'Read-only tools over the code graph of projects registered in the Dependencies Management Agent web UI. ' +
  `Call ${LIST_PROJECTS_TOOL} first; every other tool takes a \`project\` slug from it. ` +
  'Paths are relative to the project root. The server never writes to a project and never runs its code. ' +
  'Graphs are built in the web UI (refresh [C] Usage); this server does not build them.';

const PROJECT_PROPERTY = Object.freeze({
  type: 'string' as const,
  description: `Project slug, as returned by ${LIST_PROJECTS_TOOL}.`,
  maxLength: 200
});

const LIST_PROJECTS_SCHEMA: AgentSchemaObject = Object.freeze({ type: 'object', properties: {}, additionalProperties: false });

export interface McpProjectSummary {
  slug: string;
  name: string;
  path: string;
  graph: 'built' | 'not-built';
}

export interface McpProject {
  slug: string;
  /** Absolute path of the target project (read-only). */
  workspaceRoot: string;
  graphDbPath: string;
}

/** Everything app-specific the adapter needs; tests inject fakes (no network, sandbox library). */
export interface McpAdapterDeps {
  listProjects(): Promise<McpProjectSummary[]>;
  /** `null` when the slug is not registered. */
  resolveProject(slug: string): Promise<McpProject | null>;
  /** Throws `GraphNotBuiltError` when there is no completed build. */
  openGraph(dbPath: string): GraphDriver;
  intelFor(workspaceRoot: string): IntelContext;
  log?(entry: McpCallLog): void;
}

export interface McpCallLog {
  tool: string;
  project: string | null;
  durationMs: number;
  resultBytes: number;
  isError: boolean;
  truncated: boolean;
}

export interface McpToolSpec {
  name: string;
  description: string;
  inputSchema: AgentSchemaObject;
  annotations: ToolAnnotations;
}

function annotationsFor(name: string): ToolAnnotations {
  return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: NETWORK_TOOLS.has(name) };
}

/** The MCP tool list: every registry tool with a required `project`, plus `list_projects`, sorted by name. */
export function mcpToolSpecs(registry: ToolRegistry): McpToolSpec[] {
  const specs: McpToolSpec[] = registry.tools.map((def) => {
    // Defence in depth: the registry already refuses these (D7), but the MCP surface must never carry one.
    if (def.capability !== 'read') throw new Error(`MCP adapter: tool "${def.name}" has capability '${def.capability}', only 'read' may be exposed`);
    if ('project' in def.inputSchema.properties) throw new Error(`MCP adapter: tool "${def.name}" already declares a "project" property`);
    return {
      name: def.name,
      description: def.description,
      inputSchema: {
        ...def.inputSchema,
        properties: { project: { ...PROJECT_PROPERTY }, ...def.inputSchema.properties },
        required: ['project', ...(def.inputSchema.required ?? [])],
        additionalProperties: false
      },
      annotations: annotationsFor(def.name)
    };
  });
  specs.push({
    name: LIST_PROJECTS_TOOL,
    description: 'Lists the projects registered in the web UI: slug, name, absolute path, and whether their code graph is built.',
    inputSchema: LIST_PROJECTS_SCHEMA,
    annotations: annotationsFor(LIST_PROJECTS_TOOL)
  });
  return specs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Wraps our JSON Schema as a Standard Schema, the form `registerTool` takes.
 * We do not use the SDK's `fromJsonSchema` (AJV): validation then goes through
 * the same core validator the in-process agent loop uses, so both surfaces
 * accept and reject exactly the same inputs with the same messages.
 */
function standardSchemaOf(schema: AgentSchemaObject): StandardSchemaWithJSON<Record<string, unknown>> {
  const json = (): Record<string, unknown> => structuredClone(schema) as unknown as Record<string, unknown>;
  return {
    '~standard': {
      version: 1,
      vendor: 'dep-agent',
      validate: (value) => {
        const problem = validateInput(schema, value);
        return problem === null ? { value: value as Record<string, unknown> } : { issues: [{ message: problem }] };
      },
      jsonSchema: { input: json, output: json }
    }
  };
}

function toCallToolResult(result: ToolResult): CallToolResult {
  return { content: [{ type: 'text', text: result.content }], isError: result.isError };
}

function errorResult(message: string): ToolResult {
  return { content: message, truncated: false, isError: true };
}

async function callProjectTool(
  deps: McpAdapterDeps,
  registry: ToolRegistry,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<{ result: ToolResult; slug: string }> {
  const { project, ...input } = args;
  const slug = String(project);
  let workspaceRoot = '';
  try {
    const resolved = await deps.resolveProject(slug);
    if (resolved === null) return { slug, result: errorResult(`Unknown project ${JSON.stringify(slug)}. Call ${LIST_PROJECTS_TOOL} for the registered slugs.`) };
    workspaceRoot = resolved.workspaceRoot;
    let graph: GraphDriver;
    try {
      graph = deps.openGraph(resolved.graphDbPath);
    } catch (err) {
      if (err instanceof GraphNotBuiltError) return { slug, result: errorResult(GRAPH_NOT_BUILT_MESSAGE) };
      throw err;
    }
    try {
      const ctx = { workspaceRoot, graph, intel: deps.intelFor(workspaceRoot), limits: { ...DEFAULT_TOOL_LIMITS }, signal };
      return { slug, result: await registry.call(name, input, ctx) };
    } finally {
      graph.close();
    }
  } catch (err) {
    return { slug, result: errorResult(`${name} failed: ${safeMessage(err, workspaceRoot)}`) };
  }
}

async function callListProjects(deps: McpAdapterDeps): Promise<ToolResult> {
  try {
    const projects = await deps.listProjects();
    return { content: JSON.stringify({ projects }), truncated: false, isError: false };
  } catch (err) {
    return errorResult(`${LIST_PROJECTS_TOOL} failed: ${safeMessage(err, '')}`);
  }
}

/**
 * Builds the MCP server with every read-only tool registered. One instance per
 * connection; it holds no state beyond the registry (graph handles are opened
 * and closed per call).
 */
export function createDepAgentMcpServer(deps: McpAdapterDeps, registry: ToolRegistry = createReadToolRegistry()): McpServer {
  const specs = mcpToolSpecs(registry);
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

  for (const spec of specs) {
    server.registerTool(
      spec.name,
      { description: spec.description, inputSchema: standardSchemaOf(spec.inputSchema), annotations: spec.annotations },
      async (args, ctx) => {
        const started = Date.now();
        const { result, slug } =
          spec.name === LIST_PROJECTS_TOOL
            ? { result: await callListProjects(deps), slug: null }
            : await callProjectTool(deps, registry, spec.name, args, ctx.mcpReq.signal);
        deps.log?.({
          tool: spec.name,
          project: slug,
          durationMs: Date.now() - started,
          resultBytes: Buffer.byteLength(result.content, 'utf8'),
          isError: result.isError,
          truncated: result.truncated
        });
        return toCallToolResult(result);
      }
    );
  }
  return server;
}
