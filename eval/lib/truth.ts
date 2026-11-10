/**
 * Ground-truth classifier (pure). Turns `git diff -z` name-status + numstat
 * output into a TruthSet per spec §3.2. Never reads file contents and never
 * spawns a process — eval/lib/cache.ts runs git and feeds the raw text here.
 *
 * `-z` matters: without it git C-quotes paths with spaces or non-ASCII
 * characters, and a naive split would mis-attribute them.
 */
import path from 'path';
import ignore from 'ignore';
import type { DropReason, DroppedEntry, TruthEntry, TruthKind, TruthSet } from './types';

export interface NameStatusEntry {
  /** Status letter without score: A, M, D, R, C, T, U, X. */
  status: string;
  /** Old path for R/C; the only path otherwise. */
  path: string;
  /** New path for R/C. */
  newPath?: string;
}

export interface NumstatEntry {
  /** null for binary files (`-\t-`). */
  added: number | null;
  deleted: number | null;
}

const SOURCE_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const STYLE_EXTS = new Set(['.css', '.scss', '.sass', '.less']);
const DOC_EXTS = new Set(['.md', '.mdx', '.txt']);
const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb']);
const CONFIG_BASENAME_RES: readonly RegExp[] = [
  /^tsconfig.*\.json$/,
  /^jsconfig.*\.json$/,
  /^\.eslintrc/,
  /^eslint\.config\./,
  /^\.babelrc/,
  /^babel\.config\./,
  /^postcss\.config\./,
  /^tailwind\.config\./,
  /^webpack.*\.js$/,
  /^vite\.config\./,
  /^next\.config\./,
  /^jest\.config\./,
  /^vitest\.config\./,
  /^\.nvmrc$/,
  /^\.node-version$/,
  /^\.prettierrc/,
  /^\.stylelintrc/,
  /^\.browserslistrc$/
];

/** POSIX, repo-relative, no leading `./`. */
export function normalizeRepoPath(p: string): string {
  let out = p.replace(/\\/g, '/');
  while (out.startsWith('./')) out = out.slice(2);
  return out;
}

/** Parse `git diff --name-status -z [-M]` output. */
export function parseNameStatusZ(raw: string): NameStatusEntry[] {
  const tokens = raw.split('\0');
  const out: NameStatusEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const statusToken = tokens[i];
    if (statusToken === undefined || statusToken === '') {
      i += 1;
      continue;
    }
    const status = statusToken.charAt(0);
    if (status === 'R' || status === 'C') {
      const from = tokens[i + 1];
      const to = tokens[i + 2];
      if (from === undefined || to === undefined) throw new Error(`truncated name-status entry "${statusToken}"`);
      out.push({ status, path: normalizeRepoPath(from), newPath: normalizeRepoPath(to) });
      i += 3;
    } else {
      const p = tokens[i + 1];
      if (p === undefined) throw new Error(`truncated name-status entry "${statusToken}"`);
      out.push({ status, path: normalizeRepoPath(p) });
      i += 2;
    }
  }
  return out;
}

/**
 * Parse `git diff --numstat -z [-M]` output, keyed by path. For a rename,
 * git prints `added\tdeleted\t` then `\0old\0new\0`; it is keyed by the old
 * path (the path at base), matching how truth records renames.
 */
export function parseNumstatZ(raw: string): Map<string, NumstatEntry> {
  const tokens = raw.split('\0');
  const out = new Map<string, NumstatEntry>();
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === undefined || token === '') {
      i += 1;
      continue;
    }
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(token);
    if (m === null) throw new Error(`unparseable numstat entry "${token}"`);
    const entry: NumstatEntry = {
      added: m[1] === '-' ? null : Number(m[1]),
      deleted: m[2] === '-' ? null : Number(m[2])
    };
    const inlinePath = m[3] as string;
    if (inlinePath === '') {
      const from = tokens[i + 1];
      if (from === undefined || tokens[i + 2] === undefined) throw new Error('truncated numstat rename entry');
      out.set(normalizeRepoPath(from), entry);
      i += 3;
    } else {
      out.set(normalizeRepoPath(inlinePath), entry);
      i += 1;
    }
  }
  return out;
}

export function isUnderDirs(p: string, projectDirs: readonly string[]): boolean {
  return projectDirs.some((dir) => {
    const d = normalizeRepoPath(dir).replace(/\/+$/, '');
    return d === '' || d === '.' || p === d || p.startsWith(`${d}/`);
  });
}

/** The kept kind for a path, or null when it is not source/config/style. */
export function keptKind(p: string): TruthKind | null {
  const base = path.posix.basename(p);
  if (CONFIG_BASENAME_RES.some((re) => re.test(base))) return 'config';
  const ext = path.posix.extname(base).toLowerCase();
  if (SOURCE_EXTS.has(ext)) return 'source';
  if (STYLE_EXTS.has(ext)) return 'style';
  return null;
}

