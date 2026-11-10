/**
 * Graph store: the only module in src/core that touches the SQLite driver
 * (D2, V2_STAGE3_SPEC 3a.1). A `better-sqlite3` swap replaces
 * `NodeSqliteDriver` and nothing else.
 *
 * Lifecycle rules (graph.db is derived data, never migrated):
 *  - writer refuses a dbPath inside the project root (read-only target);
 *  - WAL, synchronous=NORMAL, foreign_keys=ON, busy_timeout=5000;
 *  - user_version != SCHEMA_VERSION → drop every table and recreate in one
 *    transaction (readers keep working on their snapshot);
 *  - corrupt / not-a-database → delete db + -wal + -shm and recreate.
 *
 * No module-scoped handles: callers own and close what they open.
 */
// `node:sqlite` only exists under the `node:` prefix. Turbopack (dev + build)
// externalizes it as a builtin; see V2_STAGE3_SPEC §1.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { existsSync, promises as fs } from 'fs';
import path from 'path';
import { SCHEMA_STATEMENTS, SCHEMA_VERSION } from './schema';

export type SqlValue = null | number | bigint | string | Uint8Array;
export type Row = Record<string, SqlValue>;

export interface GraphStatement {
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqlValue[]): Row | undefined;
  all(...params: SqlValue[]): Row[];
}

export interface GraphDriver {
  readonly dbPath: string;
  readonly readOnly: boolean;
  readonly inTransaction: boolean;
  exec(sql: string): void;
  prepare(sql: string): GraphStatement;
  /** Runs `fn` inside BEGIN IMMEDIATE … COMMIT; rolls back and rethrows on error. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

export type RebuildReason = 'schema' | 'corrupt' | 'new';

export interface GraphWriterHandle {
  db: GraphDriver;
  /** Why the tables were (re)created on this open, or null when the DB was current. */
  rebuildReason: RebuildReason | null;
}

export class GraphPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphPathError';
  }
}

export class GraphNotBuiltError extends Error {
  constructor(readonly dbPath: string) {
    super(`graph not built: no graph database at ${dbPath}`);
    this.name = 'GraphNotBuiltError';
  }
}

export class GraphDbLockedError extends Error {
  constructor(
    readonly dbPath: string,
    detail: string
  ) {
    super(`graph database is locked or in use: ${dbPath} (${detail})`);
    this.name = 'GraphDbLockedError';
  }
}

const BUSY_TIMEOUT_MS = 5000;
// SQLite primary result codes (https://sqlite.org/rescode.html).
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_CORRUPT = 11;
const SQLITE_CANTOPEN = 14;
const SQLITE_NOTADB = 26;

function sqliteCode(err: unknown): number | undefined {
  const code = (err as { errcode?: unknown } | null)?.errcode;
  // Extended result codes carry the primary code in the low byte.
  return typeof code === 'number' ? code & 0xff : undefined;
}

export function isBusyError(err: unknown): boolean {
  const c = sqliteCode(err);
  return c === SQLITE_BUSY || c === SQLITE_LOCKED;
}

function isCorruptError(err: unknown): boolean {
  const c = sqliteCode(err);
  return c === SQLITE_CORRUPT || c === SQLITE_NOTADB;
}

class NodeSqliteDriver implements GraphDriver {
  private readonly db: DatabaseSync;

  constructor(
    readonly dbPath: string,
    readonly readOnly: boolean,
    timeoutMs: number = BUSY_TIMEOUT_MS
  ) {
    this.db = new DatabaseSync(dbPath, { readOnly, timeout: timeoutMs, enableForeignKeyConstraints: true });
  }

  get inTransaction(): boolean {
    return this.db.isTransaction;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): GraphStatement {
    return new NodeSqliteStatement(this.db.prepare(sql));
  }

  transaction<T>(fn: () => T): T {
    try {
      this.db.exec('BEGIN IMMEDIATE');
    } catch (err) {
      if (isBusyError(err)) throw new GraphDbLockedError(this.dbPath, 'another writer holds the database');
      throw err;
    }
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}

class NodeSqliteStatement implements GraphStatement {
  constructor(private readonly stmt: StatementSync) {}

  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.stmt.run(...params);
  }

  get(...params: SqlValue[]): Row | undefined {
    return this.stmt.get(...params) as Row | undefined;
  }

  all(...params: SqlValue[]): Row[] {
    return this.stmt.all(...params) as Row[];
  }
}

