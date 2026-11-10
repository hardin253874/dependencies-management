/**
 * Graph build orchestration (V2_STAGE3_SPEC 3a.7/3a.8, design §7):
 * walk → read + parse → resolve → ONE write transaction → recompute reach.
 *
 * - Read-only on the target: only readdir/stat/realpath/readFile under the
 *   project root; the DB must live outside it (store.ts refuses otherwise).
 *   Nothing is executed.
 * - Runs inside the injected `lock(key, fn)`. The app passes
 *   `withProjectLock` and `graph:<slug>`, so a long build does not block
 *   `project.json` writers; tests/eval pass a trivial lock.
 * - CPU work yields to the event loop every YIELD_EVERY files so a server
 *   running the build in a job stays responsive. `signal` aborts before the
 *   write transaction: an aborted build leaves the DB untouched.
 */
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { detectLockfile, parseLockfile } from '../../lib/scanners/lockfile';
import { configInfo, jsConfigInfo } from './configFiles';
import { extractConfigRefs } from './configRefs';
import { babelParser, fileRole, type ParsedFile, type ParsedImport, type ParserAdapter } from './parse';
import { pruneOrphans, recomputeReach, relinkSymbols } from './reach';
import { createResolverContext, type ResolveOutcome, type ResolverContext } from './resolve';
import { createRows, type EdgeRow, type FileRow, type GraphRows } from './rows';
import { openGraphWriter, type GraphDriver, type RebuildReason } from './store';
import { parseStyleImports } from './style';
import { walkProject, type WalkEntry } from './walk';

export const YIELD_EVERY = 50;

export type BuildMode = 'full' | 'incremental';

export type GraphLock = <T>(key: string, fn: () => Promise<T>) => Promise<T>;

export interface BuildProgress {
  phase: 'walk' | 'parse' | 'resolve' | 'write';
  current: number;
  total: number;
}

export interface BuildGraphOptions {
  projectRoot: string;
  dbPath: string;
  /** 'auto' = full when there is no usable graph yet, else incremental. */
  mode: 'full' | 'auto';
  lock: GraphLock;
  /** Lock key; the app passes `graph:<slug>`. Default: `graph:<resolved dbPath>`. */
  lockKey?: string;
  onProgress?: (p: BuildProgress) => void;
  signal?: AbortSignal;
  /** Parser override (tests); defaults to the Babel adapter. */
  parser?: ParserAdapter;
  /** SQLite busy timeout for the writer (default 5000 ms). */
  busyTimeoutMs?: number;
}

export interface BuildGraphResult {
  mode: BuildMode;
  files: number;
  edges: number;
  unresolved: number;
  durationMs: number;
  /** Set when the DB itself was (re)created on this run. */
  rebuildReason?: RebuildReason;
  /** Incremental only: files re-parsed, added or removed. */
  filesChanged?: number;
}

/** One analysed source file, ready to write. */
interface FileAnalysis {
  entry: WalkEntry;
  hash: string | null;
  parseError: string | null;
  imports: Array<{ imp: ParsedImport; outcome: ResolveOutcome }>;
  parsed: ParsedFile | null;
}

function abortError(): Error {
  const err = new Error('graph build aborted');
  err.name = 'AbortError';
  return err;
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError();
}

function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function sha1(buf: Buffer | string): string {
  return createHash('sha1').update(buf).digest('hex');
}

export function projectRootHash(projectRoot: string): string {
  return createHash('sha256').update(path.resolve(projectRoot)).digest('hex');
}

async function lockfileStateHash(projectRoot: string): Promise<string> {
  try {
    const detected = await detectLockfile(projectRoot);
    if (detected === null) return '';
    return (await parseLockfile(detected)).lockfileStateHash;
  } catch {
    // An unparseable lockfile must not fail the build; '' still changes the hash when it is fixed.
    return 'unreadable';
  }
}

const EMPTY_PARSE: ParsedFile = { imports: [], exports: [], reexports: [], usages: [], hasExports: false, parseError: null };

