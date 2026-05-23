/**
 * npm registry client (spec §10.4).
 *
 * Uses `npm-registry-fetch` so target `.npmrc` is honoured via the `cwd` opt.
 * Falls back to `~/.npmrc`, then `/etc/npmrc`, then public registry.
 *
 * Retries:
 *   - `p-retry` with 3 attempts at 1s / 2s / 4s backoff (§10.9).
 *   - On HTTP 429, honour `Retry-After` if present.
 * Concurrency:
 *   - 10 parallel calls (`p-limit`) per §10.8 — exposed via `withRegistryLimit`.
 *
 * Output shape is the subset of registry packument we actually need for views
 * [A] / [B]. We avoid leaking the full packument to keep `deps/*.json` tight.
 */
import pLimit from 'p-limit';
import pRetry, { AbortError } from 'p-retry';

const REGISTRY_CONCURRENCY = 10;
const RETRY_ATTEMPTS = 3;
/**
 * Per-request hard timeout for `npm-registry-fetch`. Without this a single
 * stalled connection can hang the entire `Promise.all` over all direct deps —
 * which has been observed in practice on certain registries / network
 * configurations. 20 s is well above typical p95 packument latency.
 */
const REGISTRY_FETCH_TIMEOUT_MS = 20_000;
/** Backoff per attempt: 1s, 2s, 4s. */
function backoffFor(attempt: number): number {
  return 1000 * 2 ** (attempt - 1);
}

const registryLimit = pLimit(REGISTRY_CONCURRENCY);

/** Test hook to override the concurrency cap (e.g. when unit-testing). */
export function setRegistryConcurrency(_n: number): void {
  // p-limit doesn't expose mutable concurrency on older versions. We expose
  // this hook for future use; tests can use withRegistryLimit() directly.
}

export function withRegistryLimit<T>(fn: () => Promise<T>): Promise<T> {
  return registryLimit(fn);
}

export interface RegistryFetcher {
  fetchPackument: (name: string) => Promise<RegistryPackument>;
}

export interface RegistryFetchOptions {
  /**
   * The target project's directory. `npm-registry-fetch` reads `.npmrc`
   * starting from this cwd, walking up. Falls back to the global config.
   */
  cwd: string;
  /** Optional custom fetcher (for tests). */
  fetcher?: (url: string, opts: NpmFetchOpts) => Promise<NpmFetchResponse>;
  /** Optional retry budget override (default 3). */
  retryAttempts?: number;
}

export interface RegistryPackument {
  name: string;
  versions: RegistryVersion[];
  /** Map of dist-tag → version, e.g. `{ latest: '19.0.0' }`. */
  distTags: Record<string, string>;
  /**
   * Deprecation message from the package's "latest" version, when present.
   * When deprecation is at the version level (most common), we surface the
   * message that applies to the latest published version.
   */
  deprecation: string | null;
  homepage: string | null;
  repository: string | null;
  license: string | null;
  /** ISO timestamp of the most recent publish, when registry reports it. */
  lastPublishAt: string | null;
  /**
   * Latest version's `peerDependencies` map. Cached in `deps/<name>.json` so
   * the view-[A] refresh of *another* dep can ask "does anyone's latest peer
   * us?" without re-fetching every packument. Empty when absent.
   */
  latestPeerDependencies: Record<string, string>;
  /**
   * Latest version's `engines` map (e.g. `{ node: '>=18.17' }`). Cached in
   * `deps/<name>.json` so the view-[A] refresh of `node` / `npm` / `yarn`
   * can ask "which project deps care about my toolchain?" Empty when absent.
   */
  latestEngines: Record<string, string>;
}

export interface RegistryVersion {
  version: string;
  publishedAt: string | null;
  isPrerelease: boolean;
  deprecated: string | null;
  /**
   * Peer dependencies declared by this version's `package.json`. Populated for
   * Stage 4 deep-scan use (spec §11.6 peer-dep satisfaction). Empty object when
   * absent — never undefined, so consumers can call `Object.entries` safely.
   */
  peerDependencies: Record<string, string>;
  /**
   * `engines` map declared by this version's `package.json`, e.g.
   * `{ node: '>=18.17', npm: '>=10' }`. Empty when absent.
   */
  engines: Record<string, string>;
}

