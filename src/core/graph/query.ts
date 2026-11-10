/**
 * Public read contract of the code graph (V2_STAGE3_SPEC 3a.9, design §8) for
 * the UI, services, eval and (Stage 4) the MCP server.
 *
 * - Every function takes a reader handle from `openGraphReader` first.
 * - Unknown package / file → empty result, never an error.
 * - Output order is stable (path ascending unless stated otherwise).
 * - Results carry `confidence` so callers can say "possibly affected".
 */
import type { GraphDriver, Row } from './store';
import {
  type Confidence,
  type DependentHit,
  type EdgeKind,
  type EntryPoint,
  type FileCategory,
  type FileHit,
  type FileRole,
  type FilesUsingPackageOptions,
  type GraphInfo,
  type Page,
  type SymbolUse,
  type UnresolvedImport,
  type UnresolvedReason,
  type UnresolvedSummary,
  type UsageKind,
  type UsageSite,
  type Via,
  minConfidence
} from './types';

const VIA_RANK: Readonly<Record<Via, number>> = Object.freeze({ direct: 0, reexport: 1, wrapper: 2 });
const DEFAULT_LIMIT = 100;
const MAX_CLOSURE_DEPTH = 64;

function str(v: Row[string] | undefined): string {
  return v === null || v === undefined ? '' : String(v);
}

function strOrNull(v: Row[string] | undefined): string | null {
  return v === null || v === undefined ? null : String(v);
}

function page(p: Page | undefined): { limit: number; offset: number } {
  const limit = Math.max(0, Math.floor(p?.limit ?? DEFAULT_LIMIT));
  const offset = Math.max(0, Math.floor(p?.offset ?? 0));
  return { limit, offset };
}

function packageIdOf(h: GraphDriver, pkg: string): number | null {
  if (typeof pkg !== 'string' || pkg === '') return null;
  const row = h.prepare('SELECT id FROM package WHERE name = ?').get(pkg);
  return row === undefined ? null : Number(row.id);
}

interface FileFacts {
  id: number;
  path: string;
  category: FileCategory;
  role: FileRole | null;
}

function fileByPath(h: GraphDriver, p: string): FileFacts | null {
  const row = h.prepare('SELECT id, path, category, role FROM file WHERE path = ?').get(p);
  return row === undefined ? null : toFacts(row);
}

/** The FileHit fields that come from the file row. */
function hitBase(row: Row): Pick<FileHit, 'path' | 'category' | 'role'> {
  return { path: str(row.path), category: str(row.category) as FileCategory, role: strOrNull(row.role) as FileRole | null };
}

function toFacts(row: Row): FileFacts {
  return { id: Number(row.id), path: str(row.path), category: str(row.category) as FileCategory, role: strOrNull(row.role) as FileRole | null };
}

