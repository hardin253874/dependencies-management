/**
 * Stage 4b.3: the MCP surface proven with a real client over the SDK's
 * in-memory transport, against a sandbox library holding one built fixture
 * graph (`wrapper`) and one registered project without a graph (`nograph`).
 * No network: the registry intel is a fake.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createSandbox, type Sandbox } from '../helpers/sandbox';
import { buildAgentFixture, type BuiltFixture } from '../helpers/agentFixture';
import { writeProjectFile } from '../helpers/graphFixture';
import { packageTgz } from '../helpers/tarball';
import { readToolDefs } from '@/core/agent/tools';
import type { IntelContext } from '@/core/agent/types';
import { appAdapterDeps } from '@/mcp/context';
import {
  createDepAgentMcpServer,
  GRAPH_NOT_BUILT_MESSAGE,
  LIST_PROJECTS_TOOL,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  type McpAdapterDeps,
  type McpCallLog
} from '@/mcp/tools';

let sandbox: Sandbox;
let fx: BuiltFixture;
let outsideFile: string;
let intel: IntelContext;
const logs: McpCallLog[] = [];
const open: Array<{ client: Client; close: () => Promise<void> }> = [];

/** One valid call per registry tool (mirrors tests/backend/agent/invariant.readonly-tools.test.ts). */
const CALLS: Record<string, Record<string, unknown>> = {
  graph_summary: {},
  files_using_package: { pkg: 'axios' },
  symbols_used: { pkg: 'axios' },
  usage_sites: { pkg: 'axios' },
  dependents: { file: 'src/lib/http.ts' },
  affected_entry_points: { pkg: 'axios' },
  tests_covering: { files: ['src/lib/http.ts'] },
  wrappers: { pkg: 'axios' },
  unresolved_imports: {},
  read_file: { path: 'src/lib/http.ts' },
  search_code: { query: 'axios' },
  api_diff: { pkg: 'axios', from: '1.0.0', to: '2.0.0' },
  peer_requirements: { pkg: 'axios', version: '2.0.0' }
};

function deps(): McpAdapterDeps {
  return { ...appAdapterDeps(), intelFor: () => intel, log: (e) => logs.push(e) };
}

