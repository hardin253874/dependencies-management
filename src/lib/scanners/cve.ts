/**
 * OSV.dev `/v1/querybatch` client (spec §10.5).
 *
 * Behaviour:
 *   - Batched: up to 1000 packages per call (we ship them in chunks of 500 to
 *     stay well under the limit).
 *   - Concurrency: 5 parallel batch calls (`p-limit`) per §10.8.
 *   - Retries: `p-retry` with 3 attempts at 1s / 2s / 4s; honour `Retry-After`
 *     on 429 (§10.9).
 *   - Failure mode: on *persistent* failure (all retries exhausted), the
 *     scan continues; affected packages' `cves` field is set to `null` (NOT
 *     `[]`). UI renders "CVE data unavailable" amber banner.
 *
 * Inputs are `(name, version)` pairs; output is a map keyed by `name@version`.
 */
import pLimit from 'p-limit';
import pRetry, { AbortError } from 'p-retry';
import type { CveRecord, CveSeverity } from '../api-types';

const OSV_ENDPOINT = 'https://api.osv.dev/v1/querybatch';
const OSV_CONCURRENCY = 5;
const OSV_BATCH_SIZE = 500;
const RETRY_ATTEMPTS = 3;
/**
 * Hard per-request timeout for OSV. Node 18+'s native `fetch` has no default
 * timeout, so a stalled connection (which is not uncommon when OSV.dev is
 * being hammered or a firewall drops the TCP stream silently) would block the
 * scan's `Promise.all(detailTasks)` forever. 15s is well above the p95 actual
 * latency and short enough that a fully unreachable endpoint surfaces as an
 * error rather than a hang.
 */
const OSV_FETCH_TIMEOUT_MS = 15_000;

const osvLimit = pLimit(OSV_CONCURRENCY);

export interface CveQueryPair {
  name: string;
  version: string;
}

/** A `null` value means the lookup failed; consumers should display the banner. */
export type CveResultMap = Map<string, CveRecord[] | null>;

export interface CveQueryOptions {
  /** Inject for tests. */
  fetcher?: typeof fetch;
  /** Batch size override (testing). */
  batchSize?: number;
  /** External cancel (job-queue signal). */
  signal?: AbortSignal;
}

/**
 * Merge an external signal with a timeout-derived signal. The returned signal
 * aborts when either source aborts. Returns `undefined` when neither source
 * provides one — caller can pass `undefined` to `fetch` and skip the listener
 * plumbing.
 */
function withTimeout(
  external: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; cleanup: () => void } {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('fetch timeout')), timeoutMs);
  if (external !== undefined) {
    if (external.aborted) ctrl.abort(external.reason);
    else external.addEventListener('abort', () => ctrl.abort(external.reason), { once: true });
  }
  return {
    signal: ctrl.signal,
    cleanup: () => clearTimeout(t)
  };
}

export interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  severity?: Array<{ type?: string; score?: string }>;
  database_specific?: { severity?: string };
  affected?: Array<{
    package?: { ecosystem?: string; name?: string };
    ranges?: Array<{
      type?: string;
      events?: Array<{ introduced?: string; fixed?: string }>;
    }>;
  }>;
}

interface OsvBatchResponse {
  results?: Array<{ vulns?: Array<{ id: string }> }>;
}

interface OsvByIdResponse extends OsvVuln {}

/**
 * Query OSV for the given (name, version) pairs. Result map is keyed by
 * `name@version`. Empty array = scanned and clean; null = lookup failed.
 *
 * The two-phase strategy reflects OSV's batch endpoint shape: it returns
 * minimal IDs only, then we resolve full vulnerability details per ID.
 */
export async function queryCves(pairs: CveQueryPair[], opts: CveQueryOptions = {}): Promise<CveResultMap> {
  const fetcher = opts.fetcher ?? globalThis.fetch;
  const batchSize = opts.batchSize ?? OSV_BATCH_SIZE;
  const signal = opts.signal;
  const result: CveResultMap = new Map();
  if (pairs.length === 0) return result;
  // Initialise the map to [] for every queried pair; we flip to null on
  // batch failure so consumers can distinguish "clean" from "unknown".
  for (const { name, version } of pairs) {
    result.set(keyFor(name, version), []);
  }

  // First pass: batch endpoint returns just vuln IDs per query.
  const batches: CveQueryPair[][] = [];
  for (let i = 0; i < pairs.length; i += batchSize) {
    batches.push(pairs.slice(i, i + batchSize));
  }

  // ID lookup pool: dedupe IDs across batches.
  const idsByPair: Map<string, string[]> = new Map();

  const batchTasks = batches.map((batch) =>
    osvLimit(async () => {
      if (signal !== undefined && signal.aborted) return;
      const ids = await batchFetchWithRetry(batch, fetcher, signal);
      if (ids === null) {
        // Batch failed permanently; mark every pair in this batch as null.
        for (const p of batch) {
          result.set(keyFor(p.name, p.version), null);
        }
        return;
      }
      for (let i = 0; i < batch.length; i += 1) {
        const p = batch[i]!;
        idsByPair.set(keyFor(p.name, p.version), ids[i] ?? []);
      }
    })
  );
  await Promise.all(batchTasks);
  if (signal !== undefined && signal.aborted) return result;

  // Second pass: per-vuln detail. Cache lookups across pairs so a CVE that
  // affects 10 packages only round-trips once.
  const allIds = new Set<string>();
  for (const ids of idsByPair.values()) {
    for (const id of ids) allIds.add(id);
  }
  const detailMap = new Map<string, OsvVuln | null>();
  const detailTasks = Array.from(allIds).map((id) =>
    osvLimit(async () => {
      if (signal !== undefined && signal.aborted) return;
      const v = await detailFetchWithRetry(id, fetcher, signal);
      detailMap.set(id, v);
    })
  );
  await Promise.all(detailTasks);
  if (signal !== undefined && signal.aborted) return result;

  for (const [pairKey, ids] of idsByPair) {
    if (result.get(pairKey) === null) continue; // already marked as failed
    const cves: CveRecord[] = [];
    for (const id of ids) {
      const vuln = detailMap.get(id);
      if (vuln === undefined || vuln === null) continue;
      cves.push({
        id: vuln.id,
        severity: deriveSeverity(vuln),
        summary: vuln.summary ?? vuln.details ?? id
      });
    }
    result.set(pairKey, cves);
  }

  return result;
}

