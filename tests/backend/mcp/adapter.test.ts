/**
 * Stage 4b.1 / 4b.2: the MCP adapter maps the 4a read-only registry onto MCP
 * tools 1:1 (plus `list_projects`), adds a required `project` argument, marks
 * every tool read-only and never exposes terminal or write tools.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { Client } from '@modelcontextprotocol/client';
import { createReadToolRegistry, readToolDefs } from '@/core/agent/tools';
import { createToolRegistry, type ToolRegistry } from '@/core/agent/registry';
import { ToolRegistrationError, type AgentToolDef } from '@/core/agent/types';
import {
  createDepAgentMcpServer,
  mcpToolSpecs,
  LIST_PROJECTS_TOOL,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  NETWORK_TOOLS,
  type McpAdapterDeps
} from '@/mcp/tools';
import { LIBRARY_DIR_ENV, resolveMcpLibraryRoot } from '@/mcp/context';

const REPO = process.cwd();

const noDeps: McpAdapterDeps = {
  listProjects: async () => [],
  resolveProject: async () => null,
  openGraph: () => {
    throw new Error('not used');
  },
  intelFor: () => ({})
};

describe('MCP SDK install (4b.1 smoke)', () => {
  it('imports McpServer, the stdio transport and the client', () => {
    expect(typeof McpServer).toBe('function');
    expect(typeof StdioServerTransport).toBe('function');
    expect(typeof Client).toBe('function');
  });

  it('pins @modelcontextprotocol/server (dependency) and /client (devDependency) exactly at 2.4.0', async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(REPO, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.dependencies['@modelcontextprotocol/server']).toBe('2.4.0');
    expect(pkg.devDependencies['@modelcontextprotocol/client']).toBe('2.4.0');
    expect(pkg.dependencies['@modelcontextprotocol/client']).toBeUndefined();
    expect(MCP_SERVER_VERSION).toBe(pkg.version);
    expect(MCP_SERVER_NAME).toBe(pkg.name);
  });
});

describe('mcpToolSpecs (registry → MCP tool list)', () => {
  const registry = createReadToolRegistry();
  const specs = mcpToolSpecs(registry);
  const byName = new Map(specs.map((s) => [s.name, s]));

  it('exposes every registry tool plus list_projects, sorted by name', () => {
    const expected = [...registry.tools.map((t) => t.name), LIST_PROJECTS_TOOL].sort();
    expect(specs.map((s) => s.name)).toEqual(expected);
  });

  it('never exposes terminal, write or deferred tools', () => {
    for (const name of byName.keys()) {
      expect(name.startsWith('submit_')).toBe(false);
    }
    for (const deferred of ['add_project', 'build_graph', 'report_problem']) {
      expect(byName.has(deferred)).toBe(false);
    }
  });

  it('adds a required string `project` to every registry tool and keeps the rest of its schema', () => {
    for (const def of registry.tools) {
      const spec = byName.get(def.name)!;
      expect(spec.inputSchema.type).toBe('object');
      expect(spec.inputSchema.additionalProperties).toBe(false);
      expect(spec.inputSchema.properties.project).toMatchObject({ type: 'string' });
      expect(spec.inputSchema.required).toEqual(['project', ...(def.inputSchema.required ?? [])]);
      const { project: _project, ...rest } = spec.inputSchema.properties;
      expect(rest).toEqual(def.inputSchema.properties);
      expect(spec.description).toBe(def.description);
    }
  });

  it('list_projects takes no arguments', () => {
    const spec = byName.get(LIST_PROJECTS_TOOL)!;
    expect(spec.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
  });

  it('marks every tool read-only and non-destructive; only registry-fetching tools are open-world', () => {
    for (const spec of specs) {
      expect(spec.annotations.readOnlyHint).toBe(true);
      expect(spec.annotations.destructiveHint).toBe(false);
      expect(spec.annotations.openWorldHint).toBe(NETWORK_TOOLS.has(spec.name));
    }
    for (const name of NETWORK_TOOLS) expect(byName.has(name)).toBe(true);
  });
});

describe('read-only refusal', () => {
  const readDef = readToolDefs()[0]!;

  it('the registry the adapter is built on refuses write and execute tools', () => {
    for (const capability of ['write', 'execute'] as const) {
      expect(() => createToolRegistry([{ ...readDef, name: 'evil_tool', capability }])).toThrow(ToolRegistrationError);
    }
  });

  it('the adapter itself refuses a non-read tool even if a registry lets one through', () => {
    const writeTool: AgentToolDef = { ...readDef, name: 'write_file', capability: 'write' };
    const leaky: ToolRegistry = { tools: [writeTool], has: () => true, call: async () => ({ content: '', truncated: false, isError: false }) };
    expect(() => createDepAgentMcpServer(noDeps, leaky)).toThrow(/write_file.*read/);
  });

  it('refuses a tool that already declares a `project` property', () => {
    const clash: AgentToolDef = {
      ...readDef,
      name: 'clashing_tool',
      inputSchema: { type: 'object', properties: { project: { type: 'string' } }, additionalProperties: false }
    };
    expect(() => mcpToolSpecs(createToolRegistry([clash]))).toThrow(/project/);
  });
});

describe('resolveMcpLibraryRoot', () => {
  const serverFile = path.join(REPO, 'src', 'mcp', 'server.ts');

  it('defaults to <repo>/library (same folder the web app uses when started from the repo)', () => {
    expect(resolveMcpLibraryRoot({}, serverFile)).toBe(path.join(REPO, 'library'));
  });

  it(`uses ${LIBRARY_DIR_ENV} when it is an absolute path`, () => {
    const dir = path.join(REPO, 'some', 'library');
    expect(resolveMcpLibraryRoot({ [LIBRARY_DIR_ENV]: dir }, serverFile)).toBe(dir);
  });

  it(`rejects a relative ${LIBRARY_DIR_ENV}`, () => {
    expect(() => resolveMcpLibraryRoot({ [LIBRARY_DIR_ENV]: 'library' }, serverFile)).toThrow(/absolute/);
  });
});

describe('src/mcp import boundary', () => {
  it('uses relative imports only and no Next/React/app/UI/http modules (vite-node has no @/ alias)', async () => {
    const dir = path.join(REPO, 'src', 'mcp');
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = await fs.readFile(path.join(dir, f), 'utf8');
      const specs = [...text.matchAll(/^\s*(?:import|export)[^'"]*from\s+'([^']+)'/gm)].map((m) => m[1]!);
      for (const s of specs) {
        expect(s, `${f}: ${s}`).not.toMatch(/^@\//);
        expect(s, `${f}: ${s}`).not.toMatch(/^(next|react|react-dom)(\/|$)/);
        expect(s, `${f}: ${s}`).not.toMatch(/\/(app|components|lib\/client|lib\/http)(\/|$)/);
      }
    }
  });
});
