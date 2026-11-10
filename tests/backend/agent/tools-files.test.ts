import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createSandbox, type Sandbox } from '../helpers/sandbox';
import { buildAgentFixture, type BuiltFixture } from '../helpers/agentFixture';
import { writeProjectFile } from '../helpers/graphFixture';
import { createToolRegistry, type ToolRegistry } from '@/core/agent/registry';
import { fileTools, READ_FILE_MAX_LINES } from '@/core/agent/tools/files';
import { normalizeRelPath, pathGuard } from '@/core/agent/pathGuard';

let sandbox: Sandbox;
let reg: ToolRegistry;
let fx: BuiltFixture;
let outsideFile: string;

beforeAll(async () => {
  sandbox = await createSandbox('agent-tools-files');
  reg = createToolRegistry(fileTools());
  fx = await buildAgentFixture(sandbox, 'wrapper-module', {
    prepare: async (root) => {
      await writeProjectFile(root, '.env', 'SENTINEL_SECRET=1\n');
      await writeProjectFile(root, 'sub/.env.local', 'SENTINEL_SECRET=2\n');
      const long = Array.from({ length: 1000 }, (_, i) => `export const v${i} = ${i}; // needle-${i % 7 === 0 ? 'seven' : 'x'}`).join('\n');
      await writeProjectFile(root, 'src/long.ts', long + '\n');
      await writeProjectFile(root, 'src/bin.ts', Buffer.from([0x65, 0x00, 0x66]));
    }
  });
  outsideFile = path.join(sandbox.scratchRoot, 'outside.txt');
  fs.writeFileSync(outsideFile, 'outside');
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  fx.graph.close();
  await sandbox.dispose();
});

function isEnvArg(a: unknown): boolean {
  return typeof a === 'string' && /(^|[\\/])\.env/.test(a);
}

describe('path guard (4a.3)', () => {
  it.each([
    ['../x'],
    ['src/../../x'],
    ['C:\\Windows\\win.ini'],
    ['c:/Windows/win.ini'],
    ['\\\\?\\C:\\Windows\\win.ini'],
    ['\\\\server\\share\\x'],
    ['/etc/passwd'],
    ['%2e%2e/x'],
    ['src/%2e%2e/%2e%2e/x'],
    ['.env'],
    ['sub/.env.local'],
    ['./.env'],
    ['src\0.ts'],
    ['src/lib/http.ts::$DATA'],
    ['src/lib/http.ts.'],
    ['node_modules/axios/index.js'],
    ['']
  ])('read_file refuses %j and never opens a .env path', async (p) => {
    const readSpy = vi.spyOn(fs.promises, 'readFile');
    const realSpy = vi.spyOn(fs.promises, 'realpath');
    const r = await reg.call('read_file', { path: p }, fx.ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/path refused|not a source file|Invalid input/);
    for (const spy of [readSpy, realSpy]) expect(spy.mock.calls.filter((a) => isEnvArg(a[0]))).toEqual([]);
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('normalizes ./ and backslashes', () => {
    expect(normalizeRelPath('./src\\lib/http.ts')).toBe('src/lib/http.ts');
  });

  it('refuses a symlink / junction that resolves outside the root', async () => {
    const link = path.join(fx.projectRoot, 'src', 'escape');
    fs.symlinkSync(path.dirname(outsideFile), link, 'junction');
    try {
      const allowed = new Map([['src/escape/outside.txt', true]]);
      await expect(pathGuard(fx.projectRoot, 'src/escape/outside.txt', allowed)).rejects.toThrow(/outside the project root/);
    } finally {
      fs.rmSync(link, { recursive: false, force: true });
    }
  });
});

describe('read_file (4a.3)', () => {
  it('reads a numbered range of a graph file', async () => {
    const r = await reg.call('read_file', { path: 'src/lib/http.ts', start_line: 3, end_line: 4 }, fx.ctx());
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.content)).toEqual({
      path: 'src/lib/http.ts',
      startLine: 3,
      endLine: 4,
      totalLines: 4,
      text: '3| export const get = (url: string) => axios.get(url);\n4| export const post = (url: string, body: unknown) => axios.post(url, body);'
    });
  });

  it('caps a call at 400 lines and points at the continuation', async () => {
    const r = JSON.parse((await reg.call('read_file', { path: 'src/long.ts' }, fx.ctx())).content);
    expect(r.endLine).toBe(READ_FILE_MAX_LINES);
    expect(r.totalLines).toBe(1000);
    expect(r.more).toBe('continue with start_line 401');
    expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThanOrEqual(32 * 1024);
  });

  it('reads package.json, refuses binary files and ranges past the end', async () => {
    expect((await reg.call('read_file', { path: 'package.json' }, fx.ctx())).isError).toBe(false);
    expect((await reg.call('read_file', { path: 'src/bin.ts' }, fx.ctx())).content).toMatch(/binary file/);
    expect((await reg.call('read_file', { path: 'src/lib/http.ts', start_line: 99 }, fx.ctx())).content).toMatch(/past the end/);
  });
});

describe('search_code (4a.3)', () => {
  it('finds a literal string, case-insensitive by default', async () => {
    const r = JSON.parse((await reg.call('search_code', { query: 'AXIOS.POST' }, fx.ctx())).content);
    expect(r.matches).toEqual([
      { path: 'src/lib/http.ts', line: 4, snippet: 'export const post = (url: string, body: unknown) => axios.post(url, body);' }
    ]);
    const cs = JSON.parse((await reg.call('search_code', { query: 'AXIOS.POST', case_sensitive: true }, fx.ctx())).content);
    expect(cs.matches).toEqual([]);
  });

  it('treats regex metacharacters literally and respects the limit cap', async () => {
    const lit = JSON.parse((await reg.call('search_code', { query: '(url' }, fx.ctx())).content);
    expect(lit.matches.length).toBeGreaterThan(0);
    const capped = JSON.parse((await reg.call('search_code', { query: 'needle-seven', limit: 5 }, fx.ctx())).content);
    expect(capped.matches).toHaveLength(5);
    expect(capped.capped).toBe(true);
    expect((await reg.call('search_code', { query: 'x', limit: 201 }, fx.ctx())).isError).toBe(true);
  });

  it('path_prefix narrows; .env files are never listed or opened', async () => {
    const readSpy = vi.spyOn(fs.promises, 'readFile');
    const r = JSON.parse((await reg.call('search_code', { query: 'SENTINEL_SECRET' }, fx.ctx())).content);
    expect(r.matches).toEqual([]);
    expect(readSpy.mock.calls.filter((a) => isEnvArg(a[0]))).toEqual([]);
    expect(readSpy).toHaveBeenCalled();
    const scoped = JSON.parse((await reg.call('search_code', { query: 'get', path_prefix: 'src/features/' }, fx.ctx())).content);
    expect(scoped.matches.every((m: { path: string }) => m.path.startsWith('src/features/'))).toBe(true);
  });

  it('stops on abort', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await reg.call('search_code', { query: 'export' }, fx.ctx({ signal: ac.signal }));
    expect(r).toMatchObject({ isError: true, content: 'search_code failed: cancelled' });
  });
});