/** Case-insensitive on win32 (NTFS default), exact elsewhere. */
function samePathKey(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(samePathKey(parent), samePathKey(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** realpath of the nearest existing ancestor, with the missing tail re-appended. */
async function realpathOfExistingPrefix(p: string): Promise<string> {
  const tail: string[] = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      const real = await fs.realpath(cur);
      return path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.join(cur, ...tail.reverse());
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Throws GraphPathError when `dbPath` lies inside `projectRoot` — the graph
 * build must never write under the target project (invariant #1).
 */
export async function assertDbOutsideProject(dbPath: string, projectRoot: string): Promise<void> {
  const resolvedDb = path.resolve(dbPath);
  const resolvedRoot = path.resolve(projectRoot);
  const realDb = await realpathOfExistingPrefix(resolvedDb);
  const realRoot = await realpathOfExistingPrefix(resolvedRoot);
  if (isInside(resolvedDb, resolvedRoot) || isInside(realDb, realRoot)) {
    throw new GraphPathError(
      `refusing to open graph database inside the target project: ${resolvedDb} is under ${resolvedRoot}`
    );
  }
}

const DELETE_RETRY_ATTEMPTS = 5;
const DELETE_RETRYABLE: readonly string[] = Object.freeze(['EPERM', 'EBUSY', 'EACCES']);

/** Same Windows EPERM/EBUSY retry shape as storage/atomic.ts renameWithRetry. */
async function rmWithRetry(file: string): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < DELETE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await fs.rm(file, { force: true });
      return;
    } catch (err) {
      lastError = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === undefined || !DELETE_RETRYABLE.includes(code)) break;
      await new Promise((r) => setTimeout(r, 10 * (attempt + 1) ** 2));
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new GraphDbLockedError(file, `could not delete: ${detail}`);
}

async function deleteDbFiles(dbPath: string): Promise<void> {
  for (const suffix of ['', '-wal', '-shm']) await rmWithRetry(`${dbPath}${suffix}`);
}

function openAndCheck(dbPath: string, timeoutMs: number): NodeSqliteDriver {
  const driver = new NodeSqliteDriver(dbPath, false, timeoutMs);
  try {
    // journal_mode=WAL is persistent; the rest are per connection.
    driver.exec('PRAGMA journal_mode = WAL');
    driver.exec('PRAGMA synchronous = NORMAL');
    driver.exec('PRAGMA foreign_keys = ON');
    driver.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(timeoutMs))}`);
    const check = driver.prepare('PRAGMA quick_check').get();
    if (check?.quick_check !== 'ok') {
      const err = new Error(`quick_check failed: ${String(check?.quick_check)}`) as Error & { errcode: number };
      err.errcode = SQLITE_CORRUPT;
      throw err;
    }
    return driver;
  } catch (err) {
    driver.close();
    throw err;
  }
}

function userVersion(db: GraphDriver): number {
  return Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
}

function tableCount(db: GraphDriver): number {
  const row = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get();
  return Number(row?.n ?? 0);
}

/** Drop every table, recreate the schema, stamp the version — one transaction. */
function recreateSchema(db: GraphDriver, reason: RebuildReason): void {
  // FK enforcement would turn DROP TABLE on a parent into a failing implicit
  // DELETE; the pragma is a no-op inside a transaction, so toggle it outside.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.transaction(() => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((r) => String(r.name));
      for (const t of tables) db.exec(`DROP TABLE IF EXISTS "${t.replace(/"/g, '""')}"`);
      for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
      const setMeta = db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      setMeta.run('schemaVersion', String(SCHEMA_VERSION));
      setMeta.run('rebuildReason', reason);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

export interface OpenGraphWriterOptions {
  dbPath: string;
  projectRoot: string;
  /** SQLite busy timeout (default 5000 ms); tests shorten it. */
  busyTimeoutMs?: number;
}

export async function openGraphWriter(opts: OpenGraphWriterOptions): Promise<GraphWriterHandle> {
  const dbPath = path.resolve(opts.dbPath);
  await assertDbOutsideProject(dbPath, opts.projectRoot);
  await fs.mkdir(path.dirname(dbPath), { recursive: true });

  const timeoutMs = opts.busyTimeoutMs ?? BUSY_TIMEOUT_MS;
  let reason: RebuildReason | null = null;
  let db: NodeSqliteDriver;
  try {
    db = openAndCheck(dbPath, timeoutMs);
  } catch (err) {
    if (isBusyError(err)) throw new GraphDbLockedError(dbPath, 'busy while opening');
    if (!isCorruptError(err)) throw err;
    await deleteDbFiles(dbPath);
    reason = 'corrupt';
    db = openAndCheck(dbPath, timeoutMs);
  }

  try {
    if (reason === null) {
      if (tableCount(db) === 0) reason = 'new';
      else if (userVersion(db) !== SCHEMA_VERSION) reason = 'schema';
    }
    if (reason !== null) recreateSchema(db, reason);
  } catch (err) {
    db.close();
    throw err;
  }
  return { db, rebuildReason: reason };
}

/** Opens a read-only handle; throws GraphNotBuiltError when the DB file does not exist. */
export function openGraphReader(dbPath: string): GraphDriver {
  const resolved = path.resolve(dbPath);
  if (!existsSync(resolved)) throw new GraphNotBuiltError(resolved);
  try {
    return new NodeSqliteDriver(resolved, true);
  } catch (err) {
    if (sqliteCode(err) === SQLITE_CANTOPEN) throw new GraphNotBuiltError(resolved);
    throw err;
  }
}
