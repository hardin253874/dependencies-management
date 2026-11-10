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

const NUMERIC_WRITE_BITS = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_TRUNC;

/** True when an `open` flags argument (string or numeric) can write. */
function isWriteOpen(flags: unknown): boolean {
  if (typeof flags === 'number') return (flags & NUMERIC_WRITE_BITS) !== 0;
  return WRITE_FLAGS.test(String(flags ?? 'r'));
}

function isEnvPath(p: unknown): boolean {
  if (typeof p !== 'string' && !(p instanceof URL) && !Buffer.isBuffer(p)) return false;
  const s = p instanceof URL ? p.pathname : p.toString();
  return path.basename(s).startsWith('.env');
}

function isUnder(p: unknown, root: string): boolean {
  if (typeof p !== 'string' && !(p instanceof URL) && !Buffer.isBuffer(p)) return false;
  const s = p instanceof URL ? p.pathname : p.toString();
  const rel = path.relative(root.toLowerCase(), path.resolve(s).toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Stage 3c (3a QA m4): `fs.open(p, O_WRONLY | O_CREAT)` stringifies to a number and slipped past the regex.
describe('open-flag classification used by the invariant', () => {
  const { O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_APPEND, O_TRUNC } = fs.constants;
  it.each([
    ['r', false],
    ['rs', false],
    [undefined, false],
    [O_RDONLY, false],
    ['w', true],
    ['a+', true],
    ['r+', true],
    [O_WRONLY, true],
    [O_RDWR, true],
    [O_WRONLY | O_CREAT, true],
    [O_RDONLY | O_APPEND, true],
    [O_RDONLY | O_TRUNC, true],
    [O_RDONLY | O_CREAT, true]
  ] as Array<[string | number | undefined, boolean]>)('%s → write=%s', (flags, expected) => {
    expect(isWriteOpen(flags)).toBe(expected);
  });
});

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
      // Stage 3c (3a QA m4): no JS read path of the build (walk, resolver configs, lockfile) opens `.env*`.
      const readSpies = [
        vi.spyOn(fs.promises, 'readFile'),
        vi.spyOn(fs, 'readFileSync'),
        vi.spyOn(fs, 'readFile'),
        vi.spyOn(fs, 'createReadStream')
      ];

      await buildGraph({ projectRoot, dbPath, mode: 'full', lock });
      await buildGraph({ projectRoot, dbPath, mode: 'auto', lock });

      for (const spy of writeSpies) {
        const hits = spy.mock.calls.filter((args) => isUnder(args[0], projectRoot) || isUnder(args[1], projectRoot));
        expect(hits, spy.getMockName()).toEqual([]);
      }
      for (const spy of openSpies) {
        const hits = spy.mock.calls.filter((args) => isUnder(args[0], projectRoot) && isWriteOpen(args[1]));
        expect(hits).toEqual([]);
      }
      for (const spy of procSpies) expect(spy).not.toHaveBeenCalled();
      for (const spy of [...readSpies, ...openSpies]) {
        expect(spy.mock.calls.filter((args) => isEnvPath(args[0]))).toEqual([]);
      }
      // The spies are live: the build did read project files through them.
      expect(readSpies[0]!.mock.calls.some((args) => isUnder(args[0], projectRoot))).toBe(true);

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
