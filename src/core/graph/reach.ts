/**
 * Derived reach tables (V2_STAGE3_SPEC §2, 3a.7), recomputed from scratch at
 * the end of every build inside the write transaction:
 *
 *  - symbol links: package symbols for every imported/re-exported name, then
 *    `import_binding.imported_symbol`, `usage.symbol`, `reexport.symbol` /
 *    `target_symbol` point at them;
 *  - `binding_reach`: the package export each import binding finally reaches,
 *    directly (depth 0) or through re-export chains (recursive CTE);
 *  - `package_reach`: per (package, file) — `direct` (any edge to the package),
 *    `reexport` (aggregated from binding_reach, depth = hops) and `wrapper`
 *    depth 1 (imports a project file that has a direct edge to the package
 *    and exports something).
 *
 * Confidence = lowest on the path (§2); an `export *` hop or a namespace
 * fan-out caps it at `medium`. Cycles: chain depth is capped at
 * MAX_REEXPORT_DEPTH and UNION de-duplicates states, so a re-export cycle
 * terminates.
 */
import type { GraphDriver } from './store';

export const MAX_REEXPORT_DEPTH = 16;

const RANK = (col: string) => `(CASE ${col} WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END)`;
const CONF = (expr: string) => `(CASE ${expr} WHEN 3 THEN 'high' WHEN 2 THEN 'medium' ELSE 'low' END)`;

/** True when `file` explicitly exports `name` (locally or by a named re-export), which shadows `export *`. */
const EXPLICIT_EXPORT = (fileCol: string, nameCol: string) =>
  `EXISTS (SELECT 1 FROM symbol xs WHERE xs.owner_kind = 'file' AND xs.owner_id = ${fileCol} AND xs.name = ${nameCol})`;

export function relinkSymbols(db: GraphDriver): void {
  db.exec(`
    INSERT OR IGNORE INTO symbol (owner_kind, owner_id, name)
      SELECT DISTINCT 'package', e.to_package, b.imported_name
        FROM import_binding b JOIN import_edge e ON e.id = b.edge_id
       WHERE e.to_package IS NOT NULL
       ORDER BY e.to_package, b.imported_name;
    INSERT OR IGNORE INTO symbol (owner_kind, owner_id, name)
      SELECT DISTINCT 'package', e.to_package, r.imported_name
        FROM reexport r JOIN import_edge e ON e.id = r.edge_id
       WHERE e.to_package IS NOT NULL AND r.imported_name <> '*'
       ORDER BY e.to_package, r.imported_name;
    UPDATE import_binding SET imported_symbol = (
      SELECT s.id FROM import_edge e JOIN symbol s
          ON s.name = import_binding.imported_name
         AND ((e.to_package IS NOT NULL AND s.owner_kind = 'package' AND s.owner_id = e.to_package)
           OR (e.to_package IS NULL AND e.to_file IS NOT NULL AND s.owner_kind = 'file' AND s.owner_id = e.to_file))
       WHERE e.id = import_binding.edge_id);
    UPDATE usage SET symbol = (SELECT b.imported_symbol FROM import_binding b WHERE b.id = usage.binding_id);
    UPDATE reexport SET
      symbol = (SELECT s.id FROM symbol s WHERE s.owner_kind = 'file' AND s.owner_id = reexport.from_file AND s.name = reexport.exported_name),
      target_symbol = (
        SELECT s.id FROM import_edge e JOIN symbol s
            ON s.name = reexport.imported_name
           AND ((e.to_package IS NOT NULL AND s.owner_kind = 'package' AND s.owner_id = e.to_package)
             OR (e.to_package IS NULL AND e.to_file IS NOT NULL AND s.owner_kind = 'file' AND s.owner_id = e.to_file))
         WHERE e.id = reexport.edge_id);
  `);
}

/** Drops rows nothing refers to any more (incremental builds leave them behind). */
export function pruneOrphans(db: GraphDriver, declared: readonly string[], workspaces: readonly string[]): void {
  db.exec(`
    DELETE FROM symbol WHERE owner_kind = 'file' AND owner_id NOT IN (SELECT id FROM file);
    DELETE FROM symbol WHERE owner_kind = 'package'
       AND id NOT IN (SELECT imported_symbol FROM import_binding WHERE imported_symbol IS NOT NULL)
       AND id NOT IN (SELECT target_symbol FROM reexport WHERE target_symbol IS NOT NULL);
  `);
  const setFlags = db.prepare('UPDATE package SET declared = ?, is_workspace = ? WHERE id = ?');
  for (const row of db.prepare('SELECT id, name, declared, is_workspace FROM package').all()) {
    const name = String(row.name);
    const d = declared.includes(name) ? 1 : 0;
    const w = workspaces.includes(name) ? 1 : 0;
    if (Number(row.declared) !== d || Number(row.is_workspace) !== w) setFlags.run(d, w, Number(row.id));
  }
  db.exec(`
    DELETE FROM package WHERE declared = 0 AND is_workspace = 0
       AND id NOT IN (SELECT to_package FROM import_edge WHERE to_package IS NOT NULL);
  `);
}

