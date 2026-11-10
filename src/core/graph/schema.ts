/**
 * Graph DB schema (V2_STAGE3_SPEC 3a.2, design §6 + spec deltas).
 *
 * The graph is derived data (D2): any change to these statements bumps
 * SCHEMA_VERSION, and `store.ts` drops and recreates every table on mismatch.
 * Never write a migration.
 *
 * Deltas vs design §6 beyond the spec list: `binding_reach` (derived, like
 * `package_reach`) records which package + export name each import binding
 * finally reaches through re-export chains, so `symbolsUsed`/`usageSites`
 * can follow barrels with an indexed lookup.
 */

export const SCHEMA_VERSION = 1;

const EDGE_KINDS = `'static','require','dynamic-literal','dynamic-expr','type-only','side-effect','export-from','style-import','config-ref'`;
const CONFIDENCES = `'high','medium','low'`;

export const SCHEMA_STATEMENTS: readonly string[] = Object.freeze([
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE file (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    hash TEXT,
    size INTEGER NOT NULL,
    mtime_ms REAL NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('js','style','config')),
    category TEXT NOT NULL CHECK (category IN ('prod','test','story','config')),
    role TEXT,
    parse_error TEXT,
    skip_reason TEXT CHECK (skip_reason IS NULL OR skip_reason IN ('oversized','minified'))
  )`,
  `CREATE TABLE package (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    is_workspace INTEGER NOT NULL DEFAULT 0,
    declared INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE symbol (
    id INTEGER PRIMARY KEY,
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('file','package')),
    owner_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    UNIQUE (owner_kind, owner_id, name)
  )`,
  `CREATE TABLE import_edge (
    id INTEGER PRIMARY KEY,
    from_file INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
    specifier TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN (${EDGE_KINDS})),
    to_file INTEGER REFERENCES file(id) ON DELETE SET NULL,
    to_package INTEGER REFERENCES package(id) ON DELETE SET NULL,
    subpath TEXT,
    resolution TEXT NOT NULL CHECK (resolution IN ('resolved','external','builtin','unresolved')),
    confidence TEXT NOT NULL CHECK (confidence IN (${CONFIDENCES})),
    unresolved_reason TEXT,
    alias TEXT,
    line INTEGER NOT NULL,
    col INTEGER NOT NULL,
    snippet TEXT NOT NULL
  )`,
  `CREATE TABLE import_binding (
    id INTEGER PRIMARY KEY,
    edge_id INTEGER NOT NULL REFERENCES import_edge(id) ON DELETE CASCADE,
    local_name TEXT NOT NULL,
    imported_name TEXT NOT NULL,
    imported_symbol INTEGER REFERENCES symbol(id) ON DELETE SET NULL,
    is_type INTEGER NOT NULL DEFAULT 0
  )`,
  // exported_name '*' = `export * from`; imported_name '*' = whole module
  // (`export * from`, `export * as ns from`, re-exported namespace import).
  `CREATE TABLE reexport (
    id INTEGER PRIMARY KEY,
    from_file INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
    edge_id INTEGER NOT NULL REFERENCES import_edge(id) ON DELETE CASCADE,
    exported_name TEXT NOT NULL,
    imported_name TEXT NOT NULL,
    symbol INTEGER REFERENCES symbol(id) ON DELETE SET NULL,
    target_symbol INTEGER REFERENCES symbol(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE usage (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
    binding_id INTEGER REFERENCES import_binding(id) ON DELETE CASCADE,
    symbol INTEGER REFERENCES symbol(id) ON DELETE SET NULL,
    member TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('call','new','member','jsx','value')),
    line INTEGER NOT NULL,
    col INTEGER NOT NULL,
    snippet TEXT NOT NULL
  )`,
  `CREATE TABLE binding_reach (
    binding_id INTEGER NOT NULL REFERENCES import_binding(id) ON DELETE CASCADE,
    package_id INTEGER NOT NULL REFERENCES package(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    depth INTEGER NOT NULL,
    confidence TEXT NOT NULL CHECK (confidence IN (${CONFIDENCES})),
    PRIMARY KEY (binding_id, package_id, name)
  )`,
  `CREATE TABLE package_reach (
    package_id INTEGER NOT NULL REFERENCES package(id) ON DELETE CASCADE,
    file_id INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
    via TEXT NOT NULL CHECK (via IN ('direct','reexport','wrapper')),
    via_file_id INTEGER REFERENCES file(id) ON DELETE CASCADE,
    depth INTEGER NOT NULL,
    confidence TEXT NOT NULL CHECK (confidence IN (${CONFIDENCES})),
    PRIMARY KEY (package_id, file_id, via)
  )`,
  `CREATE INDEX idx_import_edge_from_file ON import_edge(from_file)`,
  `CREATE INDEX idx_import_edge_to_file ON import_edge(to_file)`,
  `CREATE INDEX idx_import_edge_to_package ON import_edge(to_package)`,
  `CREATE INDEX idx_import_binding_edge ON import_binding(edge_id)`,
  `CREATE INDEX idx_import_binding_symbol ON import_binding(imported_symbol)`,
  `CREATE INDEX idx_reexport_from_file ON reexport(from_file, exported_name)`,
  `CREATE INDEX idx_reexport_edge ON reexport(edge_id)`,
  `CREATE INDEX idx_reexport_symbol ON reexport(symbol)`,
  `CREATE INDEX idx_reexport_target_symbol ON reexport(target_symbol)`,
  `CREATE INDEX idx_usage_file ON usage(file_id)`,
  `CREATE INDEX idx_usage_symbol ON usage(symbol)`,
  `CREATE INDEX idx_usage_binding ON usage(binding_id)`,
  `CREATE INDEX idx_binding_reach_package ON binding_reach(package_id)`,
  `CREATE INDEX idx_package_reach_package ON package_reach(package_id)`,
  `CREATE INDEX idx_package_reach_file ON package_reach(file_id)`,
  `CREATE INDEX idx_package_reach_via_file ON package_reach(via_file_id)`
]);

/** Tables holding derived reach data, cleared and recomputed after every build. */
export const DERIVED_TABLES: readonly string[] = Object.freeze(['binding_reach', 'package_reach']);
