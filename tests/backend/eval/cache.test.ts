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
import { CacheGuardError, PinnedCache, isSameOrInside, resolveCacheDir } from '../../../eval/lib/cache';
import { createExecGitRunner, type GitRunner, type GitRunOptions } from '../../../eval/lib/git';
import type { CorpusCase } from '../../../eval/lib/types';

const TOOL_ROOT = path.resolve(__dirname, '../../..');
const BASE = '1'.repeat(40);
const TO = '2'.repeat(40);

interface Call {
  args: string[];
  cwd: string;
}

const WRITE_COMMANDS = new Set(['clone', 'checkout', 'fetch']);

/** The git subcommand, skipping leading `-c key=value` pairs. */
function subcommand(args: readonly string[]): string {
  let i = 0;
  while (args[i] === '-c') i += 2;
  return args[i] ?? '';
}

function fakeGit(opts: { origin?: string; missing?: Set<string> } = {}): GitRunner & { calls: Call[] } {
  const calls: Call[] = [];
  const missing = opts.missing ?? new Set<string>();
  return {
    calls,
    async run(args: readonly string[], o: GitRunOptions): Promise<string> {
      calls.push({ args: [...args], cwd: o.cwd });
      const sub = subcommand(args);
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
