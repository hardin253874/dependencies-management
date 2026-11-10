/**
 * Pinned-clone cache. Every eval target is cloned into
 * `<cacheDir>/<caseId>` and checked out at `baseCommit`; nothing is ever
 * written to the source repo or to this tool repo.
 *
 * Guards (thrown before any process is spawned):
 *   - the cache dir is not inside / equal to / a parent of the tool repo or
 *     any local source repo;
 *   - every writing git command (clone, fetch, checkout) runs in, and
 *     targets, a dir under the cache;
 *   - the only command that names a source repo is `clone`, as its source.
 *
 * No installs, no scripts, no hooks: git clone never copies a repo's hooks,
 * and every writing command also passes `core.hooksPath=<empty dir>` so a
 * global/user hooksPath (e.g. husky) cannot run either.
 *
 * Error messages never carry the absolute cache dir or the user's home dir
 * (they read `<cache>/<caseId>` / `~`): `runCase` copies them into
 * `CaseResult.error`, and the public results file is committed.
 */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { isLocalPath, phaseFromCommit } from './corpus';
import { GIT_CLONE_TIMEOUT_MS, GIT_TIMEOUT_MS, type GitRunner } from './git';
import { buildTruthSet, diffPackageJson, type DependencyChange } from './truth';
import type { CorpusCase, TruthSet } from './types';

export interface CacheDirInputs {
  flag?: string;
  env?: string;
  platform?: NodeJS.Platform;
  localAppData?: string;
  home?: string;
}

