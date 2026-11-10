import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createSandbox, type Sandbox } from '../helpers/sandbox';
import {
  openGraphWriter,
  openGraphReader,
  GraphPathError,
  GraphNotBuiltError,
  type GraphDriver
} from '@/core/graph/store';
import { SCHEMA_VERSION } from '@/core/graph/schema';

let sandbox: Sandbox;
let projectRoot: string;
let dbPath: string;
const open: GraphDriver[] = [];

function track<T extends GraphDriver | { db: GraphDriver }>(h: T): T {
  open.push('db' in h ? h.db : h);
  return h;
}

beforeEach(async () => {
  sandbox = await createSandbox('graph-store');
  projectRoot = await sandbox.scratch('proj');
  await fs.writeFile(path.join(projectRoot, 'index.ts'), 'export const a = 1;\n');
  dbPath = path.join(sandbox.libraryRoot, 'proj', 'graph.db');
});

afterEach(async () => {
  for (const h of open.splice(0)) h.close();
  await sandbox.dispose();
});

function metaValue(db: GraphDriver, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row === undefined ? undefined : String(row.value);
}

describe('graph store (3a.1)', () => {
  it('opens a new writer in WAL mode with rebuildReason=new', async () => {
    const w = track(await openGraphWriter({ dbPath, projectRoot }));
    expect(w.rebuildReason).toBe('new');
    expect(w.db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
    expect(w.db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
    expect(w.db.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION);
    expect(metaValue(w.db, 'rebuildReason')).toBe('new');
    expect(metaValue(w.db, 'schemaVersion')).toBe(String(SCHEMA_VERSION));
  });

  it('reopening a current DB reports no rebuild', async () => {
    track(await openGraphWriter({ dbPath, projectRoot })).db.close();
    open.length = 0;
    const w = track(await openGraphWriter({ dbPath, projectRoot }));
    expect(w.rebuildReason).toBeNull();
  });

  it('refuses a dbPath inside the project root and creates nothing there', async () => {
    const before = await fs.readdir(projectRoot, { recursive: true });
    const inside = path.join(projectRoot, '.graph', 'graph.db');
    await expect(openGraphWriter({ dbPath: inside, projectRoot })).rejects.toBeInstanceOf(GraphPathError);
    // Case-insensitive containment on win32: an upper-cased root is still the same folder.
    if (process.platform === 'win32') {
      await expect(
        openGraphWriter({ dbPath: path.join(projectRoot.toUpperCase(), 'graph.db'), projectRoot })
      ).rejects.toBeInstanceOf(GraphPathError);
    }
    expect(await fs.readdir(projectRoot, { recursive: true })).toEqual(before);
  });

  it('refuses a dbPath equal to the project root itself', async () => {
    await expect(openGraphWriter({ dbPath: projectRoot, projectRoot })).rejects.toBeInstanceOf(GraphPathError);
  });

  it('reader on a missing DB throws GraphNotBuiltError', () => {
    expect(() => openGraphReader(dbPath)).toThrow(GraphNotBuiltError);
  });

  it('reader is read-only', async () => {
    track(await openGraphWriter({ dbPath, projectRoot }));
    const r = track(openGraphReader(dbPath));
    expect(metaValue(r, 'schemaVersion')).toBe(String(SCHEMA_VERSION));
    expect(() => r.exec("INSERT INTO meta(key, value) VALUES ('x', 'y')")).toThrow();
  });

  it('schema-version mismatch drops and recreates tables (rebuildReason=schema)', async () => {
    const w1 = await openGraphWriter({ dbPath, projectRoot });
    w1.db.exec("INSERT INTO meta(key, value) VALUES ('stale', '1')");
    w1.db.exec('CREATE TABLE leftover (x INTEGER)');
    w1.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    w1.db.close();

    const w2 = track(await openGraphWriter({ dbPath, projectRoot }));
    expect(w2.rebuildReason).toBe('schema');
    expect(metaValue(w2.db, 'stale')).toBeUndefined();
    expect(metaValue(w2.db, 'rebuildReason')).toBe('schema');
    const leftover = w2.db.prepare("SELECT name FROM sqlite_master WHERE name = 'leftover'").get();
    expect(leftover).toBeUndefined();
    expect(w2.db.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION);
  });

  it('schema rebuild works while a reader holds a handle', async () => {
    const w1 = await openGraphWriter({ dbPath, projectRoot });
    w1.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    w1.db.close();
    const r = track(openGraphReader(dbPath));
    const w2 = track(await openGraphWriter({ dbPath, projectRoot }));
    expect(w2.rebuildReason).toBe('schema');
    expect(metaValue(r, 'rebuildReason')).toBe('schema');
  });

  it('a garbage-bytes file is deleted and rebuilt (rebuildReason=corrupt)', async () => {
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    await fs.writeFile(dbPath, Buffer.from('this is not an sqlite database '.repeat(200)));
    await fs.writeFile(`${dbPath}-wal`, Buffer.from('junk'));
    const w = track(await openGraphWriter({ dbPath, projectRoot }));
    expect(w.rebuildReason).toBe('corrupt');
    expect(metaValue(w.db, 'rebuildReason')).toBe('corrupt');
    expect(w.db.prepare('PRAGMA quick_check').get()?.quick_check).toBe('ok');
  });

  it('a reader opened before a write transaction sees the old value until commit (WAL snapshot)', async () => {
    const w = track(await openGraphWriter({ dbPath, projectRoot }));
    w.db.exec("INSERT INTO meta(key, value) VALUES ('probe', 'old')");
    const r = track(openGraphReader(dbPath));
    expect(metaValue(r, 'probe')).toBe('old');

    w.db.transaction(() => {
      w.db.prepare("UPDATE meta SET value = 'new' WHERE key = 'probe'").run();
      expect(metaValue(r, 'probe')).toBe('old');
    });
    expect(metaValue(r, 'probe')).toBe('new');
  });

  it('transaction rolls back on throw', async () => {
    const w = track(await openGraphWriter({ dbPath, projectRoot }));
    expect(() =>
      w.db.transaction(() => {
        w.db.exec("INSERT INTO meta(key, value) VALUES ('rolled', 'x')");
        throw new Error('boom');
      })
    ).toThrow('boom');
    expect(metaValue(w.db, 'rolled')).toBeUndefined();
    expect(w.db.inTransaction).toBe(false);
  });
});
