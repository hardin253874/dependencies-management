/**
 * Builds the router's metadata-only facts (V2_STAGE5_SPEC 5b.6) from what is
 * already on disk: the dep's cached CVE list, the cached `api_diff` (never
 * fetched here) and the graph base-set size. Pure helpers + cache reads; no
 * network, no LLM, no Jev.
 */
import semver from 'semver';
import { impactBaseSet } from '@/core/agent/impactBase';
import { apiDiffCacheFile, type ApiDiffResult } from '@/core/intel/apiDiff';
import type { GraphDriver } from '@/core/graph/store';
import type { RouterFacts, RouterJump, RouterView } from '@/core/llm/router';
import { readEnvelope } from '../storage/envelope';
import { pathExists } from '../storage/atomic';
import { apiDiffDir, depFilePath } from '../paths';
import type { DepDetail } from '../api-types';

export function jumpOf(from: string | null, to: string | null): RouterJump {
  if (from === null && to !== null) return 'add';
  if (from !== null && to === null) return 'remove';
  const a = semver.coerce(from ?? '');
  const b = semver.coerce(to ?? '');
  if (a === null || b === null) return 'major';
  if (semver.eq(a, b)) return 'none';
  const d = semver.diff(a, b);
  if (d === 'major' || d === 'premajor') return 'major';
  if (d === 'minor' || d === 'preminor') return 'minor';
  return 'patch';
}

export async function cachedCveCount(slug: string, name: string): Promise<number> {
  const fp = depFilePath(slug, name);
  if (!(await pathExists(fp))) return 0;
  try {
    return (await readEnvelope<DepDetail>(fp)).data.currentVersionCves?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Only when the diff is already cached; the router never fetches it (5b.6). */
export async function cachedApiDiffCounts(pkg: string, from: string, to: string, cacheDir: string = apiDiffDir()): Promise<RouterFacts['apiDiff']> {
  const fp = apiDiffCacheFile(cacheDir, pkg, from, to);
  if (!(await pathExists(fp))) return null;
  try {
    const d = (await readEnvelope<ApiDiffResult>(fp)).data;
    return d.status === 'ok' ? { removed: d.removed.length, signatureChanged: d.signatureChanged.length } : null;
  } catch {
    return null;
  }
}

export function graphFileCountOf(graph: GraphDriver | null, packages: readonly string[]): number {
  if (graph === null) return 0;
  try {
    return impactBaseSet(graph, packages).length;
  } catch {
    return 0;
  }
}

export async function buildRouterFacts(opts: {
  view: RouterView;
  slug: string;
  name: string;
  from: string;
  to: string;
  packages?: readonly string[];
  /** Precomputed by the caller (`graphFileCountOf`) so a shared graph handle is never held across an await. */
  graphFileCount: number;
  configuredModel: string;
}): Promise<RouterFacts> {
  const packages = opts.packages ?? [opts.name];
  return {
    view: opts.view,
    jump: jumpOf(opts.from, opts.to),
    packageCount: packages.length,
    graphFileCount: opts.graphFileCount,
    apiDiff: await cachedApiDiffCounts(opts.name, opts.from, opts.to),
    cveCount: await cachedCveCount(opts.slug, opts.name),
    configuredModel: opts.configuredModel
  };
}