/** `--cache-dir`, then `DEP_AGENT_EVAL_CACHE`, then the per-OS default. */
export function resolveCacheDir(inputs: CacheDirInputs = {}): string {
  if (inputs.flag !== undefined && inputs.flag.length > 0) return path.resolve(inputs.flag);
  if (inputs.env !== undefined && inputs.env.length > 0) return path.resolve(inputs.env);
  const platform = inputs.platform ?? process.platform;
  const home = inputs.home ?? os.homedir();
  if (platform === 'win32') {
    const base = inputs.localAppData ?? path.join(home, 'AppData', 'Local');
    return path.join(base, 'dep-agent-eval');
  }
  return path.join(home, '.cache', 'dep-agent-eval');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Both slash styles of an absolute dir, without a trailing separator. */
function spellings(dir: string): string[] {
  const trimmed = path.resolve(dir).replace(/[\\/]+$/, '');
  return [...new Set([trimmed, trimmed.replace(/\\/g, '/'), trimmed.replace(/\//g, '\\')])];
}

/**
 * Replace the cache dir with `<cache>`, then the home dir with `~`, in either
 * slash style (case-insensitive on Windows). Applied to every error message
 * that can reach a results file.
 */
export function redactLocalPaths(text: string, dirs: { cacheDir?: string; home?: string } = {}): string {
  const flags = process.platform === 'win32' ? 'gi' : 'g';
  let out = text;
  const pairs: Array<[string | undefined, string]> = [
    [dirs.cacheDir, '<cache>'],
    [dirs.home ?? os.homedir(), '~']
  ];
  for (const [dir, placeholder] of pairs) {
    if (dir === undefined || dir.length === 0) continue;
    for (const spelling of spellings(dir)) {
      out = out.replace(new RegExp(escapeRegExp(spelling), flags), placeholder);
    }
  }
  return out;
}

function canonical(p: string): string {
  const resolved = path.resolve(p).replace(/[\\/]+$/, '');
  // Windows paths are case-insensitive; compare them that way so
  // "c:\Repo" and "C:\repo" are recognised as the same directory.
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** True when `child` is `parent` or lies below it. */
export function isSameOrInside(child: string, parent: string): boolean {
  const c = canonical(child);
  const p = canonical(parent);
  return c === p || c.startsWith(`${p}${path.sep}`) || c.startsWith(`${p}/`);
}

export class CacheGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CacheGuardError';
  }
}

export function assertSafeCacheDir(cacheDir: string, protectedDirs: readonly string[]): void {
  for (const dir of protectedDirs) {
    if (isSameOrInside(cacheDir, dir) || isSameOrInside(dir, cacheDir)) {
      throw new CacheGuardError(
        redactLocalPaths(
          `eval cache dir "${cacheDir}" overlaps protected dir "${dir}" — choose a cache dir outside the tool repo and every source repo`
        )
      );
    }
  }
}

export interface PinnedCacheOptions {
  git: GitRunner;
  cacheDir: string;
  toolRoot: string;
  /** Local source repos of private cases (never written). */
  localRepos: readonly string[];
  /**
   * `--offline`: every git call runs with `GIT_NO_LAZY_FETCH=1` (git >= 2.44),
   * so a blob-less clone cannot fetch missing blobs during diff/show/checkout.
   */
  offline?: boolean;
}

export interface PhaseTruth {
  phaseId: string;
  from: string;
  to: string;
  truth: TruthSet;
  /** Per projectDir: dependency changes in that dir's package.json. */
  dependencyDiff: Array<{ projectDir: string; changes: DependencyChange[] | null }>;
}

/** True when git reports that `<sha>:<path>` names no file at that commit. */
function isPathNotInCommit(message: string): boolean {
  return /does not exist in '|exists on disk, but not in '/.test(message);
}

function sameRepo(a: string, b: string): boolean {
  if (isLocalPath(a) && isLocalPath(b)) return canonical(a) === canonical(b);
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

export class PinnedCache {
  private readonly git: GitRunner;
  readonly cacheDir: string;
  private readonly hooksDir: string;
  private readonly offline: boolean;
  private readonly env: Readonly<Record<string, string>> | undefined;

  constructor(opts: PinnedCacheOptions) {
    this.git = opts.git;
    this.cacheDir = path.resolve(opts.cacheDir);
    assertSafeCacheDir(this.cacheDir, [opts.toolRoot, ...opts.localRepos]);
    this.hooksDir = path.join(this.cacheDir, '.empty-hooks');
    this.offline = opts.offline === true;
    this.env = this.offline ? { GIT_NO_LAZY_FETCH: '1' } : undefined;
  }

  caseDir(caseId: string): string {
    return path.join(this.cacheDir, caseId);
  }

  /** How a case's clone dir is named in messages (never the absolute path). */
  private displayCaseDir(caseId: string): string {
    return `<cache>/${caseId}`;
  }

  private redact(text: string): string {
    return redactLocalPaths(text, { cacheDir: this.cacheDir });
  }

  private assertUnderCache(p: string, what: string): void {
    if (!isSameOrInside(p, this.cacheDir)) {
      throw new CacheGuardError(this.redact(`refusing git ${what}: "${p}" is outside the eval cache`));
    }
  }

  private async runGit(args: string[], cwd: string, timeoutMs: number): Promise<string> {
    try {
      return await this.git.run(args, { cwd, timeoutMs, ...(this.env !== undefined ? { env: this.env } : {}) });
    } catch (e) {
      // git echoes paths (the hooksPath arg, a clone target) into its messages.
      if (e instanceof Error) e.message = this.redact(e.message);
      throw e;
    }
  }

  private writeConfig(): string[] {
    return [
      '-c',
      `core.hooksPath=${this.hooksDir}`,
      '-c',
      'core.autocrlf=false',
      '-c',
      'core.longpaths=true'
    ];
  }

  private async write(args: string[], cwd: string, target: string, timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
    this.assertUnderCache(cwd, args[0] ?? '?');
    this.assertUnderCache(target, args[0] ?? '?');
    return this.runGit([...this.writeConfig(), ...args], cwd, timeoutMs);
  }

  private read(args: string[], cwd: string): Promise<string> {
    this.assertUnderCache(cwd, args[0] ?? '?');
    return this.runGit(['-c', 'core.quotepath=off', ...args], cwd, GIT_TIMEOUT_MS);
  }

  private async hasCommit(dir: string, sha: string): Promise<boolean> {
    try {
      await this.read(['cat-file', '-e', `${sha}^{commit}`], dir);
      return true;
    } catch {
      return false;
    }
  }

  /** Clone (or reuse) and check out baseCommit. Returns the clone dir. */
  async prepare(c: CorpusCase, opts: { offline: boolean }): Promise<string> {
    const offline = opts.offline || this.offline;
    const dir = this.caseDir(c.id);
    const shown = this.displayCaseDir(c.id);
    this.assertUnderCache(dir, 'clone');
    await fs.mkdir(this.hooksDir, { recursive: true });

    const hasGitDir = await fs
      .stat(path.join(dir, '.git'))
      .then(() => true)
      .catch(() => false);
    const local = isLocalPath(c.repo);

    if (hasGitDir) {
      const origin = (await this.read(['config', '--get', 'remote.origin.url'], dir)).trim();
      if (!sameRepo(origin, c.repo)) {
        throw new Error(
          this.redact(`cache dir ${shown} is a clone of a different repo (origin "${origin}"); remove it by hand to re-clone`)
        );
      }
    } else {
      if (await fs.stat(dir).then(() => true).catch(() => false)) {
        throw new Error(`cache dir ${shown} exists but is not a git clone; remove it by hand to re-clone`);
      }
      if (offline) throw new Error(`--offline: no cached clone for ${c.id} at ${shown}`);
      await fs.mkdir(this.cacheDir, { recursive: true });
      const cloneArgs = local
        ? // --no-hardlinks: the cache shares no object files with the source repo.
          ['clone', '--no-hardlinks', '--no-checkout', c.repo, dir]
        : ['clone', '--filter=blob:none', '--no-checkout', c.repo, dir];
      await this.write(cloneArgs, this.cacheDir, dir, GIT_CLONE_TIMEOUT_MS);
    }

    const needed = [c.baseCommit, ...c.phases.map((p) => p.toCommit)];
    for (const sha of needed) {
      if (await this.hasCommit(dir, sha)) continue;
      if (local || offline) {
        throw new Error(`commit ${sha} not found in ${local ? 'the local source clone' : 'cache'} for ${c.id}${offline ? ' (--offline)' : ''}`);
      }
      await this.write(['fetch', 'origin', sha], dir, dir, GIT_CLONE_TIMEOUT_MS);
      if (!(await this.hasCommit(dir, sha))) throw new Error(`commit ${sha} not found after fetch for ${c.id}`);
    }

    await this.write(['checkout', '--detach', '--force', c.baseCommit], dir, dir, GIT_CLONE_TIMEOUT_MS);
    const head = (await this.read(['rev-parse', 'HEAD'], dir)).trim();
    if (head !== c.baseCommit) throw new Error(`checkout of ${c.baseCommit} left HEAD at ${head} for ${c.id}`);
    return dir;
  }

  /**
   * `null` only when git says the path is not in that commit. Any other
   * failure (timeout, missing blob under --offline, bad JSON) throws: curators
   * copy versions from this diff, so a silent "no package.json" is wrong data.
   */
  private async packageJsonAt(dir: string, sha: string, projectDir: string): Promise<unknown | null> {
    const rel = projectDir === '.' ? 'package.json' : `${projectDir.replace(/\/+$/, '')}/package.json`;
    let text: string;
    try {
      text = await this.read(['show', `${sha}:${rel}`], dir);
    } catch (e) {
      const message = (e as Error).message;
      if (isPathNotInCommit(message)) return null;
      throw new Error(`cannot read ${rel} at ${sha}: ${message}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (e) {
      throw new Error(`${rel} at ${sha} is not valid JSON: ${(e as Error).message}`);
    }
  }

  /** Truth set per phase. Reads git objects only; never touches the work tree. */
  async truthForPhases(c: CorpusCase, dir: string): Promise<PhaseTruth[]> {
    const out: PhaseTruth[] = [];
    // Excluded with a pathspec as well as by the classifier, so git never
    // even diffs .env files.
    const pathspec = ['--', '.', ':(exclude,glob)**/.env*'];
    for (let i = 0; i < c.phases.length; i += 1) {
      const phase = c.phases[i];
      if (phase === undefined) continue;
      const from = phaseFromCommit(c, i);
      for (const sha of [from, phase.toCommit]) {
        if (!(await this.hasCommit(dir, sha))) throw new Error(`commit ${sha} missing for ${c.id} phase ${phase.id}`);
      }
      const nameStatusZ = await this.read(['diff', '--name-status', '-z', '-M', from, phase.toCommit, ...pathspec], dir);
      const numstatZ = await this.read(
        ['diff', '--numstat', '-z', '-M', '-w', '--ignore-blank-lines', from, phase.toCommit, ...pathspec],
        dir
      );
      const truthInput: Parameters<typeof buildTruthSet>[0] = { nameStatusZ, numstatZ, projectDirs: c.projectDirs };
      if (c.truthExcludeGlobs !== undefined) truthInput.excludeGlobs = c.truthExcludeGlobs;
      const truth = buildTruthSet(truthInput);
      const dependencyDiff: PhaseTruth['dependencyDiff'] = [];
      for (const projectDir of c.projectDirs) {
        const before = await this.packageJsonAt(dir, from, projectDir);
        const after = await this.packageJsonAt(dir, phase.toCommit, projectDir);
        dependencyDiff.push({
          projectDir,
          changes: before === null && after === null ? null : diffPackageJson(before, after)
        });
      }
      out.push({ phaseId: phase.id, from, to: phase.toCommit, truth, dependencyDiff });
    }
    return out;
  }
}
