/**
 * Stage 5c review r1: what the Jev steps (`eval judge`, `--use router`) write
 * into their public result files.
 *
 * - M1: `jevSpendSession` wraps `sessionGate` and counts the requests that
 *   passed the gate and the ones it refused, so the result carries the same
 *   `spend` block as the Claude agent files (spec §5: ledger state at start
 *   and end in every result file). `src/core/spend` and the Jev ledger itself
 *   are untouched; this only reads `JevLedger.state()`.
 * - m1: `publicCachePath` keeps the user profile out of result files: the
 *   eval cache lives under %LOCALAPPDATA%, whose absolute form contains the
 *   user name.
 */
import path from 'path';
import { JevSpendCapError, sessionGate, type JevLedger, type JevSpendGate } from '../../src/core/judge/ledger';
import type { SpendInfo } from './types';

export interface JevSpendSession {
  gate: JevSpendGate;
  spendInfo(): SpendInfo;
}

export function jevSpendSession(ledger: JevLedger, opts: { step: string; ceilingUsd?: number }): JevSpendSession {
  const inner = sessionGate(ledger, opts);
  const before = ledger.state();
  let requests = 0;
  let refusals = 0;
  return {
    gate: {
      reserve: async (r) => {
        try {
          const id = await inner.reserve(r);
          requests += 1;
          return id;
        } catch (err) {
          if (err instanceof JevSpendCapError) refusals += 1;
          throw err;
        }
      },
      settle: (id, s) => inner.settle(id, s)
    },
    spendInfo: () => {
      const s = ledger.state();
      return { roundId: s.roundId, capUsd: s.capUsd, spentBefore: before.spentUsd, spentAfter: s.spentUsd, reservedAfter: s.reservedUsd, refusals, requests };
    }
  };
}

/**
 * A cache dir as it may appear in a public result file: under %LOCALAPPDATA%
 * → `%LOCALAPPDATA%<rest>`; any other absolute path → its basename (it could
 * sit under the profile too); a relative path is kept.
 */
export function publicCachePath(p: string | null, opts: { localAppData?: string } = {}): string | null {
  if (p === null) return null;
  if (!path.isAbsolute(p)) return p;
  const abs = path.resolve(p);
  const lad = opts.localAppData !== undefined && opts.localAppData !== '' ? path.resolve(opts.localAppData) : null;
  if (lad !== null) {
    // Windows paths compare case-insensitively.
    const norm = (x: string) => (process.platform === 'win32' ? x.toLowerCase() : x);
    if (norm(abs) === norm(lad)) return '%LOCALAPPDATA%';
    if (norm(abs).startsWith(norm(lad + path.sep))) return path.join('%LOCALAPPDATA%', abs.slice(lad.length + 1));
  }
  return path.basename(abs);
}
