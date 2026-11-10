/**
 * Id-independent table dump of a graph DB. Row ids differ between a full and
 * an incremental build of the same tree, so every foreign key is replaced by
 * its natural key (file path, package name, symbol owner+name) and rows are
 * sorted. Used by the determinism and incremental == full tests (3a.7/3a.8)
 * and handy for debugging. `meta.builtAt` is excluded.
 */
import type { GraphDriver } from './store';

export type GraphDump = Record<string, string[]>;

const SYMBOL_KEY = `CASE WHEN s.id IS NULL THEN NULL ELSE s.owner_kind || ':' ||
  CASE s.owner_kind WHEN 'file' THEN (SELECT path FROM file WHERE id = s.owner_id) ELSE (SELECT name FROM package WHERE id = s.owner_id) END
  || '#' || s.name END`;

const QUERIES: Readonly<Record<string, string>> = Object.freeze({
  meta: `SELECT key, value FROM meta WHERE key <> 'builtAt'`,
  file: `SELECT path, hash, size, mtime_ms, kind, category, role, parse_error, skip_reason FROM file`,
  package: `SELECT name, is_workspace, declared FROM package`,
  symbol: `SELECT ${SYMBOL_KEY} AS k FROM symbol s`,
  import_edge: `SELECT f.path, e.specifier, e.kind, tf.path AS to_file, p.name AS to_package, e.subpath, e.resolution, e.confidence,
      e.unresolved_reason, e.alias, e.line, e.col, e.snippet
    FROM import_edge e JOIN file f ON f.id = e.from_file LEFT JOIN file tf ON tf.id = e.to_file LEFT JOIN package p ON p.id = e.to_package`,
  import_binding: `SELECT f.path, e.line, e.col, e.specifier, b.local_name, b.imported_name, b.is_type, (SELECT ${SYMBOL_KEY} FROM symbol s WHERE s.id = b.imported_symbol) AS sym
    FROM import_binding b JOIN import_edge e ON e.id = b.edge_id JOIN file f ON f.id = e.from_file`,
  reexport: `SELECT f.path, e.line, e.col, e.specifier, r.exported_name, r.imported_name,
      (SELECT ${SYMBOL_KEY} FROM symbol s WHERE s.id = r.symbol) AS sym, (SELECT ${SYMBOL_KEY} FROM symbol s WHERE s.id = r.target_symbol) AS tsym
    FROM reexport r JOIN file f ON f.id = r.from_file JOIN import_edge e ON e.id = r.edge_id`,
  usage: `SELECT f.path, u.member, u.kind, u.line, u.col, u.snippet, b.local_name, (SELECT ${SYMBOL_KEY} FROM symbol s WHERE s.id = u.symbol) AS sym
    FROM usage u JOIN file f ON f.id = u.file_id LEFT JOIN import_binding b ON b.id = u.binding_id`,
  binding_reach: `SELECT f.path, e.line, e.col, b.local_name, p.name, br.name, br.depth, br.confidence
    FROM binding_reach br JOIN import_binding b ON b.id = br.binding_id JOIN import_edge e ON e.id = b.edge_id
    JOIN file f ON f.id = e.from_file JOIN package p ON p.id = br.package_id`,
  package_reach: `SELECT p.name, f.path, r.via, vf.path AS via_file, r.depth, r.confidence
    FROM package_reach r JOIN package p ON p.id = r.package_id JOIN file f ON f.id = r.file_id LEFT JOIN file vf ON vf.id = r.via_file_id`
});

export function dumpGraph(db: GraphDriver): GraphDump {
  const out: GraphDump = {};
  for (const [table, sql] of Object.entries(QUERIES)) {
    out[table] = db
      .prepare(sql)
      .all()
      .map((row) => JSON.stringify(Object.values(row)))
      .sort();
  }
  return out;
}
