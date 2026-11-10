/**
 * Spend ledger for the Stage 4c real-API round (V2_STAGE4_SPEC 4c.1).
 *
 * One JSON file per round, OUTSIDE the repo
 * (`%LOCALAPPDATA%\dep-agent-eval\_spend\stage4-round1.json`). Every real
 * request first writes a `reserve` entry (its worst-case cost), then a
 * `settle` entry with the cost from the API-reported usage. A reservation
 * that never settles (the request threw without usage, or the process
 * crashed) stays counted: conservative on purpose.
 *
 * The cap is the code constant `CAP_USD`. Nothing else can raise it: the
 * file's own `capUsd` field is informational and ignored on load, there is
 * no env var, and a caller-supplied ceiling can only LOWER the limit.
 * Raising it needs a code change after the user agrees in chat.
 *
 * Totals are recomputed from the entries on every load (the stored
 * `spentUsd` / `reservedUsd` are a convenience for a person reading the file).
 *
 * One process at a time: `<ledger>.lock` is created with `wx` and holds the
 * pid. A second process refuses. A lock whose pid is no longer running
 * (crash) is taken over, the crashed run's open reservations still count.
 */
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
// Relative import: src/core has no `@/` alias (D23).
import { atomicWriteJson } from '../../lib/storage/atomic';
import type { TokenUsage } from '../../lib/llm/cost';

/** HARD cap for the whole Stage 4c round, in USD. Code constant: no env var or flag raises it. */
export const CAP_USD = 10;
export const ROUND_ID = 'stage4-round1';

export class SpendCapError extends Error {
  readonly code = 'SPEND_CAP' as const;
  constructor(message: string) {
    super(message);
    this.name = 'SpendCapError';
  }
}

export class LedgerLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerLockError';
  }
}

export interface LedgerEntry {
  id: string;
  at: string;
  step: string;
  caseId?: string;
  model: string;
  kind: 'reserve' | 'settle';
  usd: number;
  usage?: Required<TokenUsage>;
}

export interface LedgerFile {
  roundId: string;
  capUsd: number;
  entries: LedgerEntry[];
  spentUsd: number;
  reservedUsd: number;
}

export interface LedgerState {
  roundId: string;
  capUsd: number;
  spentUsd: number;
  reservedUsd: number;
  remainingUsd: number;
}

export function defaultLedgerPath(localAppData: string): string {
  return path.join(localAppData, 'dep-agent-eval', '_spend', `${ROUND_ID}.json`);
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/** settled ids → their settle; open reservations = reserves without a settle. */
function totals(entries: readonly LedgerEntry[]): { spentUsd: number; reservedUsd: number } {
  const settled = new Set(entries.filter((e) => e.kind === 'settle').map((e) => e.id));
  let spent = 0;
  let reserved = 0;
  for (const e of entries) {
    if (e.kind === 'settle') spent += e.usd;
    else if (!settled.has(e.id)) reserved += e.usd;
  }
  return { spentUsd: round6(spent), reservedUsd: round6(reserved) };
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function acquireLock(lockPath: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fh = await fs.open(lockPath, 'wx');
      try {
        await fh.writeFile(String(process.pid), 'utf8');
      } finally {
        await fh.close();
      }
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = Number.parseInt((await fs.readFile(lockPath, 'utf8').catch(() => '')).trim(), 10);
      if (processAlive(holder)) {
        throw new LedgerLockError(`spend ledger is in use by process ${holder} (${lockPath}); only one real run at a time`);
      }
      // Stale lock from a crashed run: take it over (its reservations stay counted).
      await fs.rm(lockPath, { force: true });
    }
  }
  throw new LedgerLockError(`could not acquire the spend ledger lock ${lockPath}`);
}

export class SpendLedger {
  private closed = false;

  private constructor(
    readonly filePath: string,
    private readonly lockPath: string,
    private readonly data: LedgerFile
  ) {}

