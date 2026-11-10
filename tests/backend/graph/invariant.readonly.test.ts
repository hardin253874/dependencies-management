/**
 * Invariant #1 (CLAUDE.md): the target project is read-only. The first test
 * of its kind in the repo (V2_STAGE3_SPEC 3a.7): building a graph — full and
 * incremental — leaves the project tree byte-identical, calls no Node write
 * API on a path under the project, and spawns no process.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { createSandbox, type Sandbox } from '../helpers/sandbox';
import { copyGraphFixture, writeProjectFile } from '../helpers/graphFixture';
import { buildGraph } from '@/core/graph/build';

let sandbox: Sandbox;

beforeEach(async () => {
  sandbox = await createSandbox('graph-readonly');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await sandbox.dispose();
});

const lock = <T>(_key: string, fn: () => Promise<T>): Promise<T> => fn();

interface Snap {
  path: string;
  size: number;
  mtimeMs: number;
  sha256: string;
}

function snapshot(root: string): Snap[] {
  const out: Snap[] = [];
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

const WRITE_FLAGS = /[wa+]/;

function isUnder(p: unknown, root: string): boolean {
  if (typeof p !== 'string' && !(p instanceof URL) && !Buffer.isBuffer(p)) return false;
  const s = p instanceof URL ? p.pathname : p.toString();
  const rel = path.relative(root.toLowerCase(), path.resolve(s).toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

describe('invariant: graph build never writes to the target project', () => {
  it.each(['config-refs', 'wrapper-module', 'scss-bootstrap', 'workspaces-monorepo'])(
    '%s: tree unchanged, no write calls under the root, no child processes',
    async (fixture) => {
      const { projectRoot, dbPath } = await copyGraphFixture(sandbox, fixture);
      await writeProjectFile(projectRoot, '.env', 'SECRET=readonly-test\n');
      const before = snapshot(projectRoot);

      const writeSpies = [
        ...(['writeFile', 'appendFile', 'mkdir', 'rm', 'rmdir', 'unlink', 'rename', 'copyFile', 'cp', 'truncate', 'symlink'] as const).map((m) =>
          vi.spyOn(fs.promises, m)
        ),
        ...(
          ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'rmdirSync', 'unlinkSync', 'renameSync', 'copyFileSync', 'cpSync', 'truncateSync', 'symlinkSync', 'writeFile', 'appendFile', 'mkdir', 'rm', 'rename', 'copyFile', 'createWriteStream'] as const
        ).map((m) => vi.spyOn(fs, m))
      ];
      const openSpies = [vi.spyOn(fs.promises, 'open'), vi.spyOn(fs, 'openSync'), vi.spyOn(fs, 'open')];
      const procSpies = (['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const).map((m) => vi.spyOn(cp, m));

      await buildGraph({ projectRoot, dbPath, mode: 'full', lock });
      await buildGraph({ projectRoot, dbPath, mode: 'auto', lock });

      for (const spy of writeSpies) {
        const hits = spy.mock.calls.filter((args) => isUnder(args[0], projectRoot) || isUnder(args[1], projectRoot));
        expect(hits, spy.getMockName()).toEqual([]);
      }
      for (const spy of openSpies) {
        const hits = spy.mock.calls.filter((args) => isUnder(args[0], projectRoot) && WRITE_FLAGS.test(String(args[1] ?? 'r')));
        expect(hits).toEqual([]);
      }
      for (const spy of procSpies) expect(spy).not.toHaveBeenCalled();

      expect(snapshot(projectRoot)).toEqual(before);
      expect(fs.existsSync(path.join(projectRoot, 'EXECUTED_MARKER'))).toBe(false);
    }
  );

  it('refuses a dbPath inside the project root before touching anything', async () => {
    const { projectRoot } = await copyGraphFixture(sandbox, 'index-files');
    const before = snapshot(projectRoot);
    await expect(buildGraph({ projectRoot, dbPath: path.join(projectRoot, 'graph.db'), mode: 'full', lock })).rejects.toMatchObject({
      name: 'GraphPathError'
    });
    expect(snapshot(projectRoot)).toEqual(before);
  });
});