/** Parse one file's content into imports (JS, style, config refs) — no resolution yet. */
export function analyseSource(entry: WalkEntry, text: string, parser: ParserAdapter, declared: readonly string[]): ParsedFile {
  if (entry.kind === 'style') return { ...EMPTY_PARSE, imports: parseStyleImports(text) };
  const out: ParsedFile = entry.kind === 'js' ? parser.parse(text, entry.path) : { ...EMPTY_PARSE, imports: [] };
  const info = entry.kind === 'js' ? jsConfigInfo(entry.path) : configInfo(entry.path);
  if (info !== null) {
    const refs = extractConfigRefs({ relPath: entry.path, source: text, info, declared });
    out.imports = [
      ...out.imports,
      ...refs.map((r) => ({
        specifier: r.specifier,
        kind: 'config-ref' as const,
        bindings: [],
        line: r.line,
        col: r.col,
        snippet: r.snippet,
        configPackage: r.packageName,
        configConfidence: r.confidence
      }))
    ];
  }
  return out;
}

type ConfigImport = ParsedImport & { configPackage?: string; configConfidence?: ResolveOutcome['confidence'] };

export function resolveImport(ctx: ResolverContext, fromFile: string, imp: ConfigImport): ResolveOutcome {
  if (imp.kind === 'config-ref' && imp.configPackage !== undefined) {
    return {
      resolution: 'external',
      toFile: null,
      packageName: imp.configPackage,
      subpath: null,
      isWorkspace: ctx.workspaces.some((w) => w.name === imp.configPackage),
      confidence: imp.configConfidence ?? 'low',
      unresolvedReason: null,
      alias: null
    };
  }
  return ctx.resolve({ fromFile, specifier: imp.specifier, kind: imp.kind });
}

async function analyseFiles(
  entries: readonly WalkEntry[],
  ctx: ResolverContext,
  parser: ParserAdapter,
  opts: Pick<BuildGraphOptions, 'onProgress' | 'signal'>
): Promise<FileAnalysis[]> {
  const out: FileAnalysis[] = [];
  let i = 0;
  for (const entry of entries) {
    i += 1;
    if (i % YIELD_EVERY === 0) {
      await yieldToLoop();
      checkAbort(opts.signal);
    }
    opts.onProgress?.({ phase: 'parse', current: i, total: entries.length });
    checkAbort(opts.signal);
    if (entry.skipReason !== null) {
      out.push({ entry, hash: null, parseError: null, imports: [], parsed: null });
      continue;
    }
    let buf: Buffer;
    try {
      buf = await fs.readFile(entry.absPath);
    } catch (err) {
      out.push({ entry, hash: null, parseError: `read failed: ${(err as Error).message}`, imports: [], parsed: null });
      continue;
    }
    const parsed = analyseSource(entry, buf.toString('utf8'), parser, ctx.declared);
    out.push({
      entry,
      hash: sha1(buf),
      parseError: parsed.parseError,
      parsed,
      imports: parsed.imports.map((imp) => ({ imp, outcome: resolveImport(ctx, entry.path, imp) }))
    });
  }
  return out;
}

interface WriteMaps {
  fileIds: Map<string, number>;
  packageIds: Map<string, number>;
}

function packageId(rows: GraphRows, maps: WriteMaps, ctx: ResolverContext, name: string): number {
  let id = maps.packageIds.get(name);
  if (id === undefined) {
    id = rows.upsertPackage(name, { declared: ctx.declared.includes(name), isWorkspace: ctx.workspaces.some((w) => w.name === name) });
    maps.packageIds.set(name, id);
  }
  return id;
}

/** Inserts one file's edges, bindings, re-exports, export symbols and usages. */
function writeFileContent(rows: GraphRows, maps: WriteMaps, ctx: ResolverContext, fileId: number, a: FileAnalysis): void {
  const edgeIds: number[] = [];
  const bindingIds = new Map<string, number>();
  a.imports.forEach(({ imp, outcome }, idx) => {
    const edgeId = rows.insertEdge({
      fromFile: fileId,
      specifier: imp.specifier ?? '',
      kind: imp.kind,
      toFile: outcome.toFile === null ? null : (maps.fileIds.get(outcome.toFile) ?? null),
      toPackage: outcome.packageName === null ? null : packageId(rows, maps, ctx, outcome.packageName),
      subpath: outcome.subpath,
      resolution: outcome.resolution,
      confidence: outcome.confidence,
      unresolvedReason: outcome.unresolvedReason,
      alias: outcome.alias,
      line: imp.line,
      col: imp.col,
      snippet: imp.snippet
    });
    edgeIds.push(edgeId);
    for (const b of imp.bindings) {
      const bid = rows.insertBinding({ edgeId, localName: b.local, importedName: b.imported, importedSymbol: null, isType: b.isType });
      bindingIds.set(`${idx}\0${b.local}`, bid);
    }
  });
  const parsed = a.parsed;
  if (parsed === null) return;
  const exported = new Set(parsed.exports);
  for (const r of parsed.reexports) if (r.exported !== '*') exported.add(r.exported);
  for (const name of [...exported].sort()) rows.upsertSymbol('file', fileId, name);
  for (const r of parsed.reexports) {
    const edgeId = edgeIds[r.importIndex];
    if (edgeId === undefined) continue;
    rows.insertReexport({ fromFile: fileId, edgeId, exportedName: r.exported, importedName: r.imported, symbol: null, targetSymbol: null });
  }
  for (const u of parsed.usages) {
    rows.insertUsage({
      fileId,
      bindingId: bindingIds.get(`${u.importIndex}\0${u.local}`) ?? null,
      symbol: null,
      member: u.member,
      kind: u.kind,
      line: u.line,
      col: u.col,
      snippet: u.snippet
    });
  }
}

