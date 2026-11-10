import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { createSandbox, type Sandbox } from '../helpers/sandbox';
import { copyGraphFixture } from '../helpers/graphFixture';
import { buildGraph, type BuildProgress } from '@/core/graph/build';
import { openGraphReader, type GraphDriver } from '@/core/graph/store';
import { dumpGraph } from '@/core/graph/dump';

let sandbox: Sandbox;
const readers: GraphDriver[] = [];

beforeEach(async () => {
  sandbox = await createSandbox('graph-build');
});

afterEach(async () => {
  for (const r of readers.splice(0)) r.close();
  await sandbox.dispose();
});

const lock = <T>(_key: string, fn: () => Promise<T>): Promise<T> => fn();

function reader(dbPath: string): GraphDriver {
  const r = openGraphReader(dbPath);
  readers.push(r);
  return r;
}

interface ReachRow {
  pkg: string;
  file: string;
  via: string;
  viaFile: string | null;
  depth: number;
  confidence: string;
}

function reach(db: GraphDriver, pkg: string): ReachRow[] {
  return db
    .prepare(
      `SELECT p.name AS pkg, f.path AS file, r.via, vf.path AS viaFile, r.depth, r.confidence
         FROM package_reach r JOIN package p ON p.id = r.package_id JOIN file f ON f.id = r.file_id
         LEFT JOIN file vf ON vf.id = r.via_file_id
        WHERE p.name = ? ORDER BY f.path, r.via`
    )
    .all(pkg)
    .map((r) => ({
      pkg: String(r.pkg),
      file: String(r.file),
      via: String(r.via),
      viaFile: r.viaFile === null ? null : String(r.viaFile),
      depth: Number(r.depth),
      confidence: String(r.confidence)
    }));
}