function byPath<T extends { path: string }>(a: T, b: T): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Files that use `pkg` — one hit per file, best `via` wins (direct > reexport > wrapper, then smaller depth). */
export function filesUsingPackage(h: GraphDriver, pkg: string, opts: FilesUsingPackageOptions = {}): FileHit[] {
  const pid = packageIdOf(h, pkg);
  if (pid === null) return [];
  const transitive = opts.transitive ?? true;
  const wrapperDepth = transitive ? Math.max(0, Math.floor(opts.wrapperDepth ?? 1)) : 0;
  const best = new Map<number, FileHit & { fileId: number }>();
  const offer = (hit: FileHit & { fileId: number }) => {
    const cur = best.get(hit.fileId);
    if (cur === undefined || VIA_RANK[hit.via] < VIA_RANK[cur.via] || (hit.via === cur.via && hit.depth < cur.depth)) best.set(hit.fileId, hit);
  };

  // Direct: from package_reach, or straight from edges when a kinds filter is given.
  const directRows =
    opts.kinds !== undefined && opts.kinds.length > 0
      ? h
          .prepare(
            `SELECT f.id, f.path, f.category, f.role,
                    CASE max(CASE e.confidence WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END)
                      WHEN 3 THEN 'high' WHEN 2 THEN 'medium' ELSE 'low' END AS confidence
               FROM import_edge e JOIN file f ON f.id = e.from_file
              WHERE e.to_package = ? AND e.kind IN (${opts.kinds.map(() => '?').join(',')})
              GROUP BY f.id`
          )
          .all(pid, ...opts.kinds)
      : h
          .prepare(
            `SELECT f.id, f.path, f.category, f.role, r.confidence FROM package_reach r JOIN file f ON f.id = r.file_id
              WHERE r.package_id = ? AND r.via = 'direct'`
          )
          .all(pid);
  for (const r of directRows) {
    offer({ ...hitBase(r), fileId: Number(r.id), via: 'direct', depth: 0, viaPath: [], confidence: str(r.confidence) as Confidence });
  }

  if (transitive) {
    for (const r of h
      .prepare(
        `SELECT f.id, f.path, f.category, f.role, r.depth, r.confidence FROM package_reach r JOIN file f ON f.id = r.file_id
          WHERE r.package_id = ? AND r.via = 'reexport'`
      )
      .all(pid)) {
      offer({ ...hitBase(r), fileId: Number(r.id), via: 'reexport', depth: Number(r.depth), viaPath: [], confidence: str(r.confidence) as Confidence });
    }
  }

  if (wrapperDepth >= 1) {
    const level1 = h
      .prepare(
        `SELECT f.id, f.path, f.category, f.role, r.confidence, vf.id AS via_id, vf.path AS via_path
           FROM package_reach r JOIN file f ON f.id = r.file_id JOIN file vf ON vf.id = r.via_file_id
          WHERE r.package_id = ? AND r.via = 'wrapper'`
      )
      .all(pid);
    let frontier: Array<{ fileId: number; viaPath: string[]; confidence: Confidence }> = [];
    const seen = new Set<number>(directRows.map((r) => Number(r.id)));
    const kindFiltered = opts.kinds !== undefined && opts.kinds.length > 0;
    for (const r of level1) {
      // With a kinds filter, a wrapper only counts when its own direct edge matched.
      if (kindFiltered && !seen.has(Number(r.via_id))) continue;
      const hit = { ...hitBase(r), fileId: Number(r.id), via: 'wrapper' as const, depth: 1, viaPath: [str(r.via_path)], confidence: str(r.confidence) as Confidence };
      offer(hit);
      seen.add(hit.fileId);
      frontier.push({ fileId: hit.fileId, viaPath: hit.viaPath, confidence: hit.confidence });
    }
    // Deeper wrapper layers on demand: importers of an exporting wrapper consumer.
    const exportsSomething = h.prepare("SELECT 1 FROM symbol WHERE owner_kind = 'file' AND owner_id = ? LIMIT 1");
    const importers = h.prepare(
      `SELECT DISTINCT f.id, f.path, f.category, f.role, e.confidence FROM import_edge e JOIN file f ON f.id = e.from_file
        WHERE e.to_file = ? AND e.from_file <> e.to_file ORDER BY f.path`
    );
    const pathOf = h.prepare('SELECT path FROM file WHERE id = ?');
    for (let depth = 2; depth <= wrapperDepth && frontier.length > 0; depth += 1) {
      const next: typeof frontier = [];
      frontier.sort((a, b) => (a.viaPath.join('\0') < b.viaPath.join('\0') ? -1 : 1));
      for (const node of frontier) {
        if (exportsSomething.get(node.fileId) === undefined) continue;
        const nodePath = str(pathOf.get(node.fileId)?.path);
        for (const r of importers.all(node.fileId)) {
          const id = Number(r.id);
          if (seen.has(id)) continue;
          seen.add(id);
          const confidence = minConfidence(node.confidence, str(r.confidence) as Confidence);
          const viaPath = [nodePath, ...node.viaPath];
          offer({ ...hitBase(r), fileId: id, via: 'wrapper', depth, viaPath, confidence });
          next.push({ fileId: id, viaPath, confidence });
        }
      }
      frontier = next;
    }
  }

  const cats = opts.categories;
  return [...best.values()]
    .filter((hit) => cats === undefined || cats.length === 0 || cats.includes(hit.category))
    .map(({ fileId: _fileId, ...hit }) => hit)
    .sort(byPath);
}

