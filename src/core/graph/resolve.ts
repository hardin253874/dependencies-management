/**
 * Specifier resolution (V2_STAGE3_SPEC 3a.5, design §5): specifier →
 * project file | package(+subpath) | builtin | unresolved(reason).
 *
 * Engine: `oxc-resolver` (proposed D20), configured from the target's own
 * files, which are read as data and never executed:
 *  - nearest `tsconfig.json`/`jsconfig.json` (paths, baseUrl, extends chains
 *    — oxc follows them; we follow them too, only to hash what was read);
 *  - package.json `exports`/`imports`/`browser`/`main`/`module`;
 *  - npm/yarn `workspaces` → aliases to the workspace dirs;
 *  - static bundler aliases (aliases.ts), applied first like the bundler does,
 *    with `confidence: medium`.
 *
 * A fresh ResolverFactory per context: oxc caches the file system, and a
 * stale cache would make incremental builds disagree with full builds.
 */
import { createRequire, isBuiltin } from 'module';
import { createHash } from 'crypto';
import { promises as fs, statSync } from 'fs';
import path from 'path';
import type { NapiResolveOptions, ResolverFactory as OxcResolverFactory, ResolveResult } from 'oxc-resolver';
import { packageNameFromSpecifier } from '../../lib/scanners/code';
import { readAliasesFromSource, matchAlias, matchUnreadable, type AliasSet } from './aliases';
import { jsConfigInfo } from './configFiles';
import { isRecord, parseJsonc } from './jsonc';
import { isInterpolatedStyleSpecifier } from './style';
import { isEnvFileName, STYLE_EXTS, type WalkEntry } from './walk';
import type { Confidence, EdgeKind, Resolution, UnresolvedReason } from './types';

// oxc-resolver is a napi addon published as CommonJS; createRequire keeps the
// load identical under Turbopack (serverExternalPackages), Vitest and vite-node.
const requireFn = createRequire(import.meta.url);
const oxc = requireFn('oxc-resolver') as { ResolverFactory: typeof OxcResolverFactory };

export const OXC_RESOLVER_VERSION = '11.24.2';

export interface ResolveRequest {
  /** POSIX path of the importing file, relative to the project root. */
  fromFile: string;
  specifier: string | null;
  kind: EdgeKind;
}

export interface ResolveOutcome {
  resolution: Resolution;
  /** POSIX path relative to the project root (resolved only). */
  toFile: string | null;
  packageName: string | null;
  subpath: string | null;
  isWorkspace: boolean;
  confidence: Confidence;
  unresolvedReason: UnresolvedReason | null;
  /** The bundler alias key that fired (or that was unreadable). */
  alias: string | null;
}

export interface WorkspacePackage {
  name: string;
  /** POSIX dir relative to the project root. */
  dir: string;
}

export interface ResolverContext {
  readonly id: string;
  /** sha256 over every config file this context read (path + content). */
  readonly configHash: string;
  /** Config files read, POSIX relative to the root (sorted). */
  readonly configFiles: string[];
  /** Dependency names declared in the root and workspace package.json files (sorted). */
  readonly declared: string[];
  readonly workspaces: WorkspacePackage[];
  readonly unreadableAliases: string[];
  /** package.json main/module/bin/exports targets that resolve to project files. */
  readonly entryPaths: string[];
  resolve(req: ResolveRequest): ResolveOutcome;
}

export interface CreateResolverOptions {
  projectRoot: string;
  files: readonly WalkEntry[];
}