function fileRowFor(a: FileAnalysis, ctx: ResolverContext) {
  return {
    path: a.entry.path,
    hash: a.hash,
    size: a.entry.size,
    mtimeMs: a.entry.mtimeMs,
    kind: a.entry.kind,
    category: a.entry.category,
    role: a.entry.kind === 'js' ? fileRole(a.entry.path, ctx.entryPaths) : null,
    parseError: a.parseError,
    skipReason: a.entry.skipReason
  };
}

function finishDerived(db: GraphDriver, ctx: ResolverContext): void {
  relinkSymbols(db);
  pruneOrphans(db, ctx.declared, ctx.workspaces.map((w) => w.name));
  recomputeReach(db);
}

function writeMeta(rows: GraphRows, meta: Record<string, string>): void {
  for (const [k, v] of Object.entries(meta)) rows.setMeta(k, v);
}

function counts(db: GraphDriver): { edges: number; unresolved: number } {
  const row = db.prepare("SELECT count(*) AS n, sum(resolution = 'unresolved') AS u FROM import_edge").get();
  return { edges: Number(row?.n ?? 0), unresolved: Number(row?.u ?? 0) };
}

async function fullBuild(
  db: GraphDriver,
  entries: WalkEntry[],
  ctx: ResolverContext,
  parser: ParserAdapter,
  meta: Record<string, string>,
  opts: BuildGraphOptions
): Promise<void> {
  const analyses = await analyseFiles(entries, ctx, parser, opts);
  checkAbort(opts.signal);
  const rows = createRows(db);
  opts.onProgress?.({ phase: 'write', current: 0, total: analyses.length });
  db.transaction(() => {
    db.exec(
      'DELETE FROM package_reach; DELETE FROM binding_reach; DELETE FROM usage; DELETE FROM reexport; DELETE FROM import_binding; DELETE FROM import_edge; DELETE FROM symbol; DELETE FROM file; DELETE FROM package;'
    );
    const maps: WriteMaps = { fileIds: new Map(), packageIds: new Map() };
    // Insert order is fixed (paths and package names sorted), so ids are deterministic.
    for (const a of analyses) maps.fileIds.set(a.entry.path, rows.insertFile(fileRowFor(a, ctx)));
    const names = new Set<string>(ctx.declared);
    for (const w of ctx.workspaces) names.add(w.name);
    for (const a of analyses) for (const { outcome } of a.imports) if (outcome.packageName !== null) names.add(outcome.packageName);
    for (const name of [...names].sort()) packageId(rows, maps, ctx, name);
    for (const a of analyses) writeFileContent(rows, maps, ctx, maps.fileIds.get(a.entry.path)!, a);
    finishDerived(db, ctx);
    writeMeta(rows, meta);
    opts.onProgress?.({ phase: 'write', current: analyses.length, total: analyses.length });
  });
}

function sameOutcome(edge: EdgeRow, o: ResolveOutcome, toFile: number | null, toPackage: number | null): boolean {
  return (
    edge.toFile === toFile &&
    edge.toPackage === toPackage &&
    edge.subpath === o.subpath &&
    edge.resolution === o.resolution &&
    edge.confidence === o.confidence &&
    edge.unresolvedReason === o.unresolvedReason &&
    edge.alias === o.alias
  );
}