async function connect(d: McpAdapterDeps = deps()): Promise<Client> {
  const server = createDepAgentMcpServer(d);
  const client = new Client({ name: 'protocol-test', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  open.push({ client, close: async () => { await client.close(); await server.close(); } });
  return client;
}

type CallResult = Awaited<ReturnType<Client['callTool']>>;

function textOf(r: CallResult): string {
  const block = (r.content as Array<{ type: string; text?: string }>)[0];
  expect(block?.type).toBe('text');
  return block!.text!;
}

function snapshot(root: string): Array<{ path: string; size: number; mtimeMs: number; sha256: string }> {
  const out: Array<{ path: string; size: number; mtimeMs: number; sha256: string }> = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else {
        const st = fs.statSync(full);
        out.push({ path: path.relative(root, full), size: st.size, mtimeMs: st.mtimeMs, sha256: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex') });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function isUnder(p: unknown, root: string): boolean {
  if (typeof p !== 'string' && !Buffer.isBuffer(p)) return false;
  const rel = path.relative(root.toLowerCase(), path.resolve(p.toString()).toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const isEnv = (p: unknown) => typeof p === 'string' && /(^|[\\/])\.env/.test(p);

async function registerProject(slug: string, projectRoot: string): Promise<void> {
  const dir = path.join(sandbox.libraryRoot, slug);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, 'project.json'), JSON.stringify({ schemaVersion: 1, name: slug, path: projectRoot }));
}

beforeAll(async () => {
  sandbox = await createSandbox('mcp-protocol');
  fx = await buildAgentFixture(sandbox, 'wrapper-module', {
    as: 'wrapper',
    prepare: async (root) => {
      await writeProjectFile(root, '.env', 'SENTINEL_ROOT_ENV=1\n');
      await writeProjectFile(root, 'src/.env.local', 'SENTINEL_NESTED_ENV=1\n');
    }
  });
  outsideFile = path.join(sandbox.scratchRoot, 'outside.txt');
  await fs.promises.writeFile(outsideFile, 'SENTINEL_OUTSIDE\n');
  const noGraphRoot = await sandbox.scratch('nograph');
  await registerProject('wrapper', fx.projectRoot);
  await registerProject('nograph', noGraphRoot);
  const entry = (slug: string, absolutePath: string) => ({ slug, name: slug, absolutePath, packageManager: 'npm', addedAt: '2026-11-10T00:00:00.000Z', workspacesDetected: false });
  await fs.promises.writeFile(
    path.join(sandbox.libraryRoot, '_projects.json'),
    JSON.stringify({ schemaVersion: 1, projects: [entry('wrapper', fx.projectRoot), entry('nograph', noGraphRoot)] })
  );
  const tgz = packageTgz({ 'package.json': JSON.stringify({ types: 'index.d.ts' }), 'index.d.ts': 'export declare const a: number;\n' });
  intel = {
    fetchPackument: async () => ({ versions: { '1.0.0': { dist: { tarball: 'u1' } }, '2.0.0': { dist: { tarball: 'u2' }, peerDependencies: { react: '*' } } } }),
    fetchTarball: async () => new Uint8Array(tgz),
    apiDiffCacheDir: path.join(sandbox.libraryRoot, '_apidiff')
  };
}, 60_000);

afterEach(async () => {
  vi.restoreAllMocks();
  while (open.length > 0) await open.pop()!.close();
  logs.length = 0;
});

afterAll(async () => {
  fx.graph.close();
  await sandbox.dispose();
});

describe('initialize', () => {
  it('returns the server info, the tools capability and the instructions', async () => {
    const client = await connect();
    expect(client.getServerVersion()).toMatchObject({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
    expect(client.getServerCapabilities()?.tools).toBeDefined();
    expect(client.getInstructions()).toContain(LIST_PROJECTS_TOOL);
  });
});

describe('tools/list', () => {
  it('lists exactly the read-only tools plus list_projects, all annotated read-only', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const expected = [...readToolDefs().map((t) => t.name), LIST_PROJECTS_TOOL].sort();
    expect(tools.map((t) => t.name)).toEqual(expected);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(t.annotations?.destructiveHint, t.name).toBe(false);
      expect(t.inputSchema.type).toBe('object');
      if (t.name !== LIST_PROJECTS_TOOL) expect(t.inputSchema.required, t.name).toContain('project');
    }
    const fup = tools.find((t) => t.name === 'files_using_package')!;
    expect(fup.inputSchema.properties).toHaveProperty('pkg');
    expect(fup.inputSchema.properties).toHaveProperty('limit');
  });
});

describe('tools/call', () => {
  it('list_projects reports both projects and whether their graph is built', async () => {
    const client = await connect();
    const r = await client.callTool({ name: LIST_PROJECTS_TOOL, arguments: {} });
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(textOf(r)) as { projects: Array<{ slug: string; graph: string; path: string }> };
    expect(body.projects.map((p) => [p.slug, p.graph])).toEqual([['wrapper', 'built'], ['nograph', 'not-built']]);
    expect(body.projects[0]!.path).toBe(fx.projectRoot);
  });

  it('graph_summary, files_using_package and read_file answer from the fixture graph', async () => {
    const client = await connect();

    const summary = await client.callTool({ name: 'graph_summary', arguments: { project: 'wrapper' } });
    expect(summary.isError, textOf(summary)).toBeFalsy();
    expect(JSON.parse(textOf(summary))).toEqual(expect.any(Object));

    const fup = await client.callTool({ name: 'files_using_package', arguments: { project: 'wrapper', pkg: 'axios' } });
    expect(fup.isError, textOf(fup)).toBeFalsy();
    const hits = JSON.parse(textOf(fup)) as { items: Array<{ path: string }>; total: number; nextOffset: number | null };
    expect(hits.total).toBeGreaterThan(0);
    expect(hits.items.map((i) => i.path)).toContain('src/lib/http.ts');
    for (const i of hits.items) expect(path.isAbsolute(i.path)).toBe(false);

    const file = await client.callTool({ name: 'read_file', arguments: { project: 'wrapper', path: 'src/lib/http.ts' } });
    expect(file.isError, textOf(file)).toBeFalsy();
    expect((JSON.parse(textOf(file)) as { text: string }).text).toContain('axios');

    expect(logs.map((l) => [l.tool, l.project, l.isError])).toEqual([
      ['graph_summary', 'wrapper', false],
      ['files_using_package', 'wrapper', false],
      ['read_file', 'wrapper', false]
    ]);
  });

  it('invalid input is a tool error result, not a protocol error', async () => {
    const client = await connect();
    const cases: Array<[string, Record<string, unknown>]> = [
      ['files_using_package', { project: 'wrapper', pkg: 42 }],
      ['files_using_package', { project: 'wrapper' }],
      ['files_using_package', { pkg: 'axios' }],
      ['files_using_package', { project: 'wrapper', pkg: 'axios', limit: 10_000 }],
      ['graph_summary', { project: 'wrapper', extra: true }],
      [LIST_PROJECTS_TOOL, { project: 'wrapper' }]
    ];
    for (const [name, args] of cases) {
      const r = await client.callTool({ name, arguments: args });
      expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(textOf(r)).toMatch(/invalid/i);
    }
  });

  it('an unknown tool, a terminal tool or a deferred write tool is a JSON-RPC Invalid Params error', async () => {
    const client = await connect();
    for (const name of ['no_such_tool', 'submit_update_report', 'submit_deep_report', 'build_graph', 'add_project']) {
      await expect(client.callTool({ name, arguments: { project: 'wrapper' } })).rejects.toMatchObject({ code: -32602 });
    }
  });

  it('an unknown project slug is a tool error, also for path-like slugs', async () => {
    const client = await connect();
    for (const project of ['nope', '../wrapper', 'wrapper/..', '']) {
      const r = await client.callTool({ name: 'graph_summary', arguments: { project } });
      expect(r.isError, project).toBe(true);
      expect(textOf(r)).toMatch(/Unknown project/);
    }
  });

  it('a project without a built graph is a tool error telling the user to refresh [C] Usage', async () => {
    const client = await connect();
    const r = await client.callTool({ name: 'graph_summary', arguments: { project: 'nograph' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(GRAPH_NOT_BUILT_MESSAGE);
  });
});

describe('read-only over MCP', () => {
  it('read_file refuses traversal, absolute paths and .env files, and never opens them', async () => {
    const client = await connect();
    const readSpies = [vi.spyOn(fs.promises, 'readFile'), vi.spyOn(fs, 'readFileSync'), vi.spyOn(fs.promises, 'open'), vi.spyOn(fs, 'openSync')];
    const attempts = ['../outside.txt', '..\\outside.txt', '%2e%2e/outside.txt', outsideFile, '.env', 'src/.env.local', './.env', 'src/../.env'];
    for (const p of attempts) {
      const r = await client.callTool({ name: 'read_file', arguments: { project: 'wrapper', path: p } });
      expect(r.isError, p).toBe(true);
      expect(textOf(r)).not.toMatch(/SENTINEL/);
    }
    const search = await client.callTool({ name: 'search_code', arguments: { project: 'wrapper', query: 'SENTINEL' } });
    expect(search.isError, textOf(search)).toBeFalsy();
    expect((JSON.parse(textOf(search)) as { matches: unknown[] }).matches).toEqual([]);
    for (const spy of readSpies) {
      expect(spy.mock.calls.filter((args) => isEnv(args[0]))).toEqual([]);
      expect(spy.mock.calls.filter((args) => typeof args[0] === 'string' && path.resolve(args[0]) === outsideFile)).toEqual([]);
    }
  });

  it('calling every tool over MCP leaves the project tree unchanged, writes nothing under it and spawns nothing', async () => {
    expect(Object.keys(CALLS).sort()).toEqual(readToolDefs().map((t) => t.name).sort());
    const client = await connect();
    const before = snapshot(fx.projectRoot);
    const writeSpies = [
      ...(['writeFile', 'appendFile', 'mkdir', 'rm', 'rmdir', 'unlink', 'rename', 'copyFile', 'cp', 'truncate', 'symlink'] as const).map((m) => vi.spyOn(fs.promises, m)),
      ...(['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'renameSync', 'copyFileSync', 'writeFile', 'createWriteStream'] as const).map((m) => vi.spyOn(fs, m))
    ];
    const openSpies = [vi.spyOn(fs.promises, 'open'), vi.spyOn(fs, 'openSync'), vi.spyOn(fs, 'open')];
    const procSpies = (['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const).map((m) => vi.spyOn(cp, m));

    for (const [name, args] of [...Object.entries(CALLS), [LIST_PROJECTS_TOOL, {}] as const]) {
      const r = await client.callTool({ name, arguments: name === LIST_PROJECTS_TOOL ? {} : { project: 'wrapper', ...args } });
      expect(r.isError, `${name}: ${textOf(r)}`).toBeFalsy();
    }

    for (const spy of [...writeSpies, ...openSpies]) {
      expect(spy.mock.calls.filter((args) => isUnder(args[0], fx.projectRoot) || isUnder(args[1], fx.projectRoot))).toEqual([]);
    }
    for (const spy of procSpies) expect(spy).not.toHaveBeenCalled();
    expect(snapshot(fx.projectRoot)).toEqual(before);
  });
});
