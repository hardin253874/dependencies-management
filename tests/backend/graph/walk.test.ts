import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createSandbox, type Sandbox } from '../helpers/sandbox';
import { copyGraphFixture, writeProjectFile } from '../helpers/graphFixture';
import { walkProject } from '@/core/graph/walk';

const SENTINEL = 'ENV_SENTINEL_DO_NOT_READ_3a3';

let sandbox: Sandbox;
let projectRoot: string;

beforeEach(async () => {
  sandbox = await createSandbox('graph-walk');
  ({ projectRoot } = await copyGraphFixture(sandbox, 'walk-basic'));
  for (const rel of ['.env', '.env.local', '.env.production', 'src/.env.test', 'nested/deep/.env']) {
    await writeProjectFile(projectRoot, rel, `SECRET=${SENTINEL}\n`);
  }
  await writeProjectFile(projectRoot, 'src/huge.js', Buffer.alloc(2 * 1024 * 1024 + 10, 0x20));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await sandbox.dispose();
});

function isEnvName(p: unknown): boolean {
  if (typeof p !== 'string' && !(p instanceof URL) && !Buffer.isBuffer(p)) return false;
  const s = p instanceof URL ? p.pathname : p.toString();
  return path.basename(s).startsWith('.env');
}

describe('walkProject (3a.3)', () => {
  it('returns the expected source set, sorted, with kind/category/skip metadata', async () => {
    const res = await walkProject({ projectRoot });
    expect(res.map((f) => f.path)).toEqual([
      '.babelrc',
      'package.json',
      'postcss.config.js',
      'src/__tests__/index.test.ts',
      'src/components/Button.jsx',
      'src/huge.js',
      'src/index.ts',
      'styles/main.scss',
      'styles/plain.css',
      'tsconfig.json'
    ]);
    const byPath = new Map(res.map((f) => [f.path, f]));
    expect(byPath.get('src/index.ts')).toMatchObject({ kind: 'js', category: 'prod', skipReason: null });
    expect(byPath.get('src/__tests__/index.test.ts')).toMatchObject({ kind: 'js', category: 'test' });
    expect(byPath.get('styles/main.scss')).toMatchObject({ kind: 'style' });
    expect(byPath.get('.babelrc')).toMatchObject({ kind: 'config', category: 'config' });
    expect(byPath.get('postcss.config.js')).toMatchObject({ kind: 'js', category: 'config' });
    expect(byPath.get('src/huge.js')).toMatchObject({ skipReason: 'oversized' });
    expect(byPath.get('src/index.ts')!.size).toBeGreaterThan(0);
    expect(byPath.get('src/index.ts')!.mtimeMs).toBeGreaterThan(0);
  });

  it('excludes .gitignored, node_modules and .min.js files', async () => {
    const paths = (await walkProject({ projectRoot })).map((f) => f.path);
    expect(paths.some((p) => p.startsWith('ignored/'))).toBe(false);
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
    expect(paths.some((p) => p.endsWith('.min.js'))).toBe(false);
  });

  it('never returns and never opens or reads a .env* file', async () => {
    const spies = [
      vi.spyOn(fs.promises, 'readFile'),
      vi.spyOn(fs.promises, 'open'),
      vi.spyOn(fs, 'readFileSync'),
      vi.spyOn(fs, 'openSync'),
      vi.spyOn(fs, 'createReadStream')
    ];
    const res = await walkProject({ projectRoot });
    expect(res.some((f) => path.posix.basename(f.path).startsWith('.env'))).toBe(false);
    expect(JSON.stringify(res)).not.toContain(SENTINEL);
    for (const spy of spies) {
      const envCalls = spy.mock.calls.filter((args) => isEnvName(args[0]));
      expect(envCalls).toEqual([]);
    }
    // The walk did read the project's .gitignore through the spied API, so the spy is live.
    expect(spies[0]!.mock.calls.some((args) => String(args[0]).endsWith('.gitignore'))).toBe(true);
  });

  it('is deterministic', async () => {
    const a = await walkProject({ projectRoot });
    const b = await walkProject({ projectRoot });
    expect(b).toEqual(a);
  });

  it('does not follow a directory symlink that points outside the root', async () => {
    const outside = await sandbox.scratch('outside');
    await writeProjectFile(outside, 'leak.ts', 'export const leak = 1;\n');
    try {
      fs.symlinkSync(outside, path.join(projectRoot, 'linked'), 'junction');
    } catch {
      return; // symlinks/junctions unavailable on this machine; nothing to check
    }
    const paths = (await walkProject({ projectRoot })).map((f) => f.path);
    expect(paths.some((p) => p.startsWith('linked/'))).toBe(false);
  });
});
