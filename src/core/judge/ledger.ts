/**
 * Jev (TypeSafe) spend ledger, HARD $0.50 (V2_STAGE5_SPEC 5b.5).
 *
 * Same mechanics as the Claude ledger in `src/core/spend/ledger.ts`, which
 * is frozen for Stage 5 and hard-codes its own `CAP_USD`, so this is a small
 * own module rather than a reuse:
 * - `JEV_CAP_USD` and `JEV_ROUND_ID` are code constants. No env var or flag
 *   raises the cap; a caller ceiling can only lower it. The file's `capUsd`
 *   is informational and ignored on load; totals are recomputed from entries.
 * - Reserve BEFORE each request (estimate = UTF-8 bytes of the serialized
 *   request as the token upper bound × price × 1.10), settle from
 *   `usage.input_tokens`. Null usage or a thrown error → the reservation
 *   stays counted (conservative). Output tokens are free.
 * - An unpriced requested model is refused.
 * - One process at a time: `<ledger>.lock` holds the pid (`wx`). A second live
 *   process is refused; a dead pid's lock is taken over and its open
 *   reservations still count.
 *
 * Files: eval `%LOCALAPPDATA%\dep-agent-eval\_spend\jev-round1.json`;
 * app `library/_spend/jev-round1.json` (same cap, separate file, Q-5.6).
 */
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { atomicWriteJson } from '../../lib/storage/atomic';

/** HARD cap for Jev spend per ledger file, in USD. Code constant. */
export const JEV_CAP_USD = 0.5;
export const JEV_ROUND_ID = 'jev-round1';
export const JEV_SAFETY_MARGIN = 1.1;
/** USD per input token (docs.typesafe.ai/models.md: $0.042 per M input tokens; output free). */
export const JEV_PRICES: Readonly<Record<string, number>> = Object.freeze({
  'jev-1.14.0': 0.042 / 1e6,
  'jev-1.13.0': 0.042 / 1e6
});

export class JevSpendCapError extends Error {
  readonly code = 'JEV_SPEND_CAP' as const;
  constructor(message: string) {
    super(message);
    this.name = 'JevSpendCapError';
  }
}

export class JevLedgerLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JevLedgerLockError';
  }
}

export interface JevLedgerEntry {
  id: string;
  at: string;
  step: string;
  use: string;
  caseId?: string;
  model: string;
  kind: 'reserve' | 'settle';
  usd: number;
  inputTokens?: number;
}

export interface JevLedgerState {
  roundId: string;
  capUsd: number;
  spentUsd: number;
  reservedUsd: number;
  remainingUsd: number;
}

export function isJevPriced(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(JEV_PRICES, model);
}

/** Worst-case cost of one request whose serialized size is `boundTokens` bytes. */
export function estimateJevUsd(model: string, boundTokens: number): number {
  const price = JEV_PRICES[model];
  if (price === undefined) throw new JevSpendCapError(`unpriced Jev model ${model}: refused`);
  return boundTokens * price * JEV_SAFETY_MARGIN;
}

export function jevLedgerPathEval(localAppData: string): string {
  return path.join(localAppData, 'dep-agent-eval', '_spend', `${JEV_ROUND_ID}.json`);
}

export function jevLedgerPathApp(libraryRoot: string): string {
  return path.join(libraryRoot, '_spend', `${JEV_ROUND_ID}.json`);
}

function round9(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}

function totals(entries: readonly JevLedgerEntry[]): { spentUsd: number; reservedUsd: number } {
  const settled = new Set(entries.filter((e) => e.kind === 'settle').map((e) => e.id));
  let spent = 0;
  let reserved = 0;
  for (const e of entries) {
    if (e.kind === 'settle') spent += e.usd;
    else if (!settled.has(e.id)) reserved += e.usd;
  }
  return { spentUsd: round9(spent), reservedUsd: round9(reserved) };
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
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
      if (processAlive(holder)) throw new JevLedgerLockError(`Jev ledger is in use by process ${holder} (${lockPath})`);
      await fs.rm(lockPath, { force: true });
    }
  }
  throw new JevLedgerLockError(`could not acquire the Jev ledger lock ${lockPath}`);
}

interface JevLedgerFile {
  roundId: string;
  capUsd: number;
  entries: JevLedgerEntry[];
  spentUsd: number;
  reservedUsd: number;
}

export class JevLedger {
  private closed = false;

  private constructor(
    readonly filePath: string,
    private readonly lockPath: string,
    private readonly data: JevLedgerFile
  ) {}

  static async open(filePath: string): Promise<JevLedger> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const lockPath = `${filePath}.lock`;
    await acquireLock(lockPath);
    try {
      let entries: JevLedgerEntry[] = [];
      try {
        const raw = JSON.parse(await fs.readFile(filePath, 'utf8')) as Partial<JevLedgerFile>;
        if (!Array.isArray(raw.entries)) throw new Error(`Jev ledger ${filePath} has no entries array`);
        entries = raw.entries;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      const ledger = new JevLedger(filePath, lockPath, { roundId: JEV_ROUND_ID, capUsd: JEV_CAP_USD, entries, ...totals(entries) });
      await ledger.persist();
      return ledger;
    } catch (err) {
      await fs.rm(lockPath, { force: true });
      throw err;
    }
  }