/** Drop reasons that depend on the path alone, checked in §3.2 order. */
function pathDropReason(p: string, isExcluded: (p: string) => boolean): DropReason | null {
  const base = path.posix.basename(p);
  if (base.startsWith('.env')) return 'env';
  if (LOCKFILES.has(base)) return 'lockfile';
  if (base === 'package.json') return 'package-json';
  if (isExcluded(p)) return 'excluded';
  if (p.split('/').includes('__snapshots__') || base.endsWith('.snap')) return 'snapshot';
  const ext = path.posix.extname(base).toLowerCase();
  if (DOC_EXTS.has(ext) || /^CHANGELOG/i.test(base) || /^LICENSE/i.test(base)) return 'docs';
  return null;
}

export interface BuildTruthInput {
  nameStatusZ: string;
  numstatZ: string;
  projectDirs: readonly string[];
  excludeGlobs?: readonly string[];
}

function byPath<T extends { path: string }>(a: T, b: T): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

export function buildTruthSet(input: BuildTruthInput): TruthSet {
  const entries = parseNameStatusZ(input.nameStatusZ);
  const numstat = parseNumstatZ(input.numstatZ);
  const globs = input.excludeGlobs ?? [];
  const matcher = ignore().add([...globs]);
  const isExcluded = (p: string): boolean => globs.length > 0 && matcher.ignores(p);

  const kept: TruthEntry[] = [];
  const dropped: DroppedEntry[] = [];
  const outOfScope = new Set<string>();
  let addedCount = 0;

  for (const e of entries) {
    // A copy leaves its source untouched, so the only changed path is the
    // new one — which did not exist at base, same as an add. (Only reachable
    // with -C; the runner passes -M.)
    const isAdd = e.status === 'A' || e.status === 'C';
    const recordPath = e.status === 'C' && e.newPath !== undefined ? e.newPath : e.path;
    const drop = (reason: DropReason): void => {
      dropped.push({ path: recordPath, reason, status: e.status });
    };

    const byPathReason = pathDropReason(recordPath, isExcluded);
    if (byPathReason !== null) {
      drop(byPathReason);
      continue;
    }
    const stat = numstat.get(e.path);
    if (stat !== undefined && (stat.added === null || stat.deleted === null)) {
      drop('binary');
      continue;
    }
    // Only an in-place edit can be "formatting only": a pure rename also has
    // 0/0 but is a real change (e.g. middleware.ts → proxy.ts). Depending on
    // the git code path, a whitespace-only file is either printed as `0\t0`
    // or left out of `-w` numstat entirely — both mean "formatting".
    if (e.status === 'M' && (stat === undefined || (stat.added === 0 && stat.deleted === 0))) {
      drop('formatting');
      continue;
    }
    if (isAdd) {
      addedCount += 1;
      drop('added');
      continue;
    }
    const kind = keptKind(e.path);
    if (kind === null) {
      drop('other');
      continue;
    }
    if (!isUnderDirs(e.path, input.projectDirs)) {
      outOfScope.add(e.path);
      continue;
    }
    const entry: TruthEntry = { path: e.path, kind, status: e.status };
    if (e.newPath !== undefined) entry.newPath = e.newPath;
    kept.push(entry);
  }

  return {
    kept: kept.sort(byPath),
    dropped: dropped.sort(byPath),
    addedCount,
    outOfScope: Array.from(outOfScope).sort()
  };
}

// ---------------------------------------------------------------------------
// package.json dependency diff (authoring aid for `truth`)
// ---------------------------------------------------------------------------

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

export interface DependencyChange {
  field: (typeof DEP_FIELDS)[number];
  name: string;
  from: string | null;
  to: string | null;
}

function depsOf(pkg: unknown, field: (typeof DEP_FIELDS)[number]): Record<string, string> {
  if (typeof pkg !== 'object' || pkg === null) return {};
  const v = (pkg as Record<string, unknown>)[field];
  if (typeof v !== 'object' || v === null) return {};
  const out: Record<string, string> = {};
  for (const [k, ver] of Object.entries(v as Record<string, unknown>)) {
    if (typeof ver === 'string') out[k] = ver;
  }
  return out;
}

/** Added / removed / changed entries across the four dependency fields. */
export function diffPackageJson(before: unknown, after: unknown): DependencyChange[] {
  const out: DependencyChange[] = [];
  for (const field of DEP_FIELDS) {
    const a = depsOf(before, field);
    const b = depsOf(after, field);
    const names = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).sort();
    for (const name of names) {
      const from = a[name] ?? null;
      const to = b[name] ?? null;
      if (from !== to) out.push({ field, name, from, to });
    }
  }
  return out;
}