describe('buildGraph full (3a.7)', () => {
  it('builds wrapper-module: direct + wrapper reach rows for axios', async () => {
    const { projectRoot, dbPath } = await copyGraphFixture(sandbox, 'wrapper-module');
    const res = await buildGraph({ projectRoot, dbPath, mode: 'full', lock });
    expect(res.mode).toBe('full');
    expect(res.rebuildReason).toBe('new');
    expect(res.files).toBe(6);
    expect(res.durationMs).toBeGreaterThanOrEqual(0);

    const db = reader(dbPath);
    expect(reach(db, 'axios')).toEqual([
      { pkg: 'axios', file: 'src/components/Avatar.tsx', via: 'wrapper', viaFile: 'src/lib/http.ts', depth: 1, confidence: 'medium' },
      { pkg: 'axios', file: 'src/features/posts.ts', via: 'wrapper', viaFile: 'src/lib/http.ts', depth: 1, confidence: 'medium' },
      { pkg: 'axios', file: 'src/features/users.ts', via: 'wrapper', viaFile: 'src/lib/http.ts', depth: 1, confidence: 'medium' },
      { pkg: 'axios', file: 'src/lib/http.ts', via: 'direct', viaFile: null, depth: 0, confidence: 'medium' }
    ]);
  });

  it('builds barrel-reexport: reexport reach with chain depth and confidence', async () => {
    const { projectRoot, dbPath } = await copyGraphFixture(sandbox, 'barrel-reexport');
    await buildGraph({ projectRoot, dbPath, mode: 'full', lock });
    const db = reader(dbPath);
    const antd = reach(db, 'antd').filter((r) => r.via !== 'wrapper');
    expect(antd).toEqual([
      { pkg: 'antd', file: 'src/app/Local.tsx', via: 'reexport', viaFile: null, depth: 1, confidence: 'medium' },
      { pkg: 'antd', file: 'src/app/Ns.tsx', via: 'reexport', viaFile: null, depth: 2, confidence: 'medium' },
      { pkg: 'antd', file: 'src/app/Page.tsx', via: 'reexport', viaFile: null, depth: 3, confidence: 'medium' },
      { pkg: 'antd', file: 'src/ui/Button.tsx', via: 'direct', viaFile: null, depth: 0, confidence: 'medium' }
    ]);
    const lodash = reach(db, 'lodash').filter((r) => r.via !== 'wrapper');
    expect(lodash).toEqual([
      { pkg: 'lodash', file: 'src/app/Ns.tsx', via: 'reexport', viaFile: null, depth: 1, confidence: 'medium' },
      { pkg: 'lodash', file: 'src/app/Search.tsx', via: 'reexport', viaFile: null, depth: 1, confidence: 'medium' },
      { pkg: 'lodash', file: 'src/ui/index.ts', via: 'direct', viaFile: null, depth: 0, confidence: 'medium' }
    ]);
    // The binding-level origin keeps the final export name.
    const origin = db
      .prepare(
        `SELECT f.path AS file, br.name, br.depth FROM binding_reach br JOIN import_binding b ON b.id = br.binding_id
           JOIN import_edge e ON e.id = b.edge_id JOIN file f ON f.id = e.from_file JOIN package p ON p.id = br.package_id
          WHERE p.name = 'lodash' AND br.depth > 0 ORDER BY f.path`
      )
      .all()
      .map((r) => `${String(r.file)}:${String(r.name)}:${Number(r.depth)}`);
    expect(origin).toEqual(['src/app/Ns.tsx:default:1', 'src/app/Search.tsx:default:1']);
  });

  it('stores meta, file facts, edges with snippets and usages', async () => {
    const { projectRoot, dbPath } = await copyGraphFixture(sandbox, 'wrapper-module');
    await buildGraph({ projectRoot, dbPath, mode: 'full', lock });
    const db = reader(dbPath);
    const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((r) => [String(r.key), String(r.value)]));
    expect(meta).toMatchObject({
      schemaVersion: '1',
      parser: 'babel@7.24.7',
      resolver: 'oxc-resolver@11.24.2',
      rebuildReason: 'new'
    });
    expect(meta.builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(meta.resolverConfigHash).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.projectRootHash).toMatch(/^[0-9a-f]{64}$/);
    expect(meta).toHaveProperty('lockfileStateHash');

    const edge = db
      .prepare(
        `SELECT e.kind, e.resolution, e.confidence, e.line, e.col, e.snippet, p.name AS pkg, p.declared
           FROM import_edge e JOIN file f ON f.id = e.from_file JOIN package p ON p.id = e.to_package WHERE f.path = 'src/lib/http.ts'`
      )
      .get();
    expect(edge).toMatchObject({ kind: 'static', resolution: 'external', confidence: 'medium', line: 1, col: 0, snippet: "import axios from 'axios';", pkg: 'axios', declared: 1 });

    const usages = db
      .prepare(
        `SELECT u.member, u.kind, u.line, s.name AS symbol FROM usage u JOIN file f ON f.id = u.file_id
           LEFT JOIN symbol s ON s.id = u.symbol WHERE f.path = 'src/lib/http.ts' ORDER BY u.line`
      )
      .all()
      .map((r) => `${String(r.symbol)}.${String(r.member)}:${String(r.kind)}:${Number(r.line)}`);
    expect(usages).toEqual(['default.get:call:3', 'default.post:call:4']);

    const test = db.prepare("SELECT category, kind, role FROM file WHERE path = 'src/features/__tests__/users.test.ts'").get();
    expect(test).toMatchObject({ category: 'test', kind: 'js', role: null });
  });

  it('records roles from the next-app-router fixture (incl. package.json main → entry)', async () => {
    const { projectRoot, dbPath } = await copyGraphFixture(sandbox, 'next-app-router');
    await buildGraph({ projectRoot, dbPath, mode: 'full', lock });
    const db = reader(dbPath);
    const roles = db
      .prepare('SELECT path, role FROM file WHERE role IS NOT NULL ORDER BY path')
      .all()
      .map((r) => `${String(r.path)}=${String(r.role)}`);
    expect(roles).toEqual([
      'app/api/hello/route.ts=route',
      'app/dashboard/loading.tsx=loading',
      'app/layout.tsx=layout',
      'app/not-found.tsx=not-found',
      'app/page.tsx=page',
      'lib/main.js=entry',
      'middleware.ts=middleware',
      'pages/about.tsx=page',
      'pages/api/legacy.ts=api-route'
    ]);
  });

  it('is deterministic: two builds of the same tree give identical dumps (excluding builtAt)', async () => {
    const a = await copyGraphFixture(sandbox, 'barrel-reexport', 'det-a');
    await buildGraph({ projectRoot: a.projectRoot, dbPath: a.dbPath, mode: 'full', lock });
    const second = path.join(sandbox.libraryRoot, 'det-a-2', 'graph.db');
    await buildGraph({ projectRoot: a.projectRoot, dbPath: second, mode: 'full', lock });
    expect(dumpGraph(reader(second))).toEqual(dumpGraph(reader(a.dbPath)));
    // A rebuild into the same DB also reproduces it.
    const before = dumpGraph(reader(a.dbPath));
    await buildGraph({ projectRoot: a.projectRoot, dbPath: a.dbPath, mode: 'full', lock });
    expect(dumpGraph(reader(a.dbPath))).toEqual(before);
  });

  it('writes in one transaction: a reader never sees a half-built graph', async () => {
    const { projectRoot, dbPath } = await copyGraphFixture(sandbox, 'barrel-reexport');
    await buildGraph({ projectRoot, dbPath, mode: 'full', lock });
    const r = reader(dbPath);
    const before = dumpGraph(r);
    const seen: string[] = [];
    await buildGraph({
      projectRoot,
      dbPath,
      mode: 'full',
      lock,
      onProgress: (p: BuildProgress) => {
        if (p.phase === 'write') seen.push(JSON.stringify(dumpGraph(r)) === JSON.stringify(before) ? 'same' : 'changed');
      }
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s === 'same')).toBe(true);
  });

  it('abort before commit leaves the previous DB content unchanged', async () => {
    const { projectRoot, dbPath } = await copyGraphFixture(sandbox, 'wrapper-module');
    await buildGraph({ projectRoot, dbPath, mode: 'full', lock });
    const before = dumpGraph(reader(dbPath));
    const ac = new AbortController();
    await expect(
      buildGraph({
        projectRoot,
        dbPath,
        mode: 'full',
        lock,
        signal: ac.signal,
        onProgress: (p) => {
          if (p.phase === 'parse') ac.abort();
        }
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    const after = dumpGraph(reader(dbPath));
    expect(after).toEqual(before);
  });

  it('runs inside the injected lock with the given key', async () => {
    const { projectRoot, dbPath } = await copyGraphFixture(sandbox, 'index-files');
    const keys: string[] = [];
    await buildGraph({
      projectRoot,
      dbPath,
      mode: 'full',
      lockKey: 'graph:my-slug',
      lock: (k, fn) => {
        keys.push(k);
        return fn();
      }
    });
    expect(keys).toEqual(['graph:my-slug']);
  });

  it('counts unresolved edges', async () => {
    const { projectRoot, dbPath } = await copyGraphFixture(sandbox, 'index-files');
    const res = await buildGraph({ projectRoot, dbPath, mode: 'full', lock });
    expect(res.unresolved).toBe(1); // ./missing
    expect(res.edges).toBeGreaterThanOrEqual(5);
  });
});
