/**
 * CVSS 3.x base score from a vector string (v2 Stage 5a.1).
 *
 * OSV `severity[].score` for `CVSS_V3` is the vector (`CVSS:3.1/AV:N/…`), not a
 * number, so the base score has to be computed. Implements the base equations
 * of the FIRST specifications:
 *   - v3.1: https://www.first.org/cvss/v3.1/specification-document (§7.1 equations,
 *     §7.4 weights, Appendix A integer-based Roundup)
 *   - v3.0: https://www.first.org/cvss/v3.0/specification-document (§8.1 equations;
 *     Roundup = smallest one-decimal number ≥ input, i.e. ceil(x × 10) / 10)
 * The two versions share the base weights and equations; only Roundup differs.
 *
 * Base score only: temporal/environmental metrics are allowed in the vector
 * and ignored. Anything malformed (missing / duplicate / unknown metric or
 * value, other prefix, CVSS v2 or v4) → null.
 */

type Version = '3.0' | '3.1';

const BASE_METRICS = ['AV', 'AC', 'PR', 'UI', 'S', 'C', 'I', 'A'] as const;
type BaseMetric = (typeof BASE_METRICS)[number];

/** Values allowed for the temporal + environmental metrics (validated, then ignored). */
const NON_BASE_VALUES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  E: ['X', 'U', 'P', 'F', 'H'],
  RL: ['X', 'O', 'T', 'W', 'U'],
  RC: ['X', 'U', 'R', 'C'],
  CR: ['X', 'L', 'M', 'H'],
  IR: ['X', 'L', 'M', 'H'],
  AR: ['X', 'L', 'M', 'H'],
  MAV: ['X', 'N', 'A', 'L', 'P'],
  MAC: ['X', 'L', 'H'],
  MPR: ['X', 'N', 'L', 'H'],
  MUI: ['X', 'N', 'R'],
  MS: ['X', 'U', 'C'],
  MC: ['X', 'N', 'L', 'H'],
  MI: ['X', 'N', 'L', 'H'],
  MA: ['X', 'N', 'L', 'H']
});

const AV: Readonly<Record<string, number>> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const AC: Readonly<Record<string, number>> = { L: 0.77, H: 0.44 };
const PR_UNCHANGED: Readonly<Record<string, number>> = { N: 0.85, L: 0.62, H: 0.27 };
const PR_CHANGED: Readonly<Record<string, number>> = { N: 0.85, L: 0.68, H: 0.5 };
const UI: Readonly<Record<string, number>> = { N: 0.85, R: 0.62 };
const CIA: Readonly<Record<string, number>> = { H: 0.56, L: 0.22, N: 0 };
const SCOPE = ['U', 'C'];

const BASE_VALUES: Readonly<Record<BaseMetric, readonly string[]>> = {
  AV: Object.keys(AV),
  AC: Object.keys(AC),
  PR: Object.keys(PR_UNCHANGED),
  UI: Object.keys(UI),
  S: SCOPE,
  C: Object.keys(CIA),
  I: Object.keys(CIA),
  A: Object.keys(CIA)
};

/** v3.1 Appendix A: integer arithmetic so float error (0.30000000000000004) does not round up a whole step. */
export function roundup31(input: number): number {
  const intInput = Math.round(input * 100_000);
  if (intInput % 10_000 === 0) return intInput / 100_000;
  return (Math.floor(intInput / 10_000) + 1) / 10;
}

/** v3.0: "the smallest number, specified to one decimal place, that is equal to or higher than its input". */
export function roundup30(input: number): number {
  return Math.ceil(input * 10) / 10;
}

function parseVector(vector: string): { version: Version; metrics: Record<BaseMetric, string> } | null {
  const parts = vector.trim().split('/');
  const head = parts.shift();
  if (head !== 'CVSS:3.0' && head !== 'CVSS:3.1') return null;
  const seen = new Map<string, string>();
  for (const part of parts) {
    const m = /^([A-Z]+):([A-Z])$/.exec(part);
    if (m === null) return null;
    const [, key, value] = m as unknown as [string, string, string];
    if (seen.has(key)) return null;
    const allowed = (BASE_VALUES as Record<string, readonly string[]>)[key] ?? NON_BASE_VALUES[key];
    if (allowed === undefined || !allowed.includes(value)) return null;
    seen.set(key, value);
  }
  const metrics = {} as Record<BaseMetric, string>;
  for (const k of BASE_METRICS) {
    const v = seen.get(k);
    if (v === undefined) return null;
    metrics[k] = v;
  }
  return { version: head === 'CVSS:3.0' ? '3.0' : '3.1', metrics };
}

/** CVSS 3.0 / 3.1 base score (0.0–10.0), or null when the string is not a valid 3.x vector. */
export function cvss3BaseScore(vector: string): number | null {
  if (typeof vector !== 'string') return null;
  const parsed = parseVector(vector);
  if (parsed === null) return null;
  const { version, metrics: m } = parsed;
  const changed = m.S === 'C';
  const iss = 1 - (1 - CIA[m.C]!) * (1 - CIA[m.I]!) * (1 - CIA[m.A]!);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) : 6.42 * iss;
  const exploitability = 8.22 * AV[m.AV]! * AC[m.AC]! * (changed ? PR_CHANGED : PR_UNCHANGED)[m.PR]! * UI[m.UI]!;
  if (impact <= 0) return 0;
  const roundup = version === '3.1' ? roundup31 : roundup30;
  const sum = changed ? 1.08 * (impact + exploitability) : impact + exploitability;
  return roundup(Math.min(sum, 10));
}
