/**
 * Invariant #1 for the agent tools (V2_STAGE4_SPEC 4a.3, design §8): calling
 * EVERY registered tool leaves the target tree byte-identical, calls no Node
 * write API under the project root, spawns no process and never opens `.env*`.
 * Also: the registry refuses non-read tools (the L3 seam).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { createSandbox, type Sandbox } from '../helpers/sandbox';
import { buildAgentFixture, type BuiltFixture } from '../helpers/agentFixture';
import { writeProjectFile } from '../helpers/graphFixture';
import { packageTgz } from '../helpers/tarball';
import { createReadToolRegistry, readToolDefs } from '@/core/agent/tools';
import { createToolRegistry } from '@/core/agent/registry';
import type { IntelContext } from '@/core/agent/types';

let sandbox: Sandbox;
let fx: BuiltFixture;

function snapshot(root: string): Array<{ path: string; size: number; mtimeMs: number; sha256: string }> {
  const out: Array<{ path: string; size: number; mtimeMs: number; sha256: string }> = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else {
        const st = fs.statSync(full);
        out.push({
          path: path.relative(root, full).split(path.sep).join('/'),
          size: st.size,
          mtimeMs: st.mtimeMs,
          sha256: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
        });
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

/** One valid call per tool, so every handler runs. */
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

beforeAll(async () => {
  sandbox = await createSandbox('agent-readonly');
  fx = await buildAgentFixture(sandbox, 'wrapper-module', {
    prepare: async (root) => {
      await writeProjectFile(root, '.env', 'SENTINEL=1\n');
      await writeProjectFile(root, 'src/.env.local', 'SENTINEL=2\n');
    }
  });
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  fx.graph.close();
  await sandbox.dispose();
});

describe('invariant: agent tools never write to the target project', () => {
  it('every registered tool has a call in this test', () => {
    expect(Object.keys(CALLS).sort()).toEqual(readToolDefs().map((t) => t.name).sort());
  });

  it('tree unchanged, no write/exec calls under the root, no .env opened', async () => {
    const tgz = packageTgz({ 'package.json': JSON.stringify({ types: 'index.d.ts' }), 'index.d.ts': 'export declare const a: number;\n' });
    const intel: IntelContext = {
      fetchPackument: async () => ({ versions: { '1.0.0': { dist: { tarball: 'u1' } }, '2.0.0': { dist: { tarball: 'u2' }, peerDependencies: { react: '*' } } } }),
      fetchTarball: async () => new Uint8Array(tgz),
      apiDiffCacheDir: path.join(sandbox.libraryRoot, '_apidiff')
    };
    const before = snapshot(fx.projectRoot);
    const writeSpies = [
      ...(['writeFile', 'appendFile', 'mkdir', 'rm', 'rmdir', 'unlink', 'rename', 'copyFile', 'cp', 'truncate', 'symlink'] as const).map((m) => vi.spyOn(fs.promises, m)),
      ...(['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'renameSync', 'copyFileSync', 'writeFile', 'createWriteStream'] as const).map((m) => vi.spyOn(fs, m))
    ];
    const openSpies = [vi.spyOn(fs.promises, 'open'), vi.spyOn(fs, 'openSync'), vi.spyOn(fs, 'open')];
    const readSpies = [vi.spyOn(fs.promises, 'readFile'), vi.spyOn(fs, 'readFileSync'), vi.spyOn(fs.promises, 'realpath'), vi.spyOn(fs.promises, 'stat')];
    const procSpies = (['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const).map((m) => vi.spyOn(cp, m));

    const reg = createReadToolRegistry();
    for (const t of reg.tools) {
      const r = await reg.call(t.name, CALLS[t.name], fx.ctx({ intel }));
      expect(r.isError, `${t.name}: ${r.content}`).toBe(false);
    }
    // Also hammer the file tools with .env paths.
    for (const p of ['.env', 'src/.env.local', './.env']) expect((await reg.call('read_file', { path: p }, fx.ctx({ intel }))).isError).toBe(true);

    for (const spy of [...writeSpies, ...openSpies]) {
      expect(spy.mock.calls.filter((args) => isUnder(args[0], fx.projectRoot) || isUnder(args[1], fx.projectRoot))).toEqual([]);
    }
    for (const spy of [...readSpies, ...openSpies]) expect(spy.mock.calls.filter((args) => isEnv(args[0]))).toEqual([]);
    for (const spy of procSpies) expect(spy).not.toHaveBeenCalled();
    expect(readSpies[0]!.mock.calls.some((args) => isUnder(args[0], fx.projectRoot))).toBe(true);
    expect(snapshot(fx.projectRoot)).toEqual(before);
  });

  it('the read tool set registers only capability "read"; adding a write or execute tool fails', () => {
    const defs = readToolDefs();
    expect(defs.every((d) => d.capability === 'read')).toBe(true);
    expect(() => createToolRegistry([...defs, { ...defs[0]!, name: 'write_file', capability: 'write' }])).toThrow(/capability must be 'read'/);
    expect(() => createToolRegistry([...defs, { ...defs[0]!, name: 'run_tests', capability: 'execute' }])).toThrow(/capability must be 'read'/);
  });
});
