/**
 * Stage 4b.3 spawned check: the real entry point (`src/mcp/server.ts` under
 * vite-node, the same command as `npm run mcp` minus npm's stdout banner)
 * started by the SDK's `StdioClientTransport` on this OS. Proves stdout
 * carries only protocol frames, the library comes from DEP_AGENT_LIBRARY_DIR,
 * and the client's cwd is left untouched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { createSandbox, type Sandbox } from '../helpers/sandbox';
import { buildAgentFixture, type BuiltFixture } from '../helpers/agentFixture';
import { LIBRARY_DIR_ENV } from '@/mcp/context';
import { LIST_PROJECTS_TOOL } from '@/mcp/tools';

const REPO = process.cwd();

let sandbox: Sandbox;
let fx: BuiltFixture;

beforeAll(async () => {
  sandbox = await createSandbox('mcp-stdio');
  fx = await buildAgentFixture(sandbox, 'wrapper-module', { as: 'wrapper' });
  fx.graph.close();
  await fs.writeFile(path.join(sandbox.libraryRoot, 'wrapper', 'project.json'), JSON.stringify({ schemaVersion: 1, name: 'wrapper', path: fx.projectRoot }));
  await fs.writeFile(
    path.join(sandbox.libraryRoot, '_projects.json'),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ slug: 'wrapper', name: 'wrapper', absolutePath: fx.projectRoot, packageManager: 'npm', addedAt: '2026-11-10T00:00:00.000Z', workspacesDetected: false }]
    })
  );
}, 60_000);

afterAll(async () => {
  await sandbox.dispose();
});

describe('spawned stdio server', () => {
  it('lists tools and answers graph_summary with a clean stdout', async () => {
    const cwd = await sandbox.scratch('client-cwd');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO, 'node_modules', 'vite-node', 'dist', 'cli.mjs'), '--root', REPO, path.join(REPO, 'src', 'mcp', 'server.ts')],
      env: { ...getDefaultEnvironment(), [LIBRARY_DIR_ENV]: sandbox.libraryRoot },
      cwd,
      stderr: 'pipe'
    });
    let stderr = '';
    transport.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    const client = new Client({ name: 'stdio-test', version: '0.0.0' });
    // A non-JSON line on stdout surfaces here as a parse error from the transport.
    const errors: Error[] = [];
    client.onerror = (e) => errors.push(e);

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('graph_summary');
      expect(tools.map((t) => t.name)).toContain(LIST_PROJECTS_TOOL);

      const projects = await client.callTool({ name: LIST_PROJECTS_TOOL, arguments: {} });
      expect(JSON.stringify(projects.content)).toContain('wrapper');

      const r = await client.callTool({ name: 'graph_summary', arguments: { project: 'wrapper' } });
      const text = (r.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(r.isError, `${text}\n--- server stderr ---\n${stderr}`).toBeFalsy();
      expect(JSON.parse(text)).toEqual(expect.any(Object));
    } finally {
      await client.close();
    }

    expect(errors, stderr).toEqual([]);
    expect(await fs.readdir(cwd)).toEqual([]);
    // The call was logged to the sandbox library, not the repo's real library.
    expect(await fs.readFile(path.join(sandbox.libraryRoot, '_logs', 'server.log'), 'utf8')).toContain('"scope":"mcp"');
  }, 60_000);
});
