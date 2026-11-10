import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { createSandbox, type Sandbox } from '../helpers/sandbox';
import { openGraphWriter, type GraphDriver } from '@/core/graph/store';
import { SCHEMA_VERSION } from '@/core/graph/schema';
import { createRows } from '@/core/graph/rows';

let sandbox: Sandbox;
let projectRoot: string;
let dbPath: string;
let db: GraphDriver | null = null;

beforeEach(async () => {
  sandbox = await createSandbox('graph-schema');
  projectRoot = await sandbox.scratch('proj');
  dbPath = path.join(sandbox.libraryRoot, 'proj', 'graph.db');
});

afterEach(async () => {
  db?.close();
  db = null;
  await sandbox.dispose();
});

const TABLES = [
  'meta',
  'file',
  'package',
  'symbol',
  'import_edge',
  'import_binding',
  'reexport',
  'usage',
  'binding_reach',
  'package_reach'
];

const INDEXES = [
  'idx_import_edge_from_file',
  'idx_import_edge_to_file',
  'idx_import_edge_to_package',
  'idx_import_binding_edge',
  'idx_import_binding_symbol',
  'idx_reexport_from_file',
  'idx_reexport_edge',
  'idx_usage_file',
  'idx_usage_symbol',
  'idx_usage_binding',
  'idx_binding_reach_package',
  'idx_package_reach_package',
  'idx_package_reach_file',
  'idx_package_reach_via_file'
];

function names(d: GraphDriver, type: 'table' | 'index'): string[] {
  return d
    .prepare(`SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all(type)
    .map((r) => String(r.name));
}

function count(d: GraphDriver, table: string): number {
  return Number(d.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0);
}

describe('graph schema (3a.2)', () => {
  it('schema version is 1', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  it('a fresh DB has every table and index', async () => {
    db = (await openGraphWriter({ dbPath, projectRoot })).db;
    expect(names(db, 'table')).toEqual([...TABLES].sort());
    expect(names(db, 'index')).toEqual(expect.arrayContaining(INDEXES));
  });

  it('deleting a file cascades its edges, bindings, reexports, usages and reach rows', async () => {
    db = (await openGraphWriter({ dbPath, projectRoot })).db;
    const rows = createRows(db);
    db.transaction(() => {
      const a = rows.insertFile({ path: 'src/a.ts', hash: 'h1', size: 10, mtimeMs: 1, kind: 'js', category: 'prod', role: null, parseError: null, skipReason: null });
      const b = rows.insertFile({ path: 'src/b.ts', hash: 'h2', size: 10, mtimeMs: 1, kind: 'js', category: 'prod', role: null, parseError: null, skipReason: null });
      const pkg = rows.upsertPackage('axios', { declared: true });
      const sym = rows.upsertSymbol('package', pkg, 'default');
      const edge = rows.insertEdge({ fromFile: a, specifier: 'axios', kind: 'static', toFile: null, toPackage: pkg, subpath: null, resolution: 'external', confidence: 'medium', unresolvedReason: null, alias: null, line: 1, col: 0, snippet: "import axios from 'axios';" });
      const binding = rows.insertBinding({ edgeId: edge, localName: 'axios', importedName: 'default', importedSymbol: sym, isType: false });
      rows.insertReexport({ fromFile: a, edgeId: edge, exportedName: 'default', importedName: 'default', symbol: null, targetSymbol: sym });
      rows.insertUsage({ fileId: a, bindingId: binding, symbol: sym, member: 'get', kind: 'call', line: 2, col: 0, snippet: 'axios.get()' });
      db!.prepare('INSERT INTO binding_reach (binding_id, package_id, name, depth, confidence) VALUES (?, ?, ?, 0, ?)').run(binding, pkg, 'default', 'high');
      db!.prepare("INSERT INTO package_reach (package_id, file_id, via, via_file_id, depth, confidence) VALUES (?, ?, 'direct', NULL, 0, 'high')").run(pkg, a);
      db!.prepare("INSERT INTO package_reach (package_id, file_id, via, via_file_id, depth, confidence) VALUES (?, ?, 'wrapper', ?, 1, 'high')").run(pkg, b, a);
    });

    for (const t of ['import_edge', 'import_binding', 'reexport', 'usage', 'binding_reach']) expect(count(db, t)).toBe(1);
    expect(count(db, 'package_reach')).toBe(2);

    db.transaction(() => rows.deleteFileByPath('src/a.ts'));

    for (const t of ['import_edge', 'import_binding', 'reexport', 'usage', 'binding_reach', 'package_reach']) {
      expect(count(db, t), t).toBe(0);
    }
    expect(count(db, 'file')).toBe(1);
    expect(count(db, 'package')).toBe(1);
  });

  it('meta helpers round-trip', async () => {
    db = (await openGraphWriter({ dbPath, projectRoot })).db;
    const rows = createRows(db);
    rows.setMeta('builtAt', '2026-11-10T00:00:00.000Z');
    expect(rows.getMeta('builtAt')).toBe('2026-11-10T00:00:00.000Z');
    expect(rows.getMeta('missing')).toBeNull();
    expect(rows.allMeta().schemaVersion).toBe('1');
  });

  it('an older schema version on disk triggers a full recreate with every table', async () => {
    const first = await openGraphWriter({ dbPath, projectRoot });
    first.db.exec('DROP TABLE package_reach');
    first.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
    first.db.close();
    const second = await openGraphWriter({ dbPath, projectRoot });
    db = second.db;
    expect(second.rebuildReason).toBe('schema');
    expect(names(db, 'table')).toEqual([...TABLES].sort());
  });

  it('rejects invalid enum values via CHECK constraints', async () => {
    db = (await openGraphWriter({ dbPath, projectRoot })).db;
    expect(() =>
      db!.prepare("INSERT INTO file (path, size, mtime_ms, kind, category) VALUES ('x', 1, 1, 'binary', 'prod')").run()
    ).toThrow();
  });
});
