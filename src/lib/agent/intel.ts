/**
 * App-side `IntelContext` for agent runs (V2_STAGE4_SPEC 4a.4 / 4a.5): npm
 * registry packuments + tarballs through `npm-registry-fetch` (target `.npmrc`
 * honoured via `cwd`, same as `scanners/registry.ts`), each request with a
 * hard timeout (CLAUDE.md: every outbound fetch has one), plus the
 * `library/_apidiff/` cache dir. One instance per run: the packument memo
 * lives in the closure, not at module scope.
 */
import type { IntelContext, PackumentLike } from '@/core/agent/types';
import { apiDiffDir } from '../paths';

export const PACKUMENT_TIMEOUT_MS = 20_000;
export const TARBALL_TIMEOUT_MS = 30_000;
export const TARBALL_MAX_BYTES = 50 * 1024 * 1024;

interface FetchResponse {
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
type NpmFetch = (url: string, opts: { cwd?: string; timeout?: number; signal?: AbortSignal }) => Promise<FetchResponse>;

/** Same interop dance as `scanners/registry.ts`: the package is CJS with a callable export. */
async function loadNpmFetch(): Promise<NpmFetch> {
  const mod: unknown = await import('npm-registry-fetch');
  if (typeof mod === 'function') return mod as NpmFetch;
  const d = (mod as { default?: unknown } | null)?.default;
  if (typeof d === 'function') return d as NpmFetch;
  throw new Error('npm-registry-fetch did not export a callable function');
}

export interface AppIntelOptions {
  /** Target project dir (for `.npmrc` lookup only; nothing is read by our code). */
  cwd: string;
  cacheDir?: string;
  /** Test seam. */
  fetcher?: NpmFetch;
}

declare global {
  // eslint-disable-next-line no-var
  var __DEP_AGENT_AGENT_INTEL_OVERRIDE__: IntelContext | undefined;
}

/** Tests pin the run intel (no network) and MUST reset it with `setAgentIntelOverride(null)`. */
export function setAgentIntelOverride(intel: IntelContext | null): void {
  globalThis.__DEP_AGENT_AGENT_INTEL_OVERRIDE__ = intel ?? undefined;
}

/** The intel an app agent run uses: the test override, else the registry-backed one. */
export function runIntel(cwd: string): IntelContext {
  return globalThis.__DEP_AGENT_AGENT_INTEL_OVERRIDE__ ?? createAppIntel({ cwd });
}

export function createAppIntel(opts: AppIntelOptions): IntelContext {
  let fetcherPromise: Promise<NpmFetch> | null = null;
  const fetcher = () => (opts.fetcher !== undefined ? Promise.resolve(opts.fetcher) : (fetcherPromise ??= loadNpmFetch()));
  const packuments = new Map<string, Promise<PackumentLike>>();
  return {
    apiDiffCacheDir: opts.cacheDir ?? apiDiffDir(),
    fetchPackument: (name, signal) => {
      let p = packuments.get(name);
      if (p === undefined) {
        p = (async () => {
          const res = await (await fetcher())(`/${name}`, { cwd: opts.cwd, timeout: PACKUMENT_TIMEOUT_MS, signal });
          if (res.status >= 400) throw new Error(`registry ${res.status} ${res.statusText} for ${name}`);
          return (await res.json()) as PackumentLike;
        })();
        packuments.set(name, p);
        p.catch(() => packuments.delete(name));
      }
      return p;
    },
    fetchTarball: async (url, signal) => {
      const res = await (await fetcher())(url, { cwd: opts.cwd, timeout: TARBALL_TIMEOUT_MS, signal });
      if (res.status >= 400) throw new Error(`registry ${res.status} ${res.statusText} for a tarball`);
      const len = Number(res.headers.get('content-length') ?? '0');
      if (len > TARBALL_MAX_BYTES) throw new Error(`tarball larger than ${TARBALL_MAX_BYTES} bytes`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > TARBALL_MAX_BYTES) throw new Error(`tarball larger than ${TARBALL_MAX_BYTES} bytes`);
      return buf;
    }
  };
}
