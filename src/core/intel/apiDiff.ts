/**
 * Package API diff (V2_STAGE4_SPEC 4a.4, design §9.1, D4 option D).
 *
 * For `pkg@from → pkg@to`: fetch both packuments + tarballs (injected
 * fetchers that own their timeouts), keep only `.d.ts`/`.d.mts`/`.d.cts` +
 * package.json in memory (`tarball.ts`), fall back to the matching
 * `@types/<pkg>` (highest version with the same major.minor) when the package
 * ships no types, read the exported surface with the TypeScript compiler API
 * over an in-memory host, and diff it:
 *   removed / signatureChanged / added / renamedCandidate (low confidence).
 *
 * Never installs, never runs scripts, never writes outside the cache dir.
 * Successful results are cached as envelopes (`ttlHours: null`, versions are immutable).
 */
import path from 'path';
import semver from 'semver';
import type * as TS from 'typescript';
import { readEnvelope, writeEnvelope } from '../../lib/storage/envelope';
import { readTypesFromTarball } from './tarball';
import type { IntelContext, PackumentLike, PackumentVersionLike } from '../agent/types';

/** Bump when the surface extraction or diff output changes for the same input. */
export const API_DIFF_VERSION = 1;
const SIGNATURE_MAX_CHARS = 300;

export interface ApiExport {
  name: string;
  kind: string;
  signature: string;
}

export interface TypesSource {
  package: string;
  version: string;
  entry: string;
  via: 'own' | '@types';
}

export type ApiDiffResult =
  | {
      status: 'ok';
      pkg: string;
      from: string;
      to: string;
      sources: { from: TypesSource; to: TypesSource };
      removed: ApiExport[];
      signatureChanged: Array<{ name: string; kind: string; from: string; to: string }>;
      added: ApiExport[];
      /**
       * Exact-signature heuristic (`confidence: 'low'`); v2 Stage 5b J4 adds
       * Jev's choice (`source: 'jev'`, numeric confidence) for removed exports
       * the heuristic did not match. Never persisted in the api_diff cache.
       */
      renamedCandidate: Array<{ from: string; to: string; confidence: 'low' } | { from: string; to: string; confidence: number; source: 'jev' }>;
    }
  | { status: 'unavailable'; pkg: string; from: string; to: string; reason: string };

export class ApiDiffUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiDiffUnavailable';
  }
}

export function typesPackageName(pkg: string): string {
  return pkg.startsWith('@') ? `@types/${pkg.slice(1).replace('/', '__')}` : `@types/${pkg}`;
}

/** `types`/`typings`, then `exports['.']` conditions, then `index.d.ts`. */
export function typesEntryOf(manifest: PackumentVersionLike | null, files: ReadonlyMap<string, string>): string | null {
  const candidates: string[] = [];
  if (manifest !== null) {
    if (typeof manifest.types === 'string') candidates.push(manifest.types);
    if (typeof manifest.typings === 'string') candidates.push(manifest.typings);
    const dot = (manifest.exports as Record<string, unknown> | undefined)?.['.'] ?? manifest.exports;
    const visit = (v: unknown, depth: number) => {
      if (depth > 4 || v === null || typeof v !== 'object') return;
      const o = v as Record<string, unknown>;
      if (typeof o.types === 'string') candidates.push(o.types);
      for (const key of ['import', 'require', 'default', 'node']) visit(o[key], depth + 1);
    };
    visit(dot, 0);
  }
  candidates.push('index.d.ts');
  for (const c of candidates) {
    const rel = path.posix.normalize(c.replace(/^\.\//, ''));
    if (files.has(rel)) return rel;
    if (!/\.d\.[cm]?ts$/.test(rel)) {
      for (const ext of ['.d.ts', '/index.d.ts']) if (files.has(rel.replace(/\.[cm]?js$/, '') + ext)) return rel.replace(/\.[cm]?js$/, '') + ext;
    }
  }
  return null;
}

async function loadTs(): Promise<typeof TS> {
  // Lazy: the compiler is ~10 MB and only this tool needs it.
  const mod = (await import('typescript')) as unknown as { default?: typeof TS } & typeof TS;
  return mod.default ?? mod;
}

function normalizeDecl(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}();,:<>|&=?[\]])\s*/g, '$1')
    .trim();
}

