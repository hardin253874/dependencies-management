/**
 * Ground truth for "files that use package X" (V2_STAGE3_SPEC 3b-B.1),
 * computed with the TypeScript compiler, independent of Babel and
 * oxc-resolver (the graph's parser and resolver).
 *
 * - File set: the §2 JS/TS walk rules, with the same skip constants as v1 and
 *   the graph (`ALWAYS_SKIP_DIRS` + `.gitignore` matcher, `.min.*`, 2 MB), so
 *   a difference against the graph reflects resolution, not walk policy. The
 *   walk is written out here on purpose (not `walkProject`), so a walk bug in
 *   the graph shows up as a miss instead of being copied into the truth.
 * - Imports per file: `ts.preProcessFile` (imports, `require`, literal
 *   `import()`, `export … from`, `import x = require()`).
 * - Resolution: `ts.resolveModuleName` with the NEAREST tsconfig/jsconfig
 *   (`extends` handled by `parseJsonConfigFileContent`), `allowJs` forced.
 * - `reexport`: one `ts.createProgram` per projectDir; each import binding's
 *   alias chain is followed with the checker until a package specifier.
 *
 * Read-only on the target: only `readFile`/`stat`/`readdir` under the root,
 * `.env*` names are never opened (the host refuses them), nothing is
 * executed and the program never emits (`writeFile` throws).
 */
import { existsSync, promises as fs, readFileSync, statSync } from 'fs';
import { isBuiltin } from 'module';
import path from 'path';
import ts from 'typescript';
// Relative imports on purpose (not `@/…`): see predict-v1.ts (R1).
import { atomicWriteJson } from '../../src/lib/storage/atomic';
import { buildIgnoreMatcher } from '../../src/lib/scanners/gitignore';
import { MAX_FILE_SIZE_BYTES, MIN_HEURISTIC_RE } from '../../src/lib/scanners/code';

/** Bump when the truth rules change: cached truth files with another version are rebuilt. */
export const TRUTH_VERSION = 2;
export const DEFAULT_REEXPORT_TIMEOUT_MS = 120_000;
const MAX_ALIAS_DEPTH = 32;