  state(): JevLedgerState {
    const t = totals(this.data.entries);
    return { roundId: JEV_ROUND_ID, capUsd: JEV_CAP_USD, ...t, remainingUsd: round9(JEV_CAP_USD - t.spentUsd - t.reservedUsd) };
  }

  entries(): readonly JevLedgerEntry[] {
    return this.data.entries;
  }

  /** Throws `JevSpendCapError` (nothing written) when the estimate would pass the cap or the lower ceiling. */
  async reserve(r: { step: string; use: string; caseId?: string; model: string; boundTokens: number; ceilingUsd?: number }): Promise<string> {
    this.assertOpen();
    const usd = estimateJevUsd(r.model, r.boundTokens);
    if (!Number.isFinite(usd) || usd < 0) throw new JevSpendCapError(`invalid reservation amount ${String(usd)}`);
    const limit = Math.min(JEV_CAP_USD, r.ceilingUsd ?? JEV_CAP_USD);
    const { spentUsd, reservedUsd } = totals(this.data.entries);
    const after = round9(spentUsd + reservedUsd + usd);
    if (after > limit) {
      throw new JevSpendCapError(
        `Jev spend cap: estimate $${usd.toFixed(6)} + spent $${spentUsd.toFixed(6)} + reserved $${reservedUsd.toFixed(6)} would pass $${limit.toFixed(2)}` +
          (limit < JEV_CAP_USD ? ` (step ceiling; cap $${JEV_CAP_USD})` : ' (cap)')
      );
    }
    const id = crypto.randomUUID();
    this.data.entries.push({ id, at: new Date().toISOString(), step: r.step, use: r.use, ...(r.caseId !== undefined ? { caseId: r.caseId } : {}), model: r.model, kind: 'reserve', usd: round9(usd) });
    await this.persist();
    return id;
  }

  /** Replaces a reservation with the cost from `usage.input_tokens` (priced at the requested model). */
  async settle(id: string, s: { model: string; inputTokens: number }): Promise<void> {
    this.assertOpen();
    const reservation = this.data.entries.find((e) => e.id === id && e.kind === 'reserve');
    if (reservation === undefined) throw new Error(`Jev ledger: no reservation ${id}`);
    if (this.data.entries.some((e) => e.id === id && e.kind === 'settle')) throw new Error(`Jev ledger: reservation ${id} already settled`);
    const price = JEV_PRICES[reservation.model] ?? JEV_PRICES[s.model];
    if (price === undefined) return; // unreachable: reserve refuses unpriced models; keep the reservation.
    this.data.entries.push({
      id,
      at: new Date().toISOString(),
      step: reservation.step,
      use: reservation.use,
      ...(reservation.caseId !== undefined ? { caseId: reservation.caseId } : {}),
      model: s.model,
      kind: 'settle',
      usd: round9(s.inputTokens * price),
      inputTokens: s.inputTokens
    });
    await this.persist();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await fs.rm(this.lockPath, { force: true });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Jev ledger is closed');
  }

  private async persist(): Promise<void> {
    const t = totals(this.data.entries);
    this.data.spentUsd = t.spentUsd;
    this.data.reservedUsd = t.reservedUsd;
    this.data.capUsd = JEV_CAP_USD;
    await atomicWriteJson(this.filePath, this.data);
  }
}

/** What the TypeSafe client needs from a ledger: reserve before, settle after. */
export interface JevSpendGate {
  reserve(r: { use: string; model: string; boundTokens: number }): Promise<string>;
  settle(id: string, s: { model: string; inputTokens: number }): Promise<void>;
}

/** Gate over a ledger held open for a whole session (eval). */
export function sessionGate(ledger: JevLedger, opts: { step: string; caseId?: string; ceilingUsd?: number }): JevSpendGate {
  return {
    reserve: (r) => ledger.reserve({ ...r, step: opts.step, ...(opts.caseId !== undefined ? { caseId: opts.caseId } : {}), ...(opts.ceilingUsd !== undefined ? { ceilingUsd: opts.ceilingUsd } : {}) }),
    settle: (id, s) => ledger.settle(id, s)
  };
}

/**
 * Gate that opens the ledger per operation (app: a long-lived server must not
 * hold the lock between requests). Operations of one gate run one at a time
 * (the chain lives on the gate object, which the app keeps on `globalThis`).
 */
export function perOperationGate(filePath: string, step: string): JevSpendGate {
  let chain: Promise<unknown> = Promise.resolve();
  const run = <T>(fn: (l: JevLedger) => Promise<T>): Promise<T> => {
    const next = chain.then(async () => {
      const l = await JevLedger.open(filePath);
      try {
        return await fn(l);
      } finally {
        await l.close();
      }
    });
    chain = next.catch(() => undefined);
    return next;
  };
  return {
    reserve: (r) => run((l) => l.reserve({ ...r, step })),
    settle: (id, s) => run((l) => l.settle(id, s))
  };
}