/** Exported names → normalized declaration text, from an in-memory .d.ts set. */
export async function exportedSurface(files: ReadonlyMap<string, string>, entry: string, moduleName: string): Promise<Map<string, ApiExport>> {
  const ts = await loadTs();
  const root = '/pkg/';
  const abs = (rel: string) => root + rel;
  const relOf = (f: string) => f.replace(/\\/g, '/').replace(/^\/pkg\//, '');
  const host: TS.CompilerHost = {
    fileExists: (f) => files.has(relOf(f)),
    readFile: (f) => files.get(relOf(f)),
    getSourceFile: (f, lang) => {
      const text = files.get(relOf(f));
      return text === undefined ? undefined : ts.createSourceFile(f, text, lang, true);
    },
    getDefaultLibFileName: () => '/__nolib.d.ts',
    writeFile: () => undefined,
    getCurrentDirectory: () => '/pkg',
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    directoryExists: (d) => {
      const prefix = relOf(d).replace(/\/$/, '');
      return prefix === '' || [...files.keys()].some((k) => k.startsWith(`${prefix}/`));
    },
    getDirectories: () => []
  };
  const program = ts.createProgram({
    rootNames: [abs(entry)],
    options: { noLib: true, noEmit: true, types: [], skipLibCheck: true, moduleResolution: ts.ModuleResolutionKind.Node10, target: ts.ScriptTarget.ES2020 },
    host
  });
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(abs(entry));
  if (sf === undefined) throw new ApiDiffUnavailable(`types entry ${entry} could not be loaded`);
  let moduleSymbol = checker.getSymbolAtLocation(sf);
  if (moduleSymbol === undefined) {
    // Global-script .d.ts with `declare module "pkg" { … }` (older @types style).
    moduleSymbol = checker.getAmbientModules().find((m) => m.getName().replace(/^"|"$/g, '') === moduleName);
  }
  if (moduleSymbol === undefined) throw new ApiDiffUnavailable(`${entry} exports nothing`);
  const out = new Map<string, ApiExport>();
  for (const sym of checker.getExportsOfModule(moduleSymbol)) {
    const target = (sym.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(sym) : sym;
    const decls = target.declarations ?? [];
    const kind = decls.length > 0 ? ts.SyntaxKind[decls[0]!.kind] : 'unknown';
    const signature =
      (target.flags & ts.SymbolFlags.Module) !== 0 && (target.flags & (ts.SymbolFlags.Function | ts.SymbolFlags.Class | ts.SymbolFlags.Variable)) === 0
        ? 'namespace'
        : decls.map((d) => normalizeDecl(d.getText())).sort().join(' | ');
    out.set(sym.getName(), { name: sym.getName(), kind, signature });
  }
  return out;
}

export function diffSurfaces(from: Map<string, ApiExport>, to: Map<string, ApiExport>): Pick<Extract<ApiDiffResult, { status: 'ok' }>, 'removed' | 'signatureChanged' | 'added' | 'renamedCandidate'> {
  const clip = (s: string) => (s.length <= SIGNATURE_MAX_CHARS ? s : `${s.slice(0, SIGNATURE_MAX_CHARS - 1)}…`);
  const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const removed = [...from.values()].filter((e) => !to.has(e.name)).sort(byName);
  const added = [...to.values()].filter((e) => !from.has(e.name)).sort(byName);
  const signatureChanged = [...from.values()]
    .filter((e) => to.has(e.name) && to.get(e.name)!.signature !== e.signature)
    .sort(byName)
    .map((e) => ({ name: e.name, kind: e.kind, from: clip(e.signature), to: clip(to.get(e.name)!.signature) }));
  const renamedCandidate: Array<{ from: string; to: string; confidence: 'low' }> = [];
  const strip = (e: ApiExport) => e.signature.split(e.name).join('§');
  for (const r of removed) {
    const match = added.find((a) => a.kind === r.kind && strip(a) === strip(r));
    if (match !== undefined) renamedCandidate.push({ from: r.name, to: match.name, confidence: 'low' });
  }
  return {
    removed: removed.map((e) => ({ ...e, signature: clip(e.signature) })),
    signatureChanged,
    added: added.map((e) => ({ ...e, signature: clip(e.signature) })),
    renamedCandidate
  };
}

function pickTypesVersion(packument: PackumentLike, version: string): string | null {
  const v = semver.parse(version);
  if (v === null) return null;
  const same = Object.keys(packument.versions ?? {}).filter((t) => {
    const p = semver.parse(t);
    return p !== null && p.prerelease.length === 0 && p.major === v.major && p.minor === v.minor;
  });
  return same.length === 0 ? null : semver.rsort(same)[0]!;
}

async function loadVersionTypes(
  intel: Required<Pick<IntelContext, 'fetchPackument' | 'fetchTarball'>>,
  pkg: string,
  packument: PackumentLike,
  version: string,
  signal?: AbortSignal
): Promise<{ source: TypesSource; files: Map<string, string> }> {
  const v = packument.versions?.[version];
  if (v === undefined) throw new ApiDiffUnavailable(`${pkg}@${version} is not in the registry`);
  if (v.dist?.tarball === undefined) throw new ApiDiffUnavailable(`${pkg}@${version} has no tarball`);
  const files = readTypesFromTarball(await intel.fetchTarball(v.dist.tarball, signal));
  const manifest = files.has('package.json') ? (JSON.parse(files.get('package.json')!) as PackumentVersionLike) : v;
  const entry = typesEntryOf(manifest, files);
  if (entry !== null) return { source: { package: pkg, version, entry, via: 'own' }, files };

  const typesName = typesPackageName(pkg);
  let typesPackument: PackumentLike;
  try {
    typesPackument = await intel.fetchPackument(typesName, signal);
  } catch {
    throw new ApiDiffUnavailable(`${pkg}@${version} ships no types and ${typesName} could not be fetched`);
  }
  const typesVersion = pickTypesVersion(typesPackument, version);
  if (typesVersion === null) throw new ApiDiffUnavailable(`${pkg}@${version} ships no types and no ${typesName} ${semver.major(version)}.${semver.minor(version)}.x exists`);
  const tv = typesPackument.versions![typesVersion]!;
  if (tv.dist?.tarball === undefined) throw new ApiDiffUnavailable(`${typesName}@${typesVersion} has no tarball`);
  const typesFiles = readTypesFromTarball(await intel.fetchTarball(tv.dist.tarball, signal));
  const typesManifest = typesFiles.has('package.json') ? (JSON.parse(typesFiles.get('package.json')!) as PackumentVersionLike) : tv;
  const typesEntry = typesEntryOf(typesManifest, typesFiles);
  if (typesEntry === null) throw new ApiDiffUnavailable(`${typesName}@${typesVersion} has no types entry`);
  return { source: { package: typesName, version: typesVersion, entry: typesEntry, via: '@types' }, files: typesFiles };
}

export function apiDiffCacheFile(cacheDir: string, pkg: string, from: string, to: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._@-]/g, '_');
  return path.join(cacheDir, `${safe(pkg.replace('/', '__'))}@${safe(from)}..${safe(to)}.v${API_DIFF_VERSION}.json`);
}