interface NpmPackumentTime {
  modified?: string;
  created?: string;
  [version: string]: string | undefined;
}

interface NpmPackumentVersion {
  version: string;
  deprecated?: string;
  license?: string | { type?: string };
  homepage?: string;
  repository?: string | { url?: string };
  peerDependencies?: Record<string, string>;
  engines?: Record<string, string>;
}

interface NpmPackument {
  name?: string;
  'dist-tags'?: Record<string, string>;
  time?: NpmPackumentTime;
  versions?: Record<string, NpmPackumentVersion>;
  homepage?: string;
  repository?: string | { url?: string };
  license?: string | { type?: string };
}

interface NpmFetchOpts {
  cwd?: string;
  /** Per-request hard timeout in ms. Honoured by npm-registry-fetch. */
  timeout?: number;
  // Other npm-registry-fetch opts allowed but unused in this thin wrapper.
}

interface NpmFetchResponse {
  json: () => Promise<unknown>;
  status: number;
  statusText: string;
  headers: { get: (name: string) => string | null };
}

/**
 * Build a fetcher backed by `npm-registry-fetch`. The dynamic import keeps the
 * static dependency graph lean during tests that inject their own fetcher.
 */
async function loadNpmRegistryFetch(): Promise<(url: string, opts: NpmFetchOpts) => Promise<NpmFetchResponse>> {
  const mod: unknown = await import('npm-registry-fetch');
  if (typeof mod === 'function') {
    return mod as (url: string, opts: NpmFetchOpts) => Promise<NpmFetchResponse>;
  }
  if (mod !== null && typeof mod === 'object') {
    const m = mod as { default?: unknown };
    if (typeof m.default === 'function') {
      return m.default as (url: string, opts: NpmFetchOpts) => Promise<NpmFetchResponse>;
    }
  }
  throw new Error('npm-registry-fetch did not export a callable function');
}

class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly retryAfterSec: number | null) {
    super(message);
  }
}

/**
 * Sleep the lesser of `Retry-After` and the standard exponential backoff. We
 * cap at 30s so a misbehaving header doesn't make a scan hang forever.
 */
function chooseDelayMs(attempt: number, retryAfterSec: number | null): number {
  const backoff = backoffFor(attempt);
  if (retryAfterSec === null) return backoff;
  return Math.min(30_000, Math.max(backoff, retryAfterSec * 1000));
}

async function fetchPackumentRaw(
  name: string,
  fetcher: (url: string, opts: NpmFetchOpts) => Promise<NpmFetchResponse>,
  cwd: string
): Promise<NpmPackument> {
  // npm-registry-fetch supports the bare package name (it resolves the registry
  // from .npmrc + the auth chain). We pass `/<name>` so scoped names like
  // `@types/react` are routed correctly without our own URL encoding.
  const url = `/${name}`;
  const resp = await fetcher(url, { cwd, timeout: REGISTRY_FETCH_TIMEOUT_MS });
  if (resp.status >= 400) {
    const ra = resp.headers.get('retry-after');
    const retryAfterSec = ra === null ? null : parseRetryAfter(ra);
    throw new HttpError(resp.status, `${resp.status} ${resp.statusText}`, retryAfterSec);
  }
  const body = (await resp.json()) as NpmPackument;
  return body;
}

function parseRetryAfter(value: string): number | null {
  const n = Number.parseInt(value, 10);
  if (!Number.isNaN(n) && n >= 0) return n;
  // HTTP-date format (rare in practice for registries).
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((t - Date.now()) / 1000));
}

/**
 * The default RegistryFetcher used in production. Wraps `fetchPackumentRaw` in
 * `p-retry` with `Retry-After` honoring. Per-package calls are also throttled
 * via the module-level `p-limit` cap.
 */