export const TRUTH_JS_EXTS: readonly string[] = Object.freeze(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts']);

/** Written into every truth file so a reader knows what the truth cannot see. */
export const TRUTH_LIMITATIONS: readonly string[] = Object.freeze([
  'TypeScript module resolution only: webpack/vite/next/craco aliases are invisible (such imports stay unresolved or are attributed by bare name).',
  'Style imports (@import/@use) and config references (babel/eslint/jest presets by name) are not imports to TypeScript.',
  'Without node_modules a bare specifier is attributed to a package by name; package "exports" subpaths are not verified.',
  'reexport: import bindings only (named, default, namespace, import-equals); CommonJS require destructuring is not followed.'
]);

export interface PackageTruth {
  direct: string[];
  reexport: string[];
}

export interface ProjectDirTruth {
  projectDir: string;
  files: number;
  /** Literal specifiers seen (all files). */
  specifiers: number;
  /** Relative/absolute specifiers TS could not resolve to a file. */
  unresolvedRelative: number;
  /** Bare specifiers attributed to a package by name only (no node_modules hit). */
  bareByName: number;
  reexportTruth: 'ok' | 'unavailable';
  timing: { directMs: number; reexportMs: number };
  /** package → files (projectDir-relative POSIX paths, sorted). */
  packages: Record<string, PackageTruth>;
}

export interface CaseTruthFile {
  truthVersion: number;
  caseId: string;
  baseCommit: string;
  tsVersion: string;
  generatedAt: string;
  limitations: readonly string[];
  projectDirs: ProjectDirTruth[];
}

// ---------------------------------------------------------------- walk

function isEnvName(name: string): boolean {
  return name.startsWith('.env');
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** JS/TS source files under `projectRoot` (POSIX, root-relative, sorted). */
export async function walkTruthFiles(projectRoot: string): Promise<string[]> {
  const root = path.resolve(projectRoot);
  const matcher = await buildIgnoreMatcher({ projectRoot: root });
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (isEnvName(e.name)) continue;
      const full = path.join(dir, e.name);
      if (matcher.isIgnored(full)) continue;
      // Symlinks are skipped outright (the graph follows only file links inside the root; none in the corpus).
      if (e.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      const lower = e.name.toLowerCase();
      if (!TRUTH_JS_EXTS.includes(path.extname(lower)) || MIN_HEURISTIC_RE.test(lower)) continue;
      const st = await fs.stat(full).catch(() => null);
      if (st === null || st.size > MAX_FILE_SIZE_BYTES) continue;
      out.push(toPosix(path.relative(root, full)));
    }
  }
  return out.sort();
}

// ---------------------------------------------------------------- resolution

export type TruthResolution =
  | { kind: 'file'; abs: string; rel: string }
  | { kind: 'package'; name: string; byName: boolean }
  | { kind: 'builtin' }
  | { kind: 'outside' }
  | { kind: 'unresolved'; relative: boolean };

const NPM_NAME_RE = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/i;

/** `lodash/fp` → `lodash`, `@a/b/c` → `@a/b`; null when not a valid npm name. */
export function packageNameOf(spec: string): string | null {
  const segs = spec.split('/');
  const name = spec.startsWith('@') ? (segs.length >= 2 ? `${segs[0]}/${segs[1]}` : '') : (segs[0] ?? '');
  return NPM_NAME_RE.test(name) ? name : null;
}

function isRelativeOrAbsolute(spec: string): boolean {
  return spec.startsWith('.') || spec.startsWith('/') || path.isAbsolute(spec) || /^[a-z]:[\\/]/i.test(spec);
}

function packageFromNodeModulesPath(p: string): string | null {
  const posix = p.split('\\').join('/');
  const idx = posix.lastIndexOf('/node_modules/');
  if (idx === -1) return null;
  return packageNameOf(posix.slice(idx + '/node_modules/'.length));
}

function isInside(child: string, root: string): boolean {
  const key = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rel = path.relative(key(root), key(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export class TruthReadGuardError extends Error {
  constructor(file: string) {
    super(`truth builder refused to read ${path.basename(file)} (.env files are never opened)`);
    this.name = 'TruthReadGuardError';
  }
}

/** File reads for the TS host: `.env*` names are refused, whatever asks. */
function guardedRead(file: string): string | undefined {
  if (isEnvName(path.basename(file))) throw new TruthReadGuardError(file);
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function guardedExists(file: string): boolean {
  if (isEnvName(path.basename(file))) return false;
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

const RESOLUTION_HOST: ts.ModuleResolutionHost = {
  fileExists: guardedExists,
  readFile: guardedRead,
  directoryExists: (d) => {
    try {
      return statSync(d).isDirectory();
    } catch {
      return false;
    }
  },
  realpath: (p) => p,
  getCurrentDirectory: () => process.cwd(),
  getDirectories: () => [],
  useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames
};

/** Config parsing never expands `include` globs (irrelevant for resolution, slow on big repos). */
const PARSE_HOST: ts.ParseConfigHost = {
  useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  readDirectory: () => [],
  fileExists: guardedExists,
  readFile: guardedRead
};

export const NO_CONFIG_OPTIONS: Readonly<ts.CompilerOptions> = Object.freeze({
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowJs: true,
  jsx: ts.JsxEmit.Preserve
});

interface ConfigEntry {
  id: number;
  options: ts.CompilerOptions;
  cache: ts.ModuleResolutionCache;
  /** `paths` keys turned into matchers: an unresolved specifier matching one is an alias miss, not a package. */
  pathPatterns: RegExp[];
  /**
   * Solution-style config (`"files": []` + `references`, e.g. Vite templates):
   * the referenced configs, each with the files its include/files select. A
   * file is resolved with the referenced config that contains it, as the TS
   * language service does.
   */
  refs?: Array<{ entry: ConfigEntry; files: ReadonlySet<string> }>;
}

/** Like PARSE_HOST but expands include globs (listing only; used for solution-style references). */
const LISTING_PARSE_HOST: ts.ParseConfigHost = {
  ...PARSE_HOST,
  readDirectory: (rootDir, extensions, excludes, includes, depth) =>
    ts.sys.readDirectory(rootDir, extensions, excludes, includes, depth).filter((f) => !isEnvName(path.basename(f)))
};

function fileKey(abs: string): string {
  const p = path.resolve(abs);
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function normaliseOptions(raw: ts.CompilerOptions): ts.CompilerOptions {
  const options: ts.CompilerOptions = { ...raw, allowJs: true, noEmit: true };
  const mr = options.moduleResolution;
  if (mr === undefined || mr === ts.ModuleResolutionKind.Classic) {
    // Classic never looks in node_modules and TS 6 drops it; legacy repos mean "node" here.
    options.moduleResolution = ts.ModuleResolutionKind.Bundler;
    options.module = ts.ModuleKind.ESNext;
  }
  return options;
}

function pathPatternsOf(options: ts.CompilerOptions): RegExp[] {
  return Object.keys(options.paths ?? {}).map((key) => {
    const escaped = key.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace('*', '.*');
    return new RegExp(`^${escaped}$`);
  });
}

export interface TsResolver {
  resolve(fromAbs: string, spec: string): TruthResolution;
  /** Nearest config's compiler options for a directory (used for the program). */
  optionsFor(dirAbs: string): ts.CompilerOptions;
}

export function createTsResolver(projectRoot: string): TsResolver {
  const root = path.resolve(projectRoot);
  const byConfigPath = new Map<string, ConfigEntry>();
  const configForDir = new Map<string, string | null>();
  const declaredForDir = new Map<string, ReadonlySet<string>>();
  const results = new Map<string, TruthResolution>();
  let nextId = 1;
  const noConfig: ConfigEntry = {
    id: 0,
    options: { ...NO_CONFIG_OPTIONS },
    cache: ts.createModuleResolutionCache(root, (s) => s, { ...NO_CONFIG_OPTIONS }),
    pathPatterns: []
  };

  const nearestConfigPath = (dir: string): string | null => {
    const hit = configForDir.get(dir);
    if (hit !== undefined) return hit;
    let found: string | null = null;
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const p = path.join(dir, name);
      if (existsSync(p)) {
        found = p;
        break;
      }
    }
    if (found === null && dir !== root && isInside(dir, root)) found = nearestConfigPath(path.dirname(dir));
    configForDir.set(dir, found);
    return found;
  };

  const loadConfig = (cfgPath: string, depth: number): ConfigEntry => {
    const known = byConfigPath.get(cfgPath);
    if (known !== undefined) return known;
    const read = ts.readConfigFile(cfgPath, (p) => guardedRead(p));
    const raw = (read.error === undefined ? read.config : {}) as { files?: unknown; include?: unknown };
    const isSolution = Array.isArray(raw.files) && raw.files.length === 0 && raw.include === undefined && depth < 3;
    const parsed =
      read.error !== undefined
        ? { options: {} as ts.CompilerOptions, projectReferences: undefined }
        : ts.parseJsonConfigFileContent(read.config, PARSE_HOST, path.dirname(cfgPath), undefined, cfgPath);
    const options = normaliseOptions(parsed.options);
    const entry: ConfigEntry = {
      id: nextId++,
      options,
      cache: ts.createModuleResolutionCache(path.dirname(cfgPath), (x) => x, options),
      pathPatterns: pathPatternsOf(options)
    };
    byConfigPath.set(cfgPath, entry);
    const references = parsed.projectReferences ?? [];
    if (isSolution && references.length > 0) {
      const refs: NonNullable<ConfigEntry['refs']> = [];
      for (const ref of references) {
        const refPath = ts.resolveProjectReferencePath(ref);
        if (!guardedExists(refPath)) continue;
        const refEntry = loadConfig(refPath, depth + 1);
        const refRead = ts.readConfigFile(refPath, (p) => guardedRead(p));
        const listed =
          refRead.error !== undefined
            ? []
            : ts.parseJsonConfigFileContent(refRead.config, LISTING_PARSE_HOST, path.dirname(refPath), undefined, refPath).fileNames;
        refs.push({ entry: refEntry, files: new Set(listed.map(fileKey)) });
      }
      entry.refs = refs;
    }
    return entry;
  };

  const entryForFile = (fileAbs: string): ConfigEntry => {
    const cfgPath = nearestConfigPath(path.dirname(fileAbs));
    if (cfgPath === null) return noConfig;
    const entry = loadConfig(cfgPath, 0);
    if (entry.refs === undefined || entry.refs.length === 0) return entry;
    const key = fileKey(fileAbs);
    const owner =
      entry.refs.find((r) => r.files.has(key)) ?? entry.refs.find((r) => r.entry.pathPatterns.length > 0) ?? entry.refs[0];
    return owner === undefined ? entry : owner.entry;
  };

  /** Packages named in the nearest package.json (decides `events` builtin vs npm polyfill). */
  const declaredFor = (dir: string): ReadonlySet<string> => {
    const hit = declaredForDir.get(dir);
    if (hit !== undefined) return hit;
    let names: ReadonlySet<string> = new Set();
    const pj = path.join(dir, 'package.json');
    if (existsSync(pj)) {
      try {
        const json = JSON.parse(readFileSync(pj, 'utf8')) as Record<string, unknown>;
        const all = new Set<string>();
        for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
          const deps = json[field];
          if (deps !== null && typeof deps === 'object') for (const k of Object.keys(deps)) all.add(k);
        }
        names = all;
      } catch {
        names = new Set();
      }
    } else if (dir !== root && isInside(dir, root)) {
      names = declaredFor(path.dirname(dir));
    }
    declaredForDir.set(dir, names);
    return names;
  };

  const classify = (fromAbs: string, spec: string, entry: ConfigEntry): TruthResolution => {
    const dir = path.dirname(fromAbs);
    const relative = isRelativeOrAbsolute(spec);
    if (spec.startsWith('node:')) return { kind: 'builtin' };
    const r = ts.resolveModuleName(spec, fromAbs, entry.options, RESOLUTION_HOST, entry.cache).resolvedModule;
    if (r !== undefined) {
      const fromNm = packageFromNodeModulesPath(r.resolvedFileName);
      if (r.isExternalLibraryImport === true || fromNm !== null) {
        const name = fromNm ?? packageNameOf(spec);
        return name === null ? { kind: 'unresolved', relative } : { kind: 'package', name, byName: false };
      }
      const abs = path.resolve(r.resolvedFileName);
      if (!isInside(abs, root)) return { kind: 'outside' };
      return { kind: 'file', abs, rel: toPosix(path.relative(root, abs)) };
    }
    if (relative) return { kind: 'unresolved', relative: true };
    if (entry.pathPatterns.some((re) => re.test(spec))) return { kind: 'unresolved', relative: false };
    const name = packageNameOf(spec);
    if (name === null) return { kind: 'unresolved', relative: false };
    if (isBuiltin(spec) && !declaredFor(dir).has(name)) return { kind: 'builtin' };
    return { kind: 'package', name, byName: true };
  };

  return {
    resolve(fromAbs, spec) {
      const entry = entryForFile(fromAbs);
      const key = `${entry.id}\0${path.dirname(fromAbs)}\0${spec}`;
      let hit = results.get(key);
      if (hit === undefined) {
        hit = classify(fromAbs, spec, entry);
        results.set(key, hit);
      }
      return hit;
    },
    optionsFor: (dirAbs) => entryForFile(path.join(dirAbs, '__truth_probe__.ts')).options
  };
}

// ---------------------------------------------------------------- direct truth

type PackageSets = Map<string, { direct: Set<string>; reexport: Set<string> }>;

function setsFor(map: PackageSets, pkg: string): { direct: Set<string>; reexport: Set<string> } {
  let s = map.get(pkg);
  if (s === undefined) {
    s = { direct: new Set(), reexport: new Set() };
    map.set(pkg, s);
  }
  return s;
}

interface DirectStats {
  specifiers: number;
  unresolvedRelative: number;
  bareByName: number;
}

function directTruth(root: string, files: readonly string[], resolver: TsResolver, sets: PackageSets): DirectStats {
  const stats: DirectStats = { specifiers: 0, unresolvedRelative: 0, bareByName: 0 };
  for (const rel of files) {
    const abs = path.join(root, rel);
    const text = guardedRead(abs);
    if (text === undefined) continue;
    const info = ts.preProcessFile(text, true, true);
    for (const imp of info.importedFiles) {
      stats.specifiers += 1;
      const r = resolver.resolve(abs, imp.fileName);
      if (r.kind === 'package') {
        setsFor(sets, r.name).direct.add(rel);
        if (r.byName) stats.bareByName += 1;
      } else if (r.kind === 'unresolved' && r.relative) {
        stats.unresolvedRelative += 1;
      }
    }
  }
  return stats;
}

// ---------------------------------------------------------------- reexport truth

function moduleSpecifierOf(decl: ts.Declaration): ts.Expression | undefined {
  if (ts.isImportSpecifier(decl)) return decl.parent.parent.parent.moduleSpecifier;
  if (ts.isImportClause(decl)) return decl.parent.moduleSpecifier;
  if (ts.isNamespaceImport(decl)) return decl.parent.parent.moduleSpecifier;
  if (ts.isExportSpecifier(decl)) return decl.parent.parent.moduleSpecifier;
  if (ts.isNamespaceExport(decl)) return decl.parent.moduleSpecifier;
  if (ts.isImportEqualsDeclaration(decl) && ts.isExternalModuleReference(decl.moduleReference)) {
    return decl.moduleReference.expression;
  }
  return undefined;
}

/** The export name an alias declaration asks its module for ('*' = whole module). */
function importedNameOf(decl: ts.Declaration): string {
  if (ts.isImportSpecifier(decl) || ts.isExportSpecifier(decl)) return (decl.propertyName ?? decl.name).text;
  if (ts.isImportClause(decl)) return 'default';
  return '*';
}

export class TruthTimeoutError extends Error {
  constructor() {
    super('reexport truth time box exceeded');
    this.name = 'TruthTimeoutError';
  }
}

interface ReexportCtx {
  root: string;
  program: ts.Program;
  checker: ts.TypeChecker;
  resolver: TsResolver;
  deadline: number;
}

function sourceFileOf(ctx: ReexportCtx, abs: string): ts.SourceFile | undefined {
  return ctx.program.getSourceFile(abs) ?? ctx.program.getSourceFile(abs.split(path.sep).join('/'));
}

function literalText(e: ts.Expression | undefined): string | null {
  return e !== undefined && ts.isStringLiteralLike(e) ? e.text : null;
}

/** `export * from` chains of a module that TS could not follow (target package not installed). */
function starPackages(ctx: ReexportCtx, fileAbs: string, name: string, depth: number, out: Map<string, number>, seen: Set<string>): void {
  if (name === 'default' || seen.has(fileAbs) || depth > MAX_ALIAS_DEPTH) return;
  seen.add(fileAbs);
  const sf = sourceFileOf(ctx, fileAbs);
  if (sf === undefined) return;
  for (const st of sf.statements) {
    if (!ts.isExportDeclaration(st) || st.exportClause !== undefined) continue;
    const spec = literalText(st.moduleSpecifier);
    if (spec === null) continue;
    const r = ctx.resolver.resolve(fileAbs, spec);
    if (r.kind === 'package') record(out, r.name, depth);
    else if (r.kind === 'file') starPackages(ctx, r.abs, name, depth + 1, out, seen);
  }
}

function record(out: Map<string, number>, pkg: string, depth: number): void {
  const cur = out.get(pkg);
  if (cur === undefined || depth < cur) out.set(pkg, depth);
}

/** Every package a module re-exports (namespace import fan-out). */
function fanOut(ctx: ReexportCtx, fileAbs: string, depth: number, out: Map<string, number>, seen: Set<ts.Symbol>): void {
  const sf = sourceFileOf(ctx, fileAbs);
  if (sf === undefined) return;
  const moduleSym = ctx.checker.getSymbolAtLocation(sf);
  if (moduleSym !== undefined) {
    for (const exp of ctx.checker.getExportsOfModule(moduleSym)) {
      if ((exp.flags & ts.SymbolFlags.Alias) !== 0) followAlias(ctx, exp, depth, out, seen);
    }
  }
  starPackages(ctx, fileAbs, '*', depth, out, new Set());
}

function followAlias(ctx: ReexportCtx, sym: ts.Symbol, depth: number, out: Map<string, number>, seen: Set<ts.Symbol>): void {
  if (seen.has(sym) || depth > MAX_ALIAS_DEPTH) return;
  seen.add(sym);
  if (Date.now() > ctx.deadline) throw new TruthTimeoutError();
  for (const decl of sym.declarations ?? []) {
    const declFile = path.resolve(decl.getSourceFile().fileName);
    const spec = literalText(moduleSpecifierOf(decl));
    if (spec === null) {
      // `export { x }`, `export default x`, `export = x`: the alias points at a local binding.
      const target = safeImmediate(ctx, sym);
      if (target !== undefined && (target.flags & ts.SymbolFlags.Alias) !== 0) followAlias(ctx, target, depth, out, seen);
      continue;
    }
    const r = ctx.resolver.resolve(declFile, spec);
    if (r.kind === 'package') {
      record(out, r.name, depth);
      continue;
    }
    if (r.kind !== 'file') continue;
    const name = importedNameOf(decl);
    if (name === '*') {
      fanOut(ctx, r.abs, depth + 1, out, seen);
      continue;
    }
    const target = safeImmediate(ctx, sym);
    if (target === undefined || (target.declarations ?? []).length === 0) {
      starPackages(ctx, r.abs, name, depth + 1, out, new Set());
    } else if ((target.flags & ts.SymbolFlags.Alias) !== 0) {
      followAlias(ctx, target, depth + 1, out, seen);
    }
  }
}

function safeImmediate(ctx: ReexportCtx, sym: ts.Symbol): ts.Symbol | undefined {
  try {
    return ctx.checker.getImmediateAliasedSymbol(sym);
  } catch {
    return undefined;
  }
}

function bindingNames(sf: ts.SourceFile): ts.Identifier[] {
  const out: ts.Identifier[] = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && st.importClause !== undefined) {
      const c = st.importClause;
      if (c.name !== undefined) out.push(c.name);
      const nb = c.namedBindings;
      if (nb !== undefined) {
        if (ts.isNamespaceImport(nb)) out.push(nb.name);
        else for (const el of nb.elements) out.push(el.name);
      }
    } else if (ts.isImportEqualsDeclaration(st) && ts.isExternalModuleReference(st.moduleReference)) {
      out.push(st.name);
    }
  }
  return out;
}

function createReadOnlyHost(options: ts.CompilerOptions, root: string, resolver: TsResolver): ts.CompilerHost {
  const host = ts.createCompilerHost(options, true);
  host.readFile = (f) => guardedRead(f);
  host.fileExists = guardedExists;
  host.writeFile = () => {
    throw new Error('truth builder never writes');
  };
  host.resolveModuleNameLiterals = (literals, containingFile) =>
    literals.map((lit) => {
      const r = resolver.resolve(path.resolve(containingFile), lit.text);
      if (r.kind !== 'file' || !isInside(r.abs, root)) return { resolvedModule: undefined };
      return {
        resolvedModule: {
          resolvedFileName: r.abs.split(path.sep).join('/'),
          extension: extensionOf(r.abs),
          isExternalLibraryImport: false
        }
      };
    });
  return host;
}

function extensionOf(abs: string): ts.Extension {
  const lower = abs.toLowerCase();
  if (lower.endsWith('.d.ts')) return ts.Extension.Dts;
  if (lower.endsWith('.d.mts')) return ts.Extension.Dmts;
  if (lower.endsWith('.d.cts')) return ts.Extension.Dcts;
  const map: Record<string, ts.Extension> = {
    '.ts': ts.Extension.Ts,
    '.tsx': ts.Extension.Tsx,
    '.js': ts.Extension.Js,
    '.jsx': ts.Extension.Jsx,
    '.mjs': ts.Extension.Mjs,
    '.cjs': ts.Extension.Cjs,
    '.mts': ts.Extension.Mts,
    '.cts': ts.Extension.Cts,
    '.json': ts.Extension.Json
  };
  return map[path.extname(lower)] ?? ts.Extension.Ts;
}

function reexportTruth(root: string, files: readonly string[], resolver: TsResolver, timeoutMs: number, sets: PackageSets): boolean {
  const deadline = Date.now() + timeoutMs;
  const options: ts.CompilerOptions = {
    ...resolver.optionsFor(root),
    noEmit: true,
    noLib: true,
    types: [],
    skipLibCheck: true,
    allowJs: true,
    checkJs: false
  };
  const program = ts.createProgram({
    rootNames: files.map((f) => path.join(root, f).split(path.sep).join('/')),
    options,
    host: createReadOnlyHost(options, root, resolver)
  });
  const ctx: ReexportCtx = { root, program, checker: program.getTypeChecker(), resolver, deadline };
  try {
    for (const rel of files) {
      if (Date.now() > deadline) throw new TruthTimeoutError();
      const sf = sourceFileOf(ctx, path.join(root, rel));
      if (sf === undefined) continue;
      const found = new Map<string, number>();
      for (const id of bindingNames(sf)) {
        const sym = ctx.checker.getSymbolAtLocation(id);
        if (sym === undefined || (sym.flags & ts.SymbolFlags.Alias) === 0) continue;
        followAlias(ctx, sym, 0, found, new Set());
      }
      for (const [pkg, depth] of found) if (depth >= 1) setsFor(sets, pkg).reexport.add(rel);
    }
  } catch (e) {
    if (e instanceof TruthTimeoutError) return false;
    throw e;
  }
  return true;
}

// ---------------------------------------------------------------- entry points

export interface BuildTruthOptions {
  projectRoot: string;
  projectDir: string;
  reexportTimeoutMs?: number;
}

export async function buildProjectDirTruth(opts: BuildTruthOptions): Promise<ProjectDirTruth> {
  const root = path.resolve(opts.projectRoot);
  const files = await walkTruthFiles(root);
  const resolver = createTsResolver(root);
  const sets: PackageSets = new Map();

  const t0 = Date.now();
  const stats = directTruth(root, files, resolver, sets);
  const directMs = Date.now() - t0;

  const t1 = Date.now();
  const ok = reexportTruth(root, files, resolver, opts.reexportTimeoutMs ?? DEFAULT_REEXPORT_TIMEOUT_MS, sets);
  const reexportMs = Date.now() - t1;

  const packages: Record<string, PackageTruth> = {};
  for (const name of [...sets.keys()].sort()) {
    const s = sets.get(name) as { direct: Set<string>; reexport: Set<string> };
    packages[name] = { direct: [...s.direct].sort(), reexport: ok ? [...s.reexport].sort() : [] };
  }
  return {
    projectDir: opts.projectDir,
    files: files.length,
    specifiers: stats.specifiers,
    unresolvedRelative: stats.unresolvedRelative,
    bareByName: stats.bareByName,
    reexportTruth: ok ? 'ok' : 'unavailable',
    timing: { directMs, reexportMs },
    packages
  };
}

export function truthCachePath(cacheDir: string, caseId: string, baseCommit: string): string {
  return path.join(cacheDir, '_graph-truth', `${caseId}@${baseCommit}.json`);
}

function isUsableCache(x: unknown, caseId: string, baseCommit: string, projectDirs: readonly string[]): x is CaseTruthFile {
  if (x === null || typeof x !== 'object') return false;
  const f = x as Partial<CaseTruthFile>;
  return (
    f.truthVersion === TRUTH_VERSION &&
    f.tsVersion === ts.version &&
    f.caseId === caseId &&
    f.baseCommit === baseCommit &&
    Array.isArray(f.projectDirs) &&
    f.projectDirs.map((d) => d.projectDir).join('\n') === projectDirs.join('\n')
  );
}

export interface CaseTruthOptions {
  cacheDir: string;
  /** The pinned clone; must lie under `cacheDir` (never the source repo). */
  cloneDir: string;
  caseId: string;
  baseCommit: string;
  projectDirs: readonly string[];
  refresh?: boolean;
  reexportTimeoutMs?: number;
  now?: () => Date;
}

/** Truth per projectDir, cached in `<cache>/_graph-truth/` (cache dir only; never the clone, never the repo). */
export async function loadOrBuildCaseTruth(opts: CaseTruthOptions): Promise<{ truth: CaseTruthFile; cached: boolean }> {
  const target = truthCachePath(opts.cacheDir, opts.caseId, opts.baseCommit);
  if (!isInside(path.resolve(opts.cloneDir), path.resolve(opts.cacheDir))) {
    throw new Error(`refusing to build truth for ${opts.caseId}: the clone is not under the eval cache`);
  }
  if (opts.refresh !== true) {
    try {
      const parsed = JSON.parse(await fs.readFile(target, 'utf8')) as unknown;
      if (isUsableCache(parsed, opts.caseId, opts.baseCommit, opts.projectDirs)) return { truth: parsed, cached: true };
    } catch {
      // missing or unreadable → rebuild
    }
  }
  const projectDirs: ProjectDirTruth[] = [];
  for (const projectDir of opts.projectDirs) {
    projectDirs.push(
      await buildProjectDirTruth({
        projectRoot: path.join(opts.cloneDir, projectDir),
        projectDir,
        ...(opts.reexportTimeoutMs !== undefined ? { reexportTimeoutMs: opts.reexportTimeoutMs } : {})
      })
    );
  }
  const truth: CaseTruthFile = {
    truthVersion: TRUTH_VERSION,
    caseId: opts.caseId,
    baseCommit: opts.baseCommit,
    tsVersion: ts.version,
    generatedAt: (opts.now ?? (() => new Date()))().toISOString(),
    limitations: TRUTH_LIMITATIONS,
    projectDirs
  };
  await atomicWriteJson(target, truth);
  return { truth, cached: false };
}