// `.d.ts` right after `.ts`/`.tsx`, as TypeScript probes: `./FooType` → `FooType.d.ts` is common in app code.
const EXTENSIONS: readonly string[] = Object.freeze(['.ts', '.tsx', '.d.ts', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json']);
const NPM_NAME_RE = /^(?:@[A-Za-z0-9][\w.-]*\/)?[A-Za-z0-9][\w.-]*$/;
const URL_LIKE_RE = /^[a-z][a-z0-9+.-]*:/i;
const BUNDLER_TOOLS: readonly string[] = Object.freeze(['webpack', 'vite', 'next', 'craco']);
const MAX_EXTENDS_DEPTH = 10;

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function sameKey(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/** POSIX path of `abs` relative to `root`, '' for the root itself, null when outside. */
function relInside(root: string, abs: string): string | null {
  const rel = path.relative(root, abs);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return toPosix(rel);
  // win32: paths that differ only by case (e.g. drive letter) are the same folder.
  const relCi = path.relative(sameKey(root), sameKey(abs));
  if (relCi.startsWith('..') || path.isAbsolute(relCi)) return null;
  return toPosix(path.resolve(abs).slice(path.resolve(root).length).replace(/^[\\/]/, ''));
}

function packageFromNodeModulesPath(abs: string): string | null {
  const parts = toPosix(abs).split('/');
  const idx = parts.lastIndexOf('node_modules');
  if (idx === -1) return null;
  const first = parts[idx + 1];
  if (first === undefined) return null;
  if (first.startsWith('@')) {
    const second = parts[idx + 2];
    return second === undefined ? null : `${first}/${second}`;
  }
  return first;
}

function subpathOf(specifier: string, pkg: string): string | null {
  if (!specifier.startsWith(pkg)) return null;
  const rest = specifier.slice(pkg.length).replace(/^\//, '');
  return rest === '' ? null : rest;
}

function isRelativeOrAbsolute(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..' || spec.startsWith('/') || path.isAbsolute(spec);
}

function stringLeaves(v: unknown, out: string[]): void {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringLeaves(x, out);
  else if (isRecord(v)) for (const x of Object.values(v)) stringLeaves(x, out);
}

function sortedUnique(xs: Iterable<string>): string[] {
  return [...new Set(xs)].sort();
}

interface TsconfigInfo {
  /** Absolute path of the tsconfig/jsconfig the resolver uses for this dir. */
  configFile: string;
  /** `paths` patterns as [prefix, suffix] pairs, from the whole extends chain. */
  pathPatterns: Array<[string, string]>;
}

export async function createResolverContext(opts: CreateResolverOptions): Promise<ResolverContext> {
  const root = path.resolve(opts.projectRoot);
  const read = new Map<string, string>(); // config key (POSIX rel or abs) → content

  const readConfig = async (abs: string): Promise<string | null> => {
    if (isEnvFileName(path.basename(abs))) return null; // never, even for an odd extends value
    const key = relInside(root, abs) ?? toPosix(abs);
    const cached = read.get(key);
    if (cached !== undefined) return cached;
    try {
      const text = await fs.readFile(abs, 'utf8');
      read.set(key, text);
      return text;
    } catch {
      return null;
    }
  };

  const byPath = new Map(opts.files.map((f) => [f.path, f]));

  // ---- package.json: declared deps, workspaces, entries
  const rootPkgText = byPath.has('package.json') ? await readConfig(path.join(root, 'package.json')) : null;
  const rootPkg = rootPkgText === null ? null : parseJsonc(rootPkgText);
  const workspaces: WorkspacePackage[] = [];
  const pkgJsons: Array<{ dir: string; json: Record<string, unknown> }> = [];
  if (isRecord(rootPkg)) pkgJsons.push({ dir: '', json: rootPkg });

  const wsPatterns: string[] = [];
  if (isRecord(rootPkg)) {
    const ws = rootPkg.workspaces;
    if (Array.isArray(ws)) wsPatterns.push(...ws.filter((x): x is string => typeof x === 'string'));
    else if (isRecord(ws) && Array.isArray(ws.packages)) wsPatterns.push(...ws.packages.filter((x): x is string => typeof x === 'string'));
  }
  for (const dir of expandWorkspacePatterns(wsPatterns, opts.files)) {
    const text = await readConfig(path.join(root, dir, 'package.json'));
    const json = text === null ? null : parseJsonc(text);
    if (!isRecord(json)) continue;
    pkgJsons.push({ dir, json });
    if (typeof json.name === 'string') workspaces.push({ name: json.name, dir });
  }
  workspaces.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const declared = sortedUnique(
    pkgJsons.flatMap(({ json }) =>
      ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((k) => {
        const v = json[k];
        return isRecord(v) ? Object.keys(v) : [];
      })
    )
  );

  // Dependencies named by ANY package.json in the walk (nested apps that are not workspaces
  // included). Only used to keep a package name behind an unreadable alias.
  const knownPackages = new Set<string>(declared);
  for (const f of opts.files) {
    if (path.posix.basename(f.path) !== 'package.json' || f.skipReason !== null) continue;
    const text = await readConfig(f.absPath);
    const json = text === null ? null : parseJsonc(text);
    if (!isRecord(json)) continue;
    for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const v = json[k];
      if (isRecord(v)) for (const name of Object.keys(v)) knownPackages.add(name);
    }
  }

  // ---- tsconfig / jsconfig per directory
  const tsconfigByDir = new Map<string, TsconfigInfo>();
  const tsFiles = opts.files.filter((f) => f.kind === 'config' && /^(tsconfig|jsconfig)\.json$/.test(path.posix.basename(f.path)));
  // tsconfig.json wins over jsconfig.json in the same dir: process jsconfig first, overwrite.
  // Ascending basename: 'jsconfig.json' < 'tsconfig.json', so the tsconfig is set last and wins.
  tsFiles.sort((a, b) => path.posix.basename(a.path).localeCompare(path.posix.basename(b.path)) || a.path.localeCompare(b.path));
  for (const f of tsFiles) {
    const patterns: Array<[string, string]> = [];
    await readTsconfigChain(f.absPath, root, readConfig, patterns, 0);
    tsconfigByDir.set(path.posix.dirname(f.path) === '.' ? '' : path.posix.dirname(f.path), { configFile: f.absPath, pathPatterns: patterns });
  }

  // ---- bundler aliases per directory
  const aliasByDir = new Map<string, AliasSet>();
  for (const f of opts.files) {
    const info = jsConfigInfo(f.path);
    if (info === null || !BUNDLER_TOOLS.includes(info.tool) || f.skipReason !== null) continue;
    const text = await readConfig(f.absPath);
    if (text === null) continue;
    const set = readAliasesFromSource(text, path.dirname(f.absPath));
    if (set.rules.length === 0 && set.unreadable.length === 0) continue;
    const dir = path.posix.dirname(f.path) === '.' ? '' : path.posix.dirname(f.path);
    const existing = aliasByDir.get(dir);
    if (existing === undefined) aliasByDir.set(dir, set);
    else {
      existing.rules.push(...set.rules);
      existing.unreadable.push(...set.unreadable);
    }
  }
  const unreadableAliases = sortedUnique([...aliasByDir.values()].flatMap((s) => s.unreadable.map((u) => u.key)));

  // ---- oxc resolvers
  const workspaceAlias: Record<string, string[]> = {};
  for (const w of workspaces) workspaceAlias[w.name] = [path.join(root, w.dir)];
  const baseOptions: NapiResolveOptions = {
    extensions: [...EXTENSIONS],
    extensionAlias: { '.js': ['.ts', '.tsx', '.js', '.jsx'], '.jsx': ['.tsx', '.jsx'], '.mjs': ['.mts', '.mjs'], '.cjs': ['.cts', '.cjs'] },
    conditionNames: ['node', 'import', 'require', 'module', 'browser', 'default'],
    mainFields: ['module', 'main'],
    mainFiles: ['index'],
    aliasFields: ['browser'],
    alias: workspaceAlias,
    roots: [root],
    symlinks: false,
    nodePath: false,
    builtinModules: false,
    allowPackageExportsInDirectoryResolve: true
  };
  const base = new oxc.ResolverFactory(baseOptions);
  const byConfig = new Map<string, OxcResolverFactory>();
  const resolverForConfig = (configFile: string): OxcResolverFactory => {
    let r = byConfig.get(configFile);
    if (r === undefined) {
      // An independent factory per tsconfig, not base.cloneWithOptions(): with the shared cache,
      // oxc-resolver 11.24.2 resolved `paths` specifiers in a big monorepo (superset) only when the
      // tsconfig resolver ran first; after earlier plain resolutions they failed (measured 2026-11-10).
      r = new oxc.ResolverFactory({ ...baseOptions, tsconfig: { configFile, references: 'auto' } });
      byConfig.set(configFile, r);
    }
    return r;
  };

  const nearest = <T>(map: Map<string, T>, fromFile: string): T | undefined => {
    let dir = path.posix.dirname(fromFile);
    for (;;) {
      const key = dir === '.' ? '' : dir;
      const hit = map.get(key);
      if (hit !== undefined) return hit;
      if (key === '') return undefined;
      dir = path.posix.dirname(dir);
    }
  };

  const outcome = (o: Partial<ResolveOutcome> & Pick<ResolveOutcome, 'resolution' | 'confidence'>): ResolveOutcome => ({
    toFile: null,
    packageName: null,
    subpath: null,
    isWorkspace: false,
    unresolvedReason: null,
    alias: null,
    ...o
  });

  const workspaceOf = (spec: string): WorkspacePackage | undefined => {
    const pkg = packageNameFromSpecifier(spec);
    return pkg === null ? undefined : workspaces.find((w) => w.name === pkg);
  };

  const classifyPath = (abs: string, spec: string, alias: string | null, viaAlias: boolean): ResolveOutcome => {
    const confidence: Confidence = viaAlias ? 'medium' : 'high';
    const nmPkg = packageFromNodeModulesPath(abs);
    if (nmPkg !== null) {
      return outcome({ resolution: 'external', packageName: nmPkg, subpath: subpathOf(spec, nmPkg), confidence, alias });
    }
    const rel = relInside(root, abs);
    if (rel === null) return outcome({ resolution: 'unresolved', unresolvedReason: 'outside-root', confidence: 'low', alias });
    const ws = isRelativeOrAbsolute(spec) ? undefined : workspaceOf(spec);
    if (ws !== undefined && (rel === ws.dir || rel.startsWith(`${ws.dir}/`))) {
      return outcome({ resolution: 'resolved', toFile: rel, packageName: ws.name, subpath: subpathOf(spec, ws.name), isWorkspace: true, confidence, alias });
    }
    return outcome({ resolution: 'resolved', toFile: rel, confidence, alias });
  };

  const oxcResolve = (fromFile: string, spec: string): ResolveResult => {
    const fromDir = path.join(root, path.posix.dirname(fromFile));
    const ts = nearest(tsconfigByDir, fromFile);
    if (ts !== undefined) {
      const r = resolverForConfig(ts.configFile).sync(fromDir, spec);
      if (r.path !== undefined) return r;
      // A broken tsconfig (e.g. an unresolvable `extends`) must not hide plain resolution.
      const plain = base.sync(fromDir, spec);
      return plain.path !== undefined ? plain : r;
    }
    return base.sync(fromDir, spec);
  };

  /**
   * Stylesheet targets (3a.6): Sass/Less resolve a bare `x/y` relative to the
   * file first, then as a package; `~pkg` is always a package. Local matches
   * use the Sass partial rules against the walked file set (no FS access).
   * Every style edge is `medium`: there is no real Sass/Less parser here.
   */
  const resolveStyle = (fromFile: string, spec: string): ResolveOutcome => {
    if (spec.startsWith('sass:')) return outcome({ resolution: 'builtin', confidence: 'medium' });
    if (isInterpolatedStyleSpecifier(spec)) {
      return outcome({ resolution: 'unresolved', unresolvedReason: 'interpolated-style', confidence: 'low' });
    }
    const tilde = spec.startsWith('~') && !spec.startsWith('~/');
    let s = (spec.startsWith('~/') ? spec.slice(1) : tilde ? spec.slice(1) : spec).replace(/[?#].*$/, '');
    let alias: string | null = null;
    const bases: string[] = [];
    const aliases = nearest(aliasByDir, fromFile);
    const m = aliases === undefined ? null : matchAlias(aliases.rules, s);
    if (m !== null) {
      alias = m.rule.key;
      if (path.isAbsolute(m.rewritten)) bases.push(m.rewritten);
      else s = m.rewritten;
    }
    if (bases.length === 0) {
      if (s.startsWith('/')) bases.push(path.join(root, s));
      else if (!tilde) bases.push(path.resolve(root, path.posix.dirname(fromFile), s));
    }
    for (const b of bases) {
      for (const cand of styleCandidates(b)) {
        const rel = relInside(root, cand);
        if (rel !== null && byPath.has(rel)) return outcome({ resolution: 'resolved', toFile: rel, confidence: 'medium', alias });
      }
    }
    if (!isRelativeOrAbsolute(s)) {
      const pkg = packageNameFromSpecifier(s);
      if (pkg !== null && NPM_NAME_RE.test(pkg)) {
        return outcome({ resolution: 'external', packageName: pkg, subpath: subpathOf(s, pkg), confidence: 'medium', alias });
      }
    }
    const outside = bases.length > 0 && bases.every((b) => relInside(root, b) === null);
    return outcome({ resolution: 'unresolved', unresolvedReason: outside ? 'outside-root' : 'not-found', confidence: 'low', alias });
  };

  const resolve = (req: ResolveRequest): ResolveOutcome => {
    // Bundler query suffixes (`./icon.svg?react`, `./x.css?inline`) are not part of the path.
    const spec = req.specifier === null ? null : stripQuery(req.specifier);
    if (req.kind === 'dynamic-expr' || spec === null) {
      return outcome({ resolution: 'unresolved', unresolvedReason: 'dynamic-expression', confidence: 'low' });
    }
    if (req.kind === 'style-import') return resolveStyle(req.fromFile, spec);
    if (isBuiltin(spec)) return outcome({ resolution: 'builtin', confidence: 'high' });
    if (URL_LIKE_RE.test(spec) && !path.isAbsolute(spec)) {
      return outcome({ resolution: 'unresolved', unresolvedReason: 'not-found', confidence: 'low' });
    }

    const aliases = nearest(aliasByDir, req.fromFile);
    if (aliases !== undefined) {
      const m = matchAlias(aliases.rules, spec);
      if (m !== null) {
        const toPath = path.isAbsolute(m.rewritten);
        const r = toPath ? base.sync(path.dirname(m.rewritten), m.rewritten) : oxcResolve(req.fromFile, m.rewritten);
        // Subpaths are measured on the rewritten specifier when the alias points at a package.
        if (r.path !== undefined) return classifyPath(r.path, toPath ? spec : m.rewritten, m.rule.key, true);
        const pkg = path.isAbsolute(m.rewritten) ? null : packageNameFromSpecifier(m.rewritten);
        if (pkg !== null && NPM_NAME_RE.test(pkg)) {
          return outcome({ resolution: 'external', packageName: pkg, subpath: subpathOf(m.rewritten, pkg), confidence: 'medium', alias: m.rule.key });
        }
        return outcome({ resolution: 'unresolved', unresolvedReason: 'not-found', confidence: 'low', alias: m.rule.key });
      }
    }

    const r = oxcResolve(req.fromFile, spec);
    if (r.path !== undefined) return classifyPath(r.path, spec, null, false);

    if (aliases !== undefined) {
      const u = matchUnreadable(aliases.unreadable, spec);
      if (u !== null) {
        // `react: path.resolve(rootDir, 'node_modules/react')` still means react: a package that
        // some package.json in the project depends on keeps its name (low). Anything else (`@/x`,
        // `~x`, a pseudo-package like `Components/…`) stays unresolved.
        const pkg = isRelativeOrAbsolute(spec) ? null : packageNameFromSpecifier(spec);
        if (pkg !== null && knownPackages.has(pkg)) {
          return outcome({ resolution: 'external', packageName: pkg, subpath: subpathOf(spec, pkg), confidence: 'low', alias: u.key });
        }
        return outcome({ resolution: 'unresolved', unresolvedReason: 'alias-unreadable', confidence: 'low', alias: u.key });
      }
    }
    if (isRelativeOrAbsolute(spec)) {
      const target = spec.startsWith('/') && !path.isAbsolute(spec) ? path.join(root, spec) : path.resolve(root, path.posix.dirname(req.fromFile), spec);
      const inside = relInside(root, target) !== null;
      return outcome({ resolution: 'unresolved', unresolvedReason: inside ? 'not-found' : 'outside-root', confidence: 'low' });
    }
    const ts = nearest(tsconfigByDir, req.fromFile);
    if (ts !== undefined && ts.pathPatterns.some(([pre, suf]) => spec.startsWith(pre) && spec.endsWith(suf) && spec.length >= pre.length + suf.length)) {
      return outcome({ resolution: 'unresolved', unresolvedReason: 'not-found', confidence: 'low' });
    }
    const pkg = packageNameFromSpecifier(spec);
    if (pkg !== null && NPM_NAME_RE.test(pkg)) {
      const ws = workspaces.find((w) => w.name === pkg);
      return outcome({ resolution: 'external', packageName: pkg, subpath: subpathOf(spec, pkg), isWorkspace: ws !== undefined, confidence: 'medium' });
    }
    return outcome({ resolution: 'unresolved', unresolvedReason: 'not-found', confidence: 'low' });
  };

  // ---- entry points from package.json main/module/bin/exports
  const entryPaths: string[] = [];
  for (const { dir, json } of pkgJsons) {
    const targets: string[] = [];
    for (const k of ['main', 'module', 'bin', 'exports']) stringLeaves(json[k], targets);
    for (const target of targets) {
      if (target.includes('*')) continue;
      const res = base.sync(path.join(root, dir), target.startsWith('.') ? target : `./${target}`);
      if (res.path === undefined) continue;
      const rel = relInside(root, res.path);
      if (rel !== null && !rel.split('/').includes('node_modules')) entryPaths.push(rel);
    }
  }

  const configFiles = [...read.keys()].sort();
  const hash = createHash('sha256');
  for (const key of configFiles) hash.update(`${key}\0${read.get(key)!}\0`);

  return {
    id: `oxc-resolver@${OXC_RESOLVER_VERSION}`,
    configHash: hash.digest('hex'),
    configFiles,
    declared,
    workspaces,
    unreadableAliases,
    entryPaths: sortedUnique(entryPaths),
    resolve
  };
}

/** Drops a `?query` suffix; a leading `?` or `#` (package imports) is left alone. */
function stripQuery(spec: string): string {
  const q = spec.indexOf('?');
  return q > 0 ? spec.slice(0, q) : spec;
}

/** Sass partial rules per extension: `_x.e`, `x.e`, `x/_index.e`, `x/index.e`; an explicit extension is tried as is first. */
function styleCandidates(base: string): string[] {
  const dir = path.dirname(base);
  const name = path.basename(base);
  const ext = path.extname(base).toLowerCase();
  if (STYLE_EXTS.includes(ext)) return [base, path.join(dir, `_${name}`)];
  const out: string[] = [];
  for (const e of ['.scss', '.sass', '.css', '.less']) {
    out.push(path.join(dir, `_${name}${e}`), path.join(dir, `${name}${e}`), path.join(base, `_index${e}`), path.join(base, `index${e}`));
  }
  return out;
}

/** `packages/*`, `apps/*`, exact dirs. Globs beyond a trailing `/*` (e.g. `**`) match nothing (documented gap). */
function expandWorkspacePatterns(patterns: readonly string[], files: readonly WalkEntry[]): string[] {
  const pkgDirs = files
    .filter((f) => path.posix.basename(f.path) === 'package.json' && f.path !== 'package.json')
    .map((f) => path.posix.dirname(f.path));
  const out = new Set<string>();
  for (const raw of patterns) {
    const p = raw.replace(/^\.\//, '').replace(/\/$/, '');
    if (p.endsWith('/*') && !p.slice(0, -2).includes('*')) {
      const prefix = p.slice(0, -2);
      for (const d of pkgDirs) if (path.posix.dirname(d) === prefix) out.add(d);
    } else if (!p.includes('*')) {
      if (pkgDirs.includes(p)) out.add(p);
    }
  }
  return [...out].sort();
}

/** Follows `extends` (relative and package) within the project to hash what oxc reads and collect `paths`. */
async function readTsconfigChain(
  abs: string,
  root: string,
  readConfig: (abs: string) => Promise<string | null>,
  patterns: Array<[string, string]>,
  depth: number
): Promise<void> {
  if (depth > MAX_EXTENDS_DEPTH) return;
  const text = await readConfig(abs);
  if (text === null) return;
  const json = parseJsonc(text);
  if (!isRecord(json)) return;
  const co = json.compilerOptions;
  if (isRecord(co) && isRecord(co.paths)) {
    for (const key of Object.keys(co.paths)) {
      const star = key.indexOf('*');
      patterns.push(star === -1 ? [key, ''] : [key.slice(0, star), key.slice(star + 1)]);
    }
  }
  const ext = json.extends;
  const list = typeof ext === 'string' ? [ext] : Array.isArray(ext) ? ext.filter((x): x is string => typeof x === 'string') : [];
  for (const e of list) {
    const target = locateExtends(e, path.dirname(abs), root);
    if (target !== null) await readTsconfigChain(target, root, readConfig, patterns, depth + 1);
  }
}

function locateExtends(spec: string, fromDir: string, root: string): string | null {
  const candidates: string[] = [];
  if (spec.startsWith('.') || path.isAbsolute(spec)) {
    const p = path.resolve(fromDir, spec);
    candidates.push(p, `${p}.json`);
  } else {
    let dir = fromDir;
    for (;;) {
      const base = path.join(dir, 'node_modules', spec);
      candidates.push(base, `${base}.json`, path.join(base, 'tsconfig.json'));
      if (relInside(root, dir) === '' || path.dirname(dir) === dir) break;
      dir = path.dirname(dir);
    }
  }
  for (const c of candidates) {
    if (relInside(root, c) === null) continue;
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      // not there; try the next candidate
    }
  }
  return null;
}