function isConfigFile(e: WalkEntry): boolean {
  return e.kind === 'config' || (e.kind === 'js' && jsConfigInfo(e.path) !== null);
}

function byPathAsc(a: WalkEntry, b: WalkEntry): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Incremental rescan (3a.8). Change detection: (size, mtimeMs) fast path, then
 * sha1 decides. Changed/added files are re-parsed, removed files deleted.
 * Re-resolution:
 *  - files added or removed -> every edge except config refs (a new `foo.ts`
 *    can change where `./foo`, a baseUrl or a `paths` specifier resolves;
 *    broader than the spec's "non-external edges", which would miss a bare
 *    baseUrl specifier flipping from external-by-name to a project file);
 *  - resolver config changed -> every edge, and config files are re-analysed
 *    (their refs depend on the declared dependency list);
 *  - lockfile state changed -> external edges only.
 * Derived data (symbol links, orphans, reach) is then recomputed in full.
 * Returns the number of files re-parsed, added or removed.
 */
async function incrementalBuild(
  db: GraphDriver,
  entries: WalkEntry[],
  ctx: ResolverContext,
  parser: ParserAdapter,
  meta: Record<string, string>,
  prev: Record<string, string>,
  opts: BuildGraphOptions
): Promise<number> {
  const rows = createRows(db);
  const existing = new Map<string, FileRow>(rows.allFiles().map((f) => [f.path, f]));
  const walked = new Set(entries.map((e) => e.path));
  const removed = [...existing.keys()].filter((p) => !walked.has(p));
  const configChanged = prev.resolverConfigHash !== meta.resolverConfigHash;
  const lockChanged = prev.lockfileStateHash !== meta.lockfileStateHash;

  const added: WalkEntry[] = [];
  const suspects: WalkEntry[] = [];
  for (const e of entries) {
    const old = existing.get(e.path);
    if (old === undefined) added.push(e);
    else if (old.size !== e.size || old.mtimeMs !== e.mtimeMs || old.skipReason !== e.skipReason) suspects.push(e);
  }

  // Hash the suspects; identical content only needs its stat refreshed.
  const changed: WalkEntry[] = [];
  const statOnly: WalkEntry[] = [];
  for (const e of suspects) {
    const old = existing.get(e.path)!;
    if (e.skipReason !== null || old.hash === null || old.skipReason !== null) {
      changed.push(e);
      continue;
    }
    const hash = await fs
      .readFile(e.absPath)
      .then(sha1)
      .catch(() => null);
    if (hash !== null && hash === old.hash) statOnly.push(e);
    else changed.push(e);
  }
  checkAbort(opts.signal);

  const toAnalyse = new Map<string, WalkEntry>();
  for (const e of [...changed, ...added]) toAnalyse.set(e.path, e);
  if (configChanged) for (const e of entries) if (isConfigFile(e)) toAnalyse.set(e.path, e);
  const analyses = await analyseFiles([...toAnalyse.values()].sort(byPathAsc), ctx, parser, opts);
  checkAbort(opts.signal);

  const structureChanged = added.length > 0 || removed.length > 0;
  const nothingChanged = !structureChanged && changed.length === 0 && statOnly.length === 0 && !configChanged && !lockChanged;
  opts.onProgress?.({ phase: 'write', current: 0, total: analyses.length });
  db.transaction(() => {
    if (nothingChanged) {
      rows.setMeta('builtAt', meta.builtAt!);
      return;
    }
    for (const p of removed) rows.deleteFileByPath(p);
    for (const e of statOnly) rows.updateFileStat(existing.get(e.path)!.id, e.size, e.mtimeMs);

    const maps: WriteMaps = { fileIds: new Map(), packageIds: new Map() };
    for (const [p, f] of existing) if (walked.has(p)) maps.fileIds.set(p, f.id);
    for (const r of db.prepare('SELECT id, name FROM package').all()) maps.packageIds.set(String(r.name), Number(r.id));
    for (const a of analyses) {
      const row = fileRowFor(a, ctx);
      const id = maps.fileIds.get(a.entry.path);
      if (id === undefined) maps.fileIds.set(a.entry.path, rows.insertFile(row));
      else {
        rows.deleteFileContent(id);
        rows.updateFile(id, row);
      }
    }
    for (const a of analyses) writeFileContent(rows, maps, ctx, maps.fileIds.get(a.entry.path)!, a);
    // A full build lists every declared/workspace package even without edges; so must this.
    for (const name of [...ctx.declared, ...ctx.workspaces.map((w) => w.name)].sort()) packageId(rows, maps, ctx, name);

    if (structureChanged || configChanged || lockChanged) {
      const fresh = new Set(analyses.map((a) => maps.fileIds.get(a.entry.path)!));
      const pathById = new Map([...maps.fileIds].map(([p, id]) => [id, p]));
      for (const edge of rows.allEdges()) {
        if (fresh.has(edge.fromFile) || edge.kind === 'config-ref') continue;
        if (!structureChanged && !configChanged && edge.resolution !== 'external') continue;
        const fromPath = pathById.get(edge.fromFile);
        if (fromPath === undefined) continue;
        const specifier = edge.kind === 'dynamic-expr' ? null : edge.specifier;
        const o = ctx.resolve({ fromFile: fromPath, specifier, kind: edge.kind });
        const toFile = o.toFile === null ? null : (maps.fileIds.get(o.toFile) ?? null);
        const toPackage = o.packageName === null ? null : packageId(rows, maps, ctx, o.packageName);
        if (!sameOutcome(edge, o, toFile, toPackage)) {
          rows.updateEdgeResolution(edge.id, {
            toFile,
            toPackage,
            subpath: o.subpath,
            resolution: o.resolution,
            confidence: o.confidence,
            unresolvedReason: o.unresolvedReason,
            alias: o.alias
          });
        }
      }
    }

    // Roles depend on package.json entry targets; refresh any that moved.
    const setRole = db.prepare('UPDATE file SET role = ? WHERE id = ?');
    for (const f of rows.allFiles()) {
      const role = f.kind === 'js' ? fileRole(f.path, ctx.entryPaths) : null;
      if (role !== f.role) setRole.run(role, f.id);
    }

    finishDerived(db, ctx);
    writeMeta(rows, meta);
    opts.onProgress?.({ phase: 'write', current: analyses.length, total: analyses.length });
  });
  return changed.length + added.length + removed.length;
}