export function createRegistryFetcher(opts: RegistryFetchOptions): RegistryFetcher {
  const retryAttempts = opts.retryAttempts ?? RETRY_ATTEMPTS;
  let fetcherPromise: Promise<(url: string, o: NpmFetchOpts) => Promise<NpmFetchResponse>> | null = null;
  const getFetcher = (): Promise<(url: string, o: NpmFetchOpts) => Promise<NpmFetchResponse>> => {
    if (opts.fetcher !== undefined) {
      return Promise.resolve(opts.fetcher);
    }
    if (fetcherPromise === null) fetcherPromise = loadNpmRegistryFetch();
    return fetcherPromise;
  };

  return {
    fetchPackument: async (name) => {
      let attempt = 0;
      return pRetry(
        async () => {
          attempt += 1;
          const fetcher = await getFetcher();
          try {
            const raw = await fetchPackumentRaw(name, fetcher, opts.cwd);
            return normalizePackument(name, raw);
          } catch (err) {
            // 4xx non-rate-limit errors are not retried.
            if (err instanceof HttpError) {
              if (err.status === 429 || err.status >= 500) {
                // Sleep before pRetry's own attempt counter triggers.
                await sleep(chooseDelayMs(attempt, err.retryAfterSec));
                throw err; // signal pRetry to try again
              }
              throw new AbortError(`Registry ${err.status}: ${err.message}`);
            }
            throw err;
          }
        },
        { retries: retryAttempts - 1, minTimeout: 0, factor: 1 }
      );
    }
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function normalizePackument(name: string, raw: NpmPackument): RegistryPackument {
  const distTags = raw['dist-tags'] ?? {};
  const versionsMap = raw.versions ?? {};
  const time = raw.time ?? {};
  const latestTag = distTags.latest;

  const versions: RegistryVersion[] = Object.entries(versionsMap).map(([v, meta]) => ({
    version: v,
    publishedAt: time[v] ?? null,
    isPrerelease: /[-+]/.test(v) && /^[0-9]+\.[0-9]+\.[0-9]+[-+]/.test(v),
    deprecated: typeof meta.deprecated === 'string' ? meta.deprecated : null,
    peerDependencies: extractStringMap(meta.peerDependencies),
    engines: extractStringMap(meta.engines)
  }));

  // Deprecation is reported per-version. Surface latest-version's value (most
  // useful for view [A]). View [B] reads per-version separately.
  let deprecation: string | null = null;
  let latestPeerDependencies: Record<string, string> = {};
  let latestEngines: Record<string, string> = {};
  if (latestTag !== undefined) {
    const latestMeta = versionsMap[latestTag];
    if (latestMeta !== undefined) {
      if (typeof latestMeta.deprecated === 'string') deprecation = latestMeta.deprecated;
      latestPeerDependencies = extractStringMap(latestMeta.peerDependencies);
      latestEngines = extractStringMap(latestMeta.engines);
    }
  }

  let lastPublishAt: string | null = null;
  for (const [v, isoStr] of Object.entries(time)) {
    if (v === 'modified' || v === 'created') continue;
    if (typeof isoStr === 'string') {
      if (lastPublishAt === null || isoStr > lastPublishAt) lastPublishAt = isoStr;
    }
  }

  return {
    name: raw.name ?? name,
    versions,
    distTags,
    deprecation,
    homepage: typeof raw.homepage === 'string' ? raw.homepage : null,
    repository: extractRepository(raw.repository),
    license: extractLicense(raw.license),
    lastPublishAt,
    latestPeerDependencies,
    latestEngines
  };
}

function extractRepository(value: NpmPackument['repository']): string | null {
  if (typeof value === 'string') return value;
  if (value !== undefined && value !== null && typeof value === 'object' && typeof value.url === 'string') {
    return value.url;
  }
  return null;
}

function extractLicense(value: NpmPackumentVersion['license']): string | null {
  if (typeof value === 'string') return value;
  if (value !== undefined && value !== null && typeof value === 'object' && typeof value.type === 'string') {
    return value.type;
  }
  return null;
}

function extractStringMap(value: Record<string, string> | undefined): Record<string, string> {
  if (value === undefined || value === null || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof k === 'string' && typeof v === 'string') out[k] = v;
  }
  return out;
}