/** Symbols (+ first member) of `pkg` used anywhere, directly or through re-exports. Sorted by count desc. */
export function symbolsUsed(h: GraphDriver, pkg: string): SymbolUse[] {
  const pid = packageIdOf(h, pkg);
  if (pid === null) return [];
  return h
    .prepare(
      `SELECT br.name AS symbol, u.member, count(*) AS n
         FROM binding_reach br JOIN usage u ON u.binding_id = br.binding_id
        WHERE br.package_id = ?
        GROUP BY br.name, u.member
        ORDER BY n DESC, br.name, u.member IS NOT NULL, u.member`
    )
    .all(pid)
    .map((r) => ({ symbol: str(r.symbol), member: strOrNull(r.member), count: Number(r.n) }));
}

/** Usage sites of `pkg` (optionally one symbol / member), path/line/col ordered, paginated. */
export function usageSites(h: GraphDriver, pkg: string, symbol?: string, member?: string, p?: Page): UsageSite[] {
  const pid = packageIdOf(h, pkg);
  if (pid === null) return [];
  const { limit, offset } = page(p);
  const where = ['br.package_id = ?'];
  const params: Array<string | number> = [pid];
  if (symbol !== undefined) {
    where.push('br.name = ?');
    params.push(symbol);
  }
  if (member !== undefined) {
    where.push('u.member = ?');
    params.push(member);
  }
  return h
    .prepare(
      `SELECT f.path, u.line, u.col, u.kind, br.name AS symbol, u.member, u.snippet, br.confidence
         FROM binding_reach br JOIN usage u ON u.binding_id = br.binding_id JOIN file f ON f.id = u.file_id
        WHERE ${where.join(' AND ')}
        ORDER BY f.path, u.line, u.col, br.name
        LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset)
    .map((r) => ({
      path: str(r.path),
      line: Number(r.line),
      col: Number(r.col),
      kind: str(r.kind) as UsageKind,
      symbol: str(r.symbol),
      member: strOrNull(r.member),
      snippet: str(r.snippet),
      confidence: str(r.confidence) as Confidence
    }));
}

/** Reverse closure: files that (transitively) import any of `seeds`, with their shortest distance. */
function reverseClosure(h: GraphDriver, seeds: number[], maxDepth: number): Map<number, { facts: FileFacts; depth: number }> {
  const out = new Map<number, { facts: FileFacts; depth: number }>();
  const importers = h.prepare(
    `SELECT DISTINCT f.id, f.path, f.category, f.role FROM import_edge e JOIN file f ON f.id = e.from_file WHERE e.to_file = ?`
  );
  const visited = new Set<number>(seeds);
  let frontier = [...seeds];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
    const next: number[] = [];
    for (const id of frontier) {
      for (const r of importers.all(id)) {
        const fid = Number(r.id);
        if (visited.has(fid)) continue;
        visited.add(fid);
        out.set(fid, { facts: toFacts(r), depth });
        next.push(fid);
      }
    }
    frontier = next;
  }
  return out;
}

/** Files that depend on `filePath` (reverse import closure), cycle-safe. */
export function dependents(h: GraphDriver, filePath: string, opts: { depth?: number } = {}): DependentHit[] {
  const f = fileByPath(h, filePath);
  if (f === null) return [];
  const maxDepth = Math.max(0, Math.min(MAX_CLOSURE_DEPTH, Math.floor(opts.depth ?? MAX_CLOSURE_DEPTH)));
  return [...reverseClosure(h, [f.id], maxDepth).values()]
    .map(({ facts, depth }) => ({ path: facts.path, category: facts.category, role: facts.role, depth }))
    .sort(byPath);
}

/** Entry points (files with a role) reached from a package's users or from one file. */
export function affectedEntryPoints(h: GraphDriver, target: string | { file: string }): EntryPoint[] {
  let seeds: FileFacts[];
  if (typeof target === 'string') {
    // Files that actually use the package; wrappers are found by the closure anyway.
    seeds = filesUsingPackage(h, target, { wrapperDepth: 0 })
      .map((hit) => fileByPath(h, hit.path))
      .filter((x): x is FileFacts => x !== null);
  } else {
    const f = fileByPath(h, target.file);
    seeds = f === null ? [] : [f];
  }
  const out: EntryPoint[] = [];
  for (const s of seeds) if (s.role !== null) out.push({ path: s.path, role: s.role, depth: 0 });
  for (const { facts, depth } of reverseClosure(h, seeds.map((s) => s.id), MAX_CLOSURE_DEPTH).values()) {
    if (facts.role !== null) out.push({ path: facts.path, role: facts.role, depth });
  }
  return out.sort(byPath);
}

/** Test-category files whose forward import closure reaches any input file. */
export function testsCovering(h: GraphDriver, filePaths: readonly string[]): DependentHit[] {
  const seeds = filePaths.map((p) => fileByPath(h, p)).filter((x): x is FileFacts => x !== null);
  const out: DependentHit[] = [];
  for (const s of seeds) if (s.category === 'test') out.push({ path: s.path, category: s.category, role: s.role, depth: 0 });
  for (const { facts, depth } of reverseClosure(h, seeds.map((s) => s.id), MAX_CLOSURE_DEPTH).values()) {
    if (facts.category === 'test') out.push({ path: facts.path, category: facts.category, role: facts.role, depth });
  }
  return out.sort(byPath);
}

/** Files that import `pkg` directly and export something (the wrapper candidates). */
export function wrappers(h: GraphDriver, pkg: string): FileHit[] {
  const pid = packageIdOf(h, pkg);
  if (pid === null) return [];
  return h
    .prepare(
      `SELECT f.path, f.category, f.role, r.confidence FROM package_reach r JOIN file f ON f.id = r.file_id
        WHERE r.package_id = ? AND r.via = 'direct'
          AND EXISTS (SELECT 1 FROM symbol s WHERE s.owner_kind = 'file' AND s.owner_id = f.id)
        ORDER BY f.path`
    )
    .all(pid)
    .map((r) => ({
      path: str(r.path),
      category: str(r.category) as FileCategory,
      role: strOrNull(r.role) as FileRole | null,
      via: 'direct' as const,
      depth: 0,
      viaPath: [],
      confidence: str(r.confidence) as Confidence
    }));
}

/** Every unresolved edge (paginated) plus the honesty summary: unresolved / all import edges. */
export function unresolved(h: GraphDriver, p?: Page): { items: UnresolvedImport[]; summary: UnresolvedSummary } {
  const { limit, offset } = page(p);
  const items = h
    .prepare(
      `SELECT f.path, e.line, e.specifier, e.kind, e.unresolved_reason, e.snippet
         FROM import_edge e JOIN file f ON f.id = e.from_file
        WHERE e.resolution = 'unresolved'
        ORDER BY f.path, e.line, e.col, e.specifier
        LIMIT ? OFFSET ?`
    )
    .all(limit, offset)
    .map((r) => ({
      path: str(r.path),
      line: Number(r.line),
      specifier: str(r.specifier),
      kind: str(r.kind) as EdgeKind,
      reason: str(r.unresolved_reason) as UnresolvedReason,
      snippet: str(r.snippet)
    }));
  const total = Number(h.prepare('SELECT count(*) AS n FROM import_edge').get()?.n ?? 0);
  const byReason: Partial<Record<UnresolvedReason, number>> = {};
  let count = 0;
  for (const r of h
    .prepare(`SELECT unresolved_reason AS reason, count(*) AS n FROM import_edge WHERE resolution = 'unresolved' GROUP BY unresolved_reason ORDER BY unresolved_reason`)
    .all()) {
    const n = Number(r.n);
    byReason[str(r.reason) as UnresolvedReason] = n;
    count += n;
  }
  return { items, summary: { totalEdges: total, unresolved: count, pct: total === 0 ? 0 : count / total, byReason } };
}

export function graphInfo(h: GraphDriver): GraphInfo {
  const meta: Record<string, string> = {};
  for (const r of h.prepare('SELECT key, value FROM meta ORDER BY key').all()) meta[str(r.key)] = str(r.value);
  const n = (sql: string) => Number(h.prepare(sql).get()?.n ?? 0);
  return {
    meta,
    counts: {
      files: n('SELECT count(*) AS n FROM file'),
      packages: n('SELECT count(*) AS n FROM package'),
      edges: n('SELECT count(*) AS n FROM import_edge'),
      unresolved: n("SELECT count(*) AS n FROM import_edge WHERE resolution = 'unresolved'"),
      usages: n('SELECT count(*) AS n FROM usage'),
      reach: n('SELECT count(*) AS n FROM package_reach')
    }
  };
}