export function recomputeReach(db: GraphDriver): void {
  db.exec('DELETE FROM binding_reach; DELETE FROM package_reach;');

  // Depth 0: the binding's own edge targets a package.
  db.exec(`
    INSERT INTO binding_reach (binding_id, package_id, name, depth, confidence)
      SELECT b.id, e.to_package, b.imported_name, 0, e.confidence
        FROM import_binding b JOIN import_edge e ON e.id = b.edge_id
       WHERE e.to_package IS NOT NULL;
  `);

  // Re-export chains. chain(binding, file, name): "this binding wants export
  // `name` of project file `file`". A hop through reexport r of that file:
  //  - r.exported_name = name            → wants r.imported_name next
  //  - r.exported_name = '*' (export *)  → passes `name` through, unless the
  //    file exports `name` explicitly or name is 'default'
  //  - name = '*' (namespace import)     → fans out to every re-export
  const hop = `
    FROM chain c
    JOIN reexport r ON r.from_file = c.file_id
     AND (c.name = '*' OR r.exported_name = c.name
          OR (r.exported_name = '*' AND c.name <> 'default' AND NOT ${EXPLICIT_EXPORT('c.file_id', 'c.name')}))
    JOIN import_edge e2 ON e2.id = r.edge_id`;
  const nextName = `CASE WHEN c.name = '*' THEN (CASE WHEN r.exported_name = '*' THEN '*' ELSE r.imported_name END)
                         WHEN r.exported_name = '*' THEN c.name ELSE r.imported_name END`;
  const nextConf = `min(c.conf, ${RANK('e2.confidence')}, CASE WHEN c.name = '*' OR r.exported_name = '*' THEN 2 ELSE 3 END)`;
  db.exec(`
    INSERT INTO binding_reach (binding_id, package_id, name, depth, confidence)
    WITH RECURSIVE chain(binding_id, file_id, name, depth, conf) AS (
      SELECT b.id, e.to_file, b.imported_name, 0, ${RANK('e.confidence')}
        FROM import_binding b JOIN import_edge e ON e.id = b.edge_id
       WHERE e.to_file IS NOT NULL
      UNION
      SELECT c.binding_id, e2.to_file, ${nextName}, c.depth + 1, ${nextConf}
        ${hop}
       WHERE e2.to_file IS NOT NULL AND c.depth < ${MAX_REEXPORT_DEPTH}
    )
    SELECT c.binding_id, e2.to_package, ${nextName}, min(c.depth + 1), ${CONF(`max(${nextConf})`)}
      ${hop}
     WHERE e2.to_package IS NOT NULL
     GROUP BY c.binding_id, e2.to_package, ${nextName}
    ON CONFLICT (binding_id, package_id, name) DO NOTHING;
  `);

  // package_reach: direct (best edge per file), reexport (aggregated), wrapper depth 1.
  db.exec(`
    INSERT INTO package_reach (package_id, file_id, via, via_file_id, depth, confidence)
      SELECT e.to_package, e.from_file, 'direct', NULL, 0, ${CONF(`max(${RANK('e.confidence')})`)}
        FROM import_edge e WHERE e.to_package IS NOT NULL
       GROUP BY e.to_package, e.from_file;

    INSERT INTO package_reach (package_id, file_id, via, via_file_id, depth, confidence)
      SELECT br.package_id, e.from_file, 'reexport', NULL, min(br.depth), ${CONF(`max(${RANK('br.confidence')})`)}
        FROM binding_reach br JOIN import_binding b ON b.id = br.binding_id JOIN import_edge e ON e.id = b.edge_id
       WHERE br.depth > 0
       GROUP BY br.package_id, e.from_file;

    INSERT INTO package_reach (package_id, file_id, via, via_file_id, depth, confidence)
      SELECT w.package_id, w.consumer, 'wrapper', (SELECT id FROM file WHERE path = w.via_path), 1, ${CONF('w.conf')}
        FROM (
          SELECT d.package_id, e.from_file AS consumer, min(fw.path) AS via_path,
                 max(min(${RANK('e.confidence')}, ${RANK('d.confidence')})) AS conf
            FROM package_reach d
            JOIN file fw ON fw.id = d.file_id
            JOIN import_edge e ON e.to_file = d.file_id AND e.from_file <> d.file_id
           WHERE d.via = 'direct'
             AND EXISTS (SELECT 1 FROM symbol s WHERE s.owner_kind = 'file' AND s.owner_id = d.file_id)
           GROUP BY d.package_id, e.from_file
        ) w;
  `);
}
