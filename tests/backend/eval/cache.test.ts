/**
 * Pinned-clone cache (v2 Stage 0.4). A recording fake GitRunner checks the
 * guards; one optional integration test clones THIS tool repo's existing
 * history (no `git commit` anywhere) into a sandbox.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { createSandbox, disposeAllSandboxes, type Sandbox } from '../helpers/sandbox';
import {
  CacheGuardError,
  PinnedCache,
  isSameOrInside,
  redactLocalPaths,
  resolveCacheDir
} from '../../../eval/lib/cache';
import { createExecGitRunner, type GitRunner, type GitRunOptions } from '../../../eval/lib/git';
import type { CorpusCase } from '../../../eval/lib/types';

const TOOL_ROOT = path.resolve(__dirname, '../../..');
const BASE = '1'.repeat(40);
const TO = '2'.repeat(40);

interface Call {
  args: string[];
  cwd: string;
  env: Readonly<Record<string, string>> | undefined;
}

const WRITE_COMMANDS = new Set(['clone', 'checkout', 'fetch']);

/** The git subcommand, skipping leading `-c key=value` pairs. */
function subcommand(args: readonly string[]): string {
  let i = 0;
  while (args[i] === '-c') i += 2;
  return args[i] ?? '';
}

interface FakeGitOptions {
  origin?: string;
  missing?: Set<string>;
  /** Answer for `git show <sha>:<path>`; a thrown Error simulates a git failure. */
  show?: (spec: string) => string;
  /** Throw this from `clone` instead of creating the clone dir. */
  cloneError?: (target: string) => Error;
}

function fakeGit(opts: FakeGitOptions = {}): GitRunner & { calls: Call[] } {
  const calls: Call[] = [];
  const missing = opts.missing ?? new Set<string>();
  return {
    calls,
    async run(args: readonly string[], o: GitRunOptions): Promise<string> {
      calls.push({ args: [...args], cwd: o.cwd, env: o.env });
      const sub = subcommand(args);
      if (sub === 'show') {
        if (opts.show === undefined) throw new Error('fatal: no show handler');
        return opts.show(args[args.length - 1] as string);
      }
      if (sub === 'clone' && opts.cloneError !== undefined) {
        throw opts.cloneError(args[args.length - 1] as string);
      }
      if (sub === 'clone') {
        await fs.mkdir(path.join(args[args.length - 1] as string, '.git'), { recursive: true });
        return '';
      }
      if (sub === 'config') return `${opts.origin ?? ''}\n`;
      if (sub === 'cat-file') {
        const sha = (args[args.length - 1] as string).replace('^{commit}', '');
        if (missing.has(sha)) throw new Error('missing');
        return '';
      }
      if (sub === 'rev-parse') return `${BASE}\n`;
      return '';
    }
  };
}

function caseOf(repo: string): CorpusCase {
  return {
    id: 'demo-case',
    repo,
    baseCommit: BASE,
    projectDirs: ['.'],
    phases: [{ id: 'main', toCommit: TO, packages: [{ name: 'react', from: '17.0.0', to: '18.0.0' }] }],
    tags: []
  };
}

let sandbox: Sandbox | undefined;
afterEach(async () => {
  if (sandbox !== undefined) await sandbox.dispose();
  sandbox = undefined;
  await disposeAllSandboxes();
});

describe('cache dir resolution and guards', () => {
  it('prefers --cache-dir, then env, then the per-OS default', () => {
    expect(resolveCacheDir({ flag: '/x/flag', env: '/x/env' })).toBe(path.resolve('/x/flag'));
    expect(resolveCacheDir({ env: '/x/env' })).toBe(path.resolve('/x/env'));
    expect(resolveCacheDir({ platform: 'win32', localAppData: 'C:\\Users\\u\\AppData\\Local' })).toBe(
      path.join('C:\\Users\\u\\AppData\\Local', 'dep-agent-eval')
    );
    expect(resolveCacheDir({ platform: 'linux', home: '/home/u' })).toBe(path.join('/home/u', '.cache', 'dep-agent-eval'));
  });

  it('throws before any spawn when the cache dir is inside the tool repo', () => {
    const git = fakeGit();
    expect(
      () => new PinnedCache({ git, cacheDir: path.join(TOOL_ROOT, 'eval', '.cache'), toolRoot: TOOL_ROOT, localRepos: [] })
    ).toThrow(CacheGuardError);
    expect(git.calls).toHaveLength(0);
  });

  it('throws when the cache dir equals, contains or sits inside a local source repo', async () => {
    sandbox = await createSandbox('eval-cache');
    const repo = await sandbox.scratch('source-repo');
    for (const cacheDir of [repo, path.join(repo, 'cache'), sandbox.scratchRoot]) {
      expect(() => new PinnedCache({ git: fakeGit(), cacheDir, toolRoot: TOOL_ROOT, localRepos: [repo] })).toThrow(
        CacheGuardError
      );
    }
  });

  it('compares Windows paths case-insensitively', () => {
    if (process.platform !== 'win32') return;
    expect(isSameOrInside('c:\\REPO\\sub', 'C:\\repo')).toBe(true);
  });
});