export async function buildGraph(opts: BuildGraphOptions): Promise<BuildGraphResult> {
  const started = Date.now();
  const lockKey = opts.lockKey ?? `graph:${path.resolve(opts.dbPath)}`;
  const parser = opts.parser ?? babelParser;
  return opts.lock(lockKey, async () => {
    checkAbort(opts.signal);
    const projectRoot = path.resolve(opts.projectRoot);
    const writer = await openGraphWriter({ dbPath: opts.dbPath, projectRoot, busyTimeoutMs: opts.busyTimeoutMs });
    const db = writer.db;
    try {
      opts.onProgress?.({ phase: 'walk', current: 0, total: 0 });
      const entries = await walkProject({ projectRoot });
      checkAbort(opts.signal);
      opts.onProgress?.({ phase: 'resolve', current: 0, total: entries.length });
      const ctx = await createResolverContext({ projectRoot, files: entries });
      const meta: Record<string, string> = {
        builtAt: new Date().toISOString(),
        parser: parser.id,
        resolver: ctx.id,
        resolverConfigHash: ctx.configHash,
        lockfileStateHash: await lockfileStateHash(projectRoot),
        projectRootHash: projectRootHash(projectRoot)
      };
      checkAbort(opts.signal);

      const prev = createRows(db).allMeta();
      const canIncrement =
        opts.mode === 'auto' &&
        writer.rebuildReason === null &&
        prev.builtAt !== undefined &&
        prev.parser === meta.parser &&
        prev.resolver === meta.resolver &&
        prev.projectRootHash === meta.projectRootHash;

      let mode: BuildMode = 'full';
      let filesChanged: number | undefined;
      if (canIncrement) {
        mode = 'incremental';
        filesChanged = await incrementalBuild(db, entries, ctx, parser, meta, prev, opts);
      } else {
        await fullBuild(db, entries, ctx, parser, meta, opts);
      }
      const c = counts(db);
      return {
        mode,
        files: entries.length,
        edges: c.edges,
        unresolved: c.unresolved,
        durationMs: Date.now() - started,
        ...(writer.rebuildReason !== null ? { rebuildReason: writer.rebuildReason } : {}),
        ...(filesChanged !== undefined ? { filesChanged } : {})
      };
    } finally {
      db.close();
    }
  });
}