  /** Locks the ledger for this process and loads it (creates an empty one when absent). */
  static async open(filePath: string): Promise<SpendLedger> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const lockPath = `${filePath}.lock`;
    await acquireLock(lockPath);
    try {
      let entries: LedgerEntry[] = [];
      let roundId = ROUND_ID;
      try {
        const raw = JSON.parse(await fs.readFile(filePath, 'utf8')) as Partial<LedgerFile>;
        if (!Array.isArray(raw.entries)) throw new Error(`spend ledger ${filePath} has no entries array`);
        entries = raw.entries;
        if (typeof raw.roundId === 'string') roundId = raw.roundId;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      const ledger = new SpendLedger(filePath, lockPath, { roundId, capUsd: CAP_USD, entries, ...totals(entries) });
      await ledger.persist();
      return ledger;
    } catch (err) {
      await fs.rm(lockPath, { force: true });
      throw err;
    }
  }

  state(): LedgerState {
    const t = totals(this.data.entries);
    return { roundId: this.data.roundId, capUsd: CAP_USD, ...t, remainingUsd: round6(CAP_USD - t.spentUsd - t.reservedUsd) };
  }

  entries(): readonly LedgerEntry[] {
    return this.data.entries;
  }

  /**
   * Writes a reservation BEFORE the request is sent. Throws `SpendCapError`
   * (nothing written) when spent + reserved + usd would pass the cap, or the
   * lower `ceilingUsd` when one is given.
   */
  async reserve(r: { step: string; caseId?: string; model: string; usd: number; ceilingUsd?: number }): Promise<string> {
    this.assertOpen();
    if (!Number.isFinite(r.usd) || r.usd < 0) throw new SpendCapError(`invalid reservation amount ${String(r.usd)}`);
    const limit = Math.min(CAP_USD, r.ceilingUsd ?? CAP_USD);
    const { spentUsd, reservedUsd } = totals(this.data.entries);
    const after = round6(spentUsd + reservedUsd + r.usd);
    if (after > limit) {
      throw new SpendCapError(
        `spend cap: request estimate $${r.usd.toFixed(4)} + spent $${spentUsd.toFixed(4)} + reserved $${reservedUsd.toFixed(4)} = $${after.toFixed(4)} would pass $${limit.toFixed(2)}` +
          (limit < CAP_USD ? ` (step ceiling; round cap $${CAP_USD})` : ' (round cap)')
      );
    }
    const id = crypto.randomUUID();
    this.data.entries.push({ id, at: new Date().toISOString(), step: r.step, ...(r.caseId !== undefined ? { caseId: r.caseId } : {}), model: r.model, kind: 'reserve', usd: round6(r.usd) });
    await this.persist();
    return id;
  }

  /** Replaces a reservation with the cost from API-reported usage. */
  async settle(id: string, s: { model: string; usd: number; usage: Required<TokenUsage> }): Promise<void> {
    this.assertOpen();
    const reservation = this.data.entries.find((e) => e.id === id && e.kind === 'reserve');
    if (reservation === undefined) throw new Error(`spend ledger: no reservation ${id}`);
    if (this.data.entries.some((e) => e.id === id && e.kind === 'settle')) throw new Error(`spend ledger: reservation ${id} already settled`);
    this.data.entries.push({
      id,
      at: new Date().toISOString(),
      step: reservation.step,
      ...(reservation.caseId !== undefined ? { caseId: reservation.caseId } : {}),
      model: s.model,
      kind: 'settle',
      usd: round6(s.usd),
      usage: { ...s.usage }
    });
    await this.persist();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await fs.rm(this.lockPath, { force: true });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('spend ledger is closed');
  }

  private async persist(): Promise<void> {
    const t = totals(this.data.entries);
    this.data.spentUsd = t.spentUsd;
    this.data.reservedUsd = t.reservedUsd;
    this.data.capUsd = CAP_USD;
    await atomicWriteJson(this.filePath, this.data);
  }
}