describe('PinnedCache.prepare with a fake git', () => {
  async function setup(repo: string, git: ReturnType<typeof fakeGit>): Promise<{ cache: PinnedCache; cacheDir: string }> {
    sandbox = await createSandbox('eval-cache');
    const cacheDir = await sandbox.scratch('cache');
    const localRepos = repo.startsWith('https://') ? [] : [repo];
    return { cache: new PinnedCache({ git, cacheDir, toolRoot: TOOL_ROOT, localRepos }), cacheDir };
  }

  it('runs every writing command under the cache, with an empty hooksPath', async () => {
    const git = fakeGit({ origin: 'https://example.com/r.git' });
    const { cache, cacheDir } = await setup('https://example.com/r.git', git);
    await cache.prepare(caseOf('https://example.com/r.git'), { offline: false });
    const writes = git.calls.filter((c) => WRITE_COMMANDS.has(subcommand(c.args)));
    expect(writes.map((c) => subcommand(c.args))).toEqual(['clone', 'checkout']);
    for (const w of writes) {
      expect(isSameOrInside(w.cwd, cacheDir)).toBe(true);
      expect(w.args).toContain(`core.hooksPath=${path.join(cacheDir, '.empty-hooks')}`);
    }
    const clone = writes[0]?.args ?? [];
    expect(clone).toContain('--filter=blob:none');
    expect(isSameOrInside(clone[clone.length - 1] as string, cacheDir)).toBe(true);
  });

  it('clones a local repo with --no-hardlinks and never writes in it', async () => {
    sandbox = await createSandbox('eval-cache');
    const repo = await sandbox.scratch('source-repo');
    const cacheDir = await sandbox.scratch('cache');
    const git = fakeGit({ origin: repo });
    const cache = new PinnedCache({ git, cacheDir, toolRoot: TOOL_ROOT, localRepos: [repo] });
    await cache.prepare(caseOf(repo), { offline: false });
    const clone = git.calls.find((c) => subcommand(c.args) === 'clone');
    expect(clone?.args).toContain('--no-hardlinks');
    for (const c of git.calls) expect(isSameOrInside(c.cwd, repo)).toBe(false);
  });

  it('never fetches with --offline and reports the missing SHA', async () => {
    const git = fakeGit({ origin: 'https://example.com/r.git', missing: new Set([TO]) });
    const { cache, cacheDir } = await setup('https://example.com/r.git', git);
    await fs.mkdir(path.join(cacheDir, 'demo-case', '.git'), { recursive: true });
    await expect(cache.prepare(caseOf('https://example.com/r.git'), { offline: true })).rejects.toThrow(TO);
    expect(git.calls.some((c) => subcommand(c.args) === 'fetch')).toBe(false);
  });

  it('fetches a missing SHA from an https origin when online', async () => {
    const git = fakeGit({ origin: 'https://example.com/r.git', missing: new Set([TO]) });
    const { cache } = await setup('https://example.com/r.git', git);
    await expect(cache.prepare(caseOf('https://example.com/r.git'), { offline: false })).rejects.toThrow(
      /not found after fetch/
    );
    expect(git.calls.find((c) => subcommand(c.args) === 'fetch')?.args.slice(-2)).toEqual(['origin', TO]);
  });

  it('refuses to reuse a clone of a different repo and does not delete it', async () => {
    const git = fakeGit({ origin: 'https://example.com/other.git' });
    const { cache, cacheDir } = await setup('https://example.com/r.git', git);
    await fs.mkdir(path.join(cacheDir, 'demo-case', '.git'), { recursive: true });
    await expect(cache.prepare(caseOf('https://example.com/r.git'), { offline: false })).rejects.toThrow(
      /different repo/
    );
    await expect(fs.stat(path.join(cacheDir, 'demo-case', '.git'))).resolves.toBeDefined();
  });
});

