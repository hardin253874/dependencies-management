/**
 * Typed insert/delete/select helpers over the graph schema (3a.2). One
 * `GraphRows` per open handle; prepared statements live on the instance, never
 * at module scope.
 */
import type { GraphDriver, GraphStatement, SqlValue } from './store';
import type {
  Confidence,
  EdgeKind,
  FileCategory,
  FileKind,
  FileRole,
  Resolution,
  SkipReason,
  UnresolvedReason,
  UsageKind
} from './types';

export interface FileRowInput {
  path: string;
  hash: string | null;
  size: number;
  mtimeMs: number;
  kind: FileKind;
  category: FileCategory;
  role: FileRole | null;
  parseError: string | null;
  skipReason: SkipReason | null;
}

export interface FileRow extends FileRowInput {
  id: number;
}

export interface EdgeRowInput {
  fromFile: number;
  specifier: string;
  kind: EdgeKind;
  toFile: number | null;
  toPackage: number | null;
  subpath: string | null;
  resolution: Resolution;
  confidence: Confidence;
  unresolvedReason: UnresolvedReason | null;
  alias: string | null;
  line: number;
  col: number;
  snippet: string;
}

export interface EdgeRow extends EdgeRowInput {
  id: number;
}

export interface BindingRowInput {
  edgeId: number;
  localName: string;
  importedName: string;
  importedSymbol: number | null;
  isType: boolean;
}

export interface ReexportRowInput {
  fromFile: number;
  edgeId: number;
  exportedName: string;
  importedName: string;
  symbol: number | null;
  targetSymbol: number | null;
}

export interface UsageRowInput {
  fileId: number;
  bindingId: number | null;
  symbol: number | null;
  member: string | null;
  kind: UsageKind;
  line: number;
  col: number;
  snippet: string;
}

function num(v: SqlValue | undefined): number {
  return Number(v ?? 0);
}

function strOrNull(v: SqlValue | undefined): string | null {
  return v === null || v === undefined ? null : String(v);
}

export function toFileRow(r: Record<string, SqlValue>): FileRow {
  return {
    id: num(r.id),
    path: String(r.path),
    hash: strOrNull(r.hash),
    size: num(r.size),
    mtimeMs: num(r.mtime_ms),
    kind: String(r.kind) as FileKind,
    category: String(r.category) as FileCategory,
    role: strOrNull(r.role) as FileRole | null,
    parseError: strOrNull(r.parse_error),
    skipReason: strOrNull(r.skip_reason) as SkipReason | null
  };
}

export function toEdgeRow(r: Record<string, SqlValue>): EdgeRow {
  return {
    id: num(r.id),
    fromFile: num(r.from_file),
    specifier: String(r.specifier),
    kind: String(r.kind) as EdgeKind,
    toFile: r.to_file === null ? null : num(r.to_file),
    toPackage: r.to_package === null ? null : num(r.to_package),
    subpath: strOrNull(r.subpath),
    resolution: String(r.resolution) as Resolution,
    confidence: String(r.confidence) as Confidence,
    unresolvedReason: strOrNull(r.unresolved_reason) as UnresolvedReason | null,
    alias: strOrNull(r.alias),
    line: num(r.line),
    col: num(r.col),
    snippet: String(r.snippet)
  };
}

export interface GraphRows {
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
  allMeta(): Record<string, string>;
  insertFile(f: FileRowInput): number;
  updateFile(id: number, f: FileRowInput): void;
  updateFileStat(id: number, size: number, mtimeMs: number): void;
  deleteFileByPath(path: string): void;
  allFiles(): FileRow[];
  upsertPackage(name: string, flags?: { declared?: boolean; isWorkspace?: boolean }): number;
  upsertSymbol(ownerKind: 'file' | 'package', ownerId: number, name: string): number;
  insertEdge(e: EdgeRowInput): number;
  updateEdgeResolution(id: number, e: Pick<EdgeRowInput, 'toFile' | 'toPackage' | 'subpath' | 'resolution' | 'confidence' | 'unresolvedReason' | 'alias'>): void;
  edgesFrom(fileId: number): EdgeRow[];
  allEdges(): EdgeRow[];
  insertBinding(b: BindingRowInput): number;
  insertReexport(r: ReexportRowInput): number;
  insertUsage(u: UsageRowInput): number;
  deleteFileContent(fileId: number): void;
}