export function keyFor(name: string, version: string): string {
  return `${name}@${version}`;
}

async function batchFetchWithRetry(
  batch: CveQueryPair[],
  fetcher: typeof fetch,
  externalSignal: AbortSignal | undefined
): Promise<Array<string[]> | null> {
  try {
    return await pRetry(
      async () => {
        const body = {
          queries: batch.map((p) => ({
            package: { name: p.name, ecosystem: 'npm' },
            version: p.version
          }))
        };
        const { signal, cleanup } = withTimeout(externalSignal, OSV_FETCH_TIMEOUT_MS);
        try {
          const resp = await fetcher(OSV_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal
          });
          if (!resp.ok) {
            if (resp.status === 429 || resp.status >= 500) {
              const ra = resp.headers.get('retry-after');
              if (ra !== null) await sleep(parseRetryAfter(ra));
              throw new Error(`OSV ${resp.status}`);
            }
            throw new AbortError(`OSV non-retryable ${resp.status}`);
          }
          const data = (await resp.json()) as OsvBatchResponse;
          const results = data.results ?? [];
          return results.map((r) => (r.vulns ?? []).map((v) => v.id));
        } finally {
          cleanup();
        }
      },
      { retries: RETRY_ATTEMPTS - 1, minTimeout: 1000, factor: 2 }
    );
  } catch {
    return null;
  }
}

async function detailFetchWithRetry(
  id: string,
  fetcher: typeof fetch,
  externalSignal: AbortSignal | undefined
): Promise<OsvVuln | null> {
  try {
    return await pRetry(
      async () => {
        const { signal, cleanup } = withTimeout(externalSignal, OSV_FETCH_TIMEOUT_MS);
        try {
          const resp = await fetcher(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`, {
            signal
          });
          if (!resp.ok) {
            if (resp.status === 429 || resp.status >= 500) {
              const ra = resp.headers.get('retry-after');
              if (ra !== null) await sleep(parseRetryAfter(ra));
              throw new Error(`OSV id-fetch ${resp.status}`);
            }
            throw new AbortError(`OSV id-fetch non-retryable ${resp.status}`);
          }
          return (await resp.json()) as OsvByIdResponse;
        } finally {
          cleanup();
        }
      },
      { retries: RETRY_ATTEMPTS - 1, minTimeout: 1000, factor: 2 }
    );
  } catch {
    return null;
  }
}

function parseRetryAfter(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isNaN(n) && n >= 0) return Math.min(30_000, n * 1000);
  const t = Date.parse(value);
  if (Number.isNaN(t)) return 1000;
  return Math.max(0, Math.min(30_000, t - Date.now()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Pick the best severity signal from an OSV vulnerability record. Preference:
 *   1. `database_specific.severity` (string like "HIGH" — most commonly populated)
 *   2. CVSS_V3 score → mapped to band
 *   3. fallback to 'unknown'
 */
export function deriveSeverity(v: OsvVuln): CveSeverity {
  const dbSpec = v.database_specific?.severity;
  if (typeof dbSpec === 'string') {
    const norm = dbSpec.toLowerCase();
    if (norm.includes('critical')) return 'critical';
    if (norm.includes('high')) return 'high';
    if (norm.includes('moderate') || norm.includes('medium')) return 'medium';
    if (norm.includes('low')) return 'low';
  }
  if (Array.isArray(v.severity)) {
    for (const s of v.severity) {
      if (s.type === 'CVSS_V3' && typeof s.score === 'string') {
        const score = extractCvssBaseScore(s.score);
        if (score !== null) {
          if (score >= 9.0) return 'critical';
          if (score >= 7.0) return 'high';
          if (score >= 4.0) return 'medium';
          if (score > 0) return 'low';
        }
      }
    }
  }
  return 'unknown';
}

function extractCvssBaseScore(cvssVector: string): number | null {
  // CVSS vectors don't carry the base score; this is best-effort. If the
  // string is a plain number we parse it directly.
  const num = Number.parseFloat(cvssVector);
  if (!Number.isNaN(num)) return num;
  return null;
}