describe('PinnedCache --offline git environment (QA N1)', () => {
  it('sets GIT_NO_LAZY_FETCH=1 on every git call when offline', async () => {
    sandbox = await createSandbox('eval-cache');
    const cacheDir = await sandbox.scratch('cache');
    const git = fakeGit({ origin: 'https://example.com/r.git' });
    const cache = new PinnedCache({ git, cacheDir, toolRoot: TOOL_ROOT, localRepos: [], offline: true });
    await fs.mkdir(path.join(cacheDir, 'demo-case', '.git'), { recursive: true });
    await cache.prepare(caseOf('https://example.com/r.git'), { offline: true });
    expect(git.calls.length).toBeGreaterThan(0);
    for (const c of git.calls) expect(c.env?.GIT_NO_LAZY_FETCH).toBe('1');
  });

  it('does not set GIT_NO_LAZY_FETCH when online', async () => {
    sandbox = await createSandbox('eval-cache');
    const cacheDir = await sandbox.scratch('cache');
    const git = fakeGit({ origin: 'https://example.com/r.git' });
    const cache = new PinnedCache({ git, cacheDir, toolRoot: TOOL_ROOT, localRepos: [] });
    await cache.prepare(caseOf('https://example.com/r.git'), { offline: false });
    for (const c of git.calls) expect(c.env?.GIT_NO_LAZY_FETCH).toBeUndefined();
  });
});

describe('PinnedCache error messages carry no absolute local path (QA m6)', () => {
  async function setup(git: ReturnType<typeof fakeGit>): Promise<{ cache: PinnedCache; cacheDir: string }> {
    sandbox = await createSandbox('eval-cache');
    const cacheDir = await sandbox.scratch('cache');
    return { cache: new PinnedCache({ git, cacheDir, toolRoot: TOOL_ROOT, localRepos: [] }), cacheDir };
  }

  async function messageOf(p: Promise<unknown>): Promise<string> {
    const err = await p.then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    return (err as Error).message;
  }

  it('--offline without a cached clone names <cache>/<caseId>, not the absolute dir', async () => {
    const { cache, cacheDir } = await setup(fakeGit());
    const msg = await messageOf(cache.prepare(caseOf('https://example.com/r.git'), { offline: true }));
    expect(msg).toContain('<cache>/demo-case');
    expect(msg).not.toContain(cacheDir);
  });

  it('a clone of a different repo names <cache>/<caseId>', async () => {
    const { cache, cacheDir } = await setup(fakeGit({ origin: 'https://example.com/other.git' }));
    await fs.mkdir(path.join(cacheDir, 'demo-case', '.git'), { recursive: true });
    const msg = await messageOf(cache.prepare(caseOf('https://example.com/r.git'), { offline: false }));
    expect(msg).toContain('<cache>/demo-case');
    expect(msg).not.toContain(cacheDir);
  });

  it('a dir that is not a git clone names <cache>/<caseId>', async () => {
    const { cache, cacheDir } = await setup(fakeGit());
    await fs.mkdir(path.join(cacheDir, 'demo-case'), { recursive: true });
    const msg = await messageOf(cache.prepare(caseOf('https://example.com/r.git'), { offline: false }));
    expect(msg).toContain('<cache>/demo-case');
    expect(msg).not.toContain(cacheDir);
  });

  it('redacts the cache dir out of a git failure message', async () => {
    const { cache, cacheDir } = await setup(
      fakeGit({ cloneError: (target) => new Error(`fatal: could not create work tree dir '${target}'`) })
    );
    const msg = await messageOf(cache.prepare(caseOf('https://example.com/r.git'), { offline: false }));
    expect(msg).toContain('<cache>');
    expect(msg).not.toContain(cacheDir);
  });

  it('redactLocalPaths replaces the cache dir and the home dir in either slash style', () => {
    const home = path.join(path.parse(TOOL_ROOT).root, 'Users', 'someone');
    const cacheDir = path.join(home, 'AppData', 'Local', 'dep-agent-eval');
    const fwd = (p: string): string => p.split(path.sep).join('/');
    const text = `a ${path.join(cacheDir, 'x')} b ${fwd(cacheDir)}/y c ${path.join(home, 'repo')}`;
    const out = redactLocalPaths(text, { cacheDir, home });
    expect(out).not.toContain(home);
    expect(out).not.toContain(fwd(home));
    expect(out).toContain('<cache>');
    expect(out).toContain('~');
  });
});