export async function computeApiDiff(intel: IntelContext, pkg: string, from: string, to: string, signal?: AbortSignal): Promise<ApiDiffResult> {
  const cacheFile = intel.apiDiffCacheDir !== undefined ? apiDiffCacheFile(intel.apiDiffCacheDir, pkg, from, to) : null;
  if (cacheFile !== null) {
    try {
      return (await readEnvelope<ApiDiffResult>(cacheFile)).data;
    } catch {
      // cache miss (or unreadable cache file): compute below
    }
  }
  if (intel.fetchPackument === undefined || intel.fetchTarball === undefined) {
    return { status: 'unavailable', pkg, from, to, reason: 'registry access is not available in this run' };
  }
  const fetchers = { fetchPackument: intel.fetchPackument, fetchTarball: intel.fetchTarball };
  let result: ApiDiffResult;
  try {
    const packument = await fetchers.fetchPackument(pkg, signal);
    const a = await loadVersionTypes(fetchers, pkg, packument, from, signal);
    const b = await loadVersionTypes(fetchers, pkg, packument, to, signal);
    const surfaceFrom = await exportedSurface(a.files, a.source.entry, pkg);
    const surfaceTo = await exportedSurface(b.files, b.source.entry, pkg);
    result = { status: 'ok', pkg, from, to, sources: { from: a.source, to: b.source }, ...diffSurfaces(surfaceFrom, surfaceTo) };
  } catch (err) {
    if (!(err instanceof ApiDiffUnavailable)) throw err;
    result = { status: 'unavailable', pkg, from, to, reason: err.message };
  }
  // Only successful diffs are cached: "unavailable" can come from a transient registry failure.
  if (cacheFile !== null && result.status === 'ok') await writeEnvelope(cacheFile, { source: 'registry', ttlHours: null, data: result });
  return result;
}