export function createRows(db: GraphDriver): GraphRows {
  // Lazily prepared per handle so read-only callers never prepare writes.
  const cache = new Map<string, GraphStatement>();
  const stmt = (sql: string): GraphStatement => {
    let s = cache.get(sql);
    if (s === undefined) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  const id = (r: { lastInsertRowid: number | bigint }): number => Number(r.lastInsertRowid);

  return {
    getMeta(key) {
      const row = stmt('SELECT value FROM meta WHERE key = ?').get(key);
      return row === undefined ? null : String(row.value);
    },
    setMeta(key, value) {
      stmt('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    },
    allMeta() {
      const out: Record<string, string> = {};
      for (const r of stmt('SELECT key, value FROM meta ORDER BY key').all()) out[String(r.key)] = String(r.value);
      return out;
    },
    insertFile(f) {
      return id(
        stmt(
          'INSERT INTO file (path, hash, size, mtime_ms, kind, category, role, parse_error, skip_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(f.path, f.hash, f.size, f.mtimeMs, f.kind, f.category, f.role, f.parseError, f.skipReason)
      );
    },
    updateFile(fileId, f) {
      stmt(
        'UPDATE file SET path = ?, hash = ?, size = ?, mtime_ms = ?, kind = ?, category = ?, role = ?, parse_error = ?, skip_reason = ? WHERE id = ?'
      ).run(f.path, f.hash, f.size, f.mtimeMs, f.kind, f.category, f.role, f.parseError, f.skipReason, fileId);
    },
    updateFileStat(fileId, size, mtimeMs) {
      stmt('UPDATE file SET size = ?, mtime_ms = ? WHERE id = ?').run(size, mtimeMs, fileId);
    },
    deleteFileByPath(p) {
      stmt('DELETE FROM file WHERE path = ?').run(p);
    },
    allFiles() {
      return stmt('SELECT * FROM file ORDER BY path').all().map(toFileRow);
    },
    upsertPackage(name, flags = {}) {
      const existing = stmt('SELECT id, declared, is_workspace FROM package WHERE name = ?').get(name);
      const declared = flags.declared === true ? 1 : 0;
      const ws = flags.isWorkspace === true ? 1 : 0;
      if (existing !== undefined) {
        if ((declared && !existing.declared) || (ws && !existing.is_workspace)) {
          stmt('UPDATE package SET declared = max(declared, ?), is_workspace = max(is_workspace, ?) WHERE id = ?').run(
            declared,
            ws,
            num(existing.id)
          );
        }
        return num(existing.id);
      }
      return id(stmt('INSERT INTO package (name, declared, is_workspace) VALUES (?, ?, ?)').run(name, declared, ws));
    },
    upsertSymbol(ownerKind, ownerId, name) {
      const existing = stmt('SELECT id FROM symbol WHERE owner_kind = ? AND owner_id = ? AND name = ?').get(ownerKind, ownerId, name);
      if (existing !== undefined) return num(existing.id);
      return id(stmt('INSERT INTO symbol (owner_kind, owner_id, name) VALUES (?, ?, ?)').run(ownerKind, ownerId, name));
    },
    insertEdge(e) {
      return id(
        stmt(
          `INSERT INTO import_edge (from_file, specifier, kind, to_file, to_package, subpath, resolution, confidence,
             unresolved_reason, alias, line, col, snippet) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          e.fromFile,
          e.specifier,
          e.kind,
          e.toFile,
          e.toPackage,
          e.subpath,
          e.resolution,
          e.confidence,
          e.unresolvedReason,
          e.alias,
          e.line,
          e.col,
          e.snippet
        )
      );
    },
    updateEdgeResolution(edgeId, e) {
      stmt(
        `UPDATE import_edge SET to_file = ?, to_package = ?, subpath = ?, resolution = ?, confidence = ?,
           unresolved_reason = ?, alias = ? WHERE id = ?`
      ).run(e.toFile, e.toPackage, e.subpath, e.resolution, e.confidence, e.unresolvedReason, e.alias, edgeId);
    },
    edgesFrom(fileId) {
      return stmt('SELECT * FROM import_edge WHERE from_file = ? ORDER BY id').all(fileId).map(toEdgeRow);
    },
    allEdges() {
      return stmt('SELECT * FROM import_edge ORDER BY id').all().map(toEdgeRow);
    },
    insertBinding(b) {
      return id(
        stmt('INSERT INTO import_binding (edge_id, local_name, imported_name, imported_symbol, is_type) VALUES (?, ?, ?, ?, ?)').run(
          b.edgeId,
          b.localName,
          b.importedName,
          b.importedSymbol,
          b.isType ? 1 : 0
        )
      );
    },
    insertReexport(r) {
      return id(
        stmt(
          'INSERT INTO reexport (from_file, edge_id, exported_name, imported_name, symbol, target_symbol) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(r.fromFile, r.edgeId, r.exportedName, r.importedName, r.symbol, r.targetSymbol)
      );
    },
    insertUsage(u) {
      return id(
        stmt('INSERT INTO usage (file_id, binding_id, symbol, member, kind, line, col, snippet) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
          u.fileId,
          u.bindingId,
          u.symbol,
          u.member,
          u.kind,
          u.line,
          u.col,
          u.snippet
        )
      );
    },
    deleteFileContent(fileId) {
      // Edges cascade to bindings, reexports (by edge) and usages (by binding).
      stmt('DELETE FROM usage WHERE file_id = ?').run(fileId);
      stmt('DELETE FROM reexport WHERE from_file = ?').run(fileId);
      stmt('DELETE FROM import_edge WHERE from_file = ?').run(fileId);
      stmt("DELETE FROM symbol WHERE owner_kind = 'file' AND owner_id = ?").run(fileId);
    }
  };
}