describe('PinnedCache.truthForPhases package.json lookup (QA m4)', () => {
  const PKG = JSON.stringify({ dependencies: { react: '17.0.0' } });

  async function truthWith(show: (spec: string) => string): ReturnType<PinnedCache['truthForPhases']> {
    sandbox = await createSandbox('eval-cache');
    const cacheDir = await sandbox.scratch('cache');
    const git = fakeGit({ show });
    const cache = new PinnedCache({ git, cacheDir, toolRoot: TOOL_ROOT, localRepos: [] });
    return cache.truthForPhases(caseOf('https://example.com/r.git'), path.join(cacheDir, 'demo-case'));
  }

  it('treats "does not exist in" as no package.json', async () => {
    const phases = await truthWith((spec) => {
      const [sha, rel] = spec.split(':');
      throw new Error(`fatal: path '${rel ?? ''}' does not exist in '${sha ?? ''}'`);
    });
    expect(phases[0]?.dependencyDiff[0]?.changes).toBeNull();
  });

  it('treats "exists on disk, but not in" as no package.json at that commit', async () => {
    const phases = await truthWith((spec) => {
      if (spec.startsWith(BASE)) throw new Error(`fatal: path 'package.json' exists on disk, but not in '${BASE}'`);
      return PKG;
    });
    expect(phases[0]?.dependencyDiff[0]?.changes).not.toBeNull();
  });

  it('rethrows any other git error with the sha and path', async () => {
    await expect(
      truthWith(() => {
        throw new Error('git show failed: timed out after 60000 ms');
      })
    ).rejects.toThrow(new RegExp(`package\\.json at ${BASE}.*timed out`));
  });

  it('rethrows a JSON parse error with the sha and path', async () => {
    await expect(truthWith(() => '{ not json')).rejects.toThrow(
      new RegExp(`package\\.json at ${BASE} is not valid JSON`)
    );
  });
});

function toolHistory(): string[] {
  try {
    const shallow = execFileSync('git', ['--no-optional-locks', 'rev-parse', '--is-shallow-repository'], {
      cwd: TOOL_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (shallow !== 'false') return [];
    return execFileSync('git', ['--no-optional-locks', 'rev-list', '--max-count=2', 'HEAD'], {
      cwd: TOOL_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .split(/\r?\n/)
      .filter((l) => /^[0-9a-f]{40}$/.test(l));
  } catch {
    return [];
  }
}

const history = toolHistory();

describe.skipIf(history.length < 2)('PinnedCache integration (clones this tool repo)', () => {
  it(
    'clones with --no-hardlinks, checks out a historical commit and computes truth',
    async () => {
      sandbox = await createSandbox('eval-cache-int');
      const cacheDir = await sandbox.scratch('cache');
      const [head, parent] = history as [string, string];
      const c: CorpusCase = {
        id: 'tool-self',
        repo: TOOL_ROOT,
        baseCommit: parent,
        projectDirs: ['.'],
        phases: [{ id: 'main', toCommit: head, packages: [{ name: 'react', from: '1', to: '2' }] }],
        tags: []
      };
      const cache = new PinnedCache({ git: createExecGitRunner(), cacheDir, toolRoot: TOOL_ROOT, localRepos: [TOOL_ROOT] });
      const dir = await cache.prepare(c, { offline: false });
      expect(isSameOrInside(dir, cacheDir)).toBe(true);
      const phases = await cache.truthForPhases(c, dir);
      expect(phases).toHaveLength(1);
      const t = phases[0]?.truth;
      expect(t).toBeDefined();
      // Every changed path is accounted for exactly once.
      const all = [...(t?.kept ?? []).map((k) => k.path), ...(t?.dropped ?? []).map((d) => d.path), ...(t?.outOfScope ?? [])];
      expect(new Set(all).size).toBe(all.length);
      // Second prepare reuses the clone offline.
      await expect(cache.prepare(c, { offline: true })).resolves.toBe(dir);
    },
    120_000
  );
});
