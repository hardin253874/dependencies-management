/**
 * Deep scan pipeline — L2 transitive enumeration + packuments + CVE batch.
 *
 * Stage 4 (spec §7.6, §11.6). Inputs:
 *   - Pre-upgrade `LockfileSummary` (already computed by Phase 1 — direct
 *     lockfile parse). For Deep Analyze we don't actually re-resolve the
 *     post-upgrade lockfile (that requires running `npm install` against the
 *     target which we can't do — target is read-only). Instead we use the
 *     existing lockfile + the candidate target version's packument peer-deps
 *     to compute a best-effort delta. The LLM is told to treat the delta as
 *     a proxy, not a literal post-install graph.
 *
 * Outputs:
 *   - `lockfileSummary` per spec §11.6 input contract
 *   - `transitiveDelta` (added/removed/upgraded) — derived from registry data
 *   - `cveDelta` (new/resolved) — derived from OSV.dev batched lookup
 *
 * Caching:
 *   - Per-project L2 cache keyed by `lockfileStateHash`. Subsequent Deep
 *     Analyze runs in the same project with the same lockfile reuse it.
 */
import semver from 'semver';
import pLimit from 'p-limit';
import { promises as fs } from 'fs';
import { createRegistryFetcher, withRegistryLimit, type RegistryPackument } from './registry';
import { queryCves, keyFor, type CveQueryPair } from './cve';
import { atomicWriteJson, pathExists, readJson } from '../storage/atomic';
import { deepCacheDir, deepCacheFilePath } from '../paths';
import type {
  CveDelta,
  CveDeltaEntry,
  LockfileSummary,
  PeerDepOnTarget,
  TransitiveDelta,
  TransitivePackageRef,
  UpgradedPackage
} from '../api-types';
import type { ResolvedPackage } from './lockfile';
import type { JobProgress } from '../jobs/types';

// ---------------------------------------------------------------------------
// L2 cache shape — the persisted blob we reuse across Deep Analyze runs.
// ---------------------------------------------------------------------------

/**
 * Sufficient state to compute lockfileSummary / transitiveDelta / cveDelta for
 * any target dep + version, without re-fetching registry data. Scoped to the
 * project's current lockfile state.
 */
export interface L2Cache {
  /** Matches `project.lockfileStateHash`; used as cache key. */
  lockfileStateHash: string;
  /** Pre-upgrade transitives, sorted by name@version. */
  transitives: ResolvedPackage[];
  /** Per-package peer dependencies (from packument metadata of installed version). */
  peerDepsByPackage: Record<string, Record<string, string>>;
  /** CVEs known on each pre-upgrade installed (name, version) pair. */
  cveMap: Record<string, Array<{ id: string; severity: string; summary: string }>>;
  /** ISO timestamp the L2 cache was built. */
  generatedAt: string;
}

export interface DeepScanInput {
  slug: string;
  /** Target project directory (passed to registry fetcher's cwd). */
  projectPath: string;
  /** Resolved package set from the project's lockfile (Phase 1 output). */
  resolvedPackages: ResolvedPackage[];
  /** Identity hash of the resolved set — cache key. */
  lockfileStateHash: string;
  /** The dep being upgraded. */
  targetName: string;
  /** Pre-upgrade installed version. */
  fromVersion: string;
  /** Candidate post-upgrade version. */
  toVersion: string;
  /** Inject for tests. */
  registryFetcher?: ReturnType<typeof createRegistryFetcher>;
  osvFetch?: typeof fetch;
  report?: (p: JobProgress) => void;
  signal?: AbortSignal;
  /** When true, bypass the on-disk L2 cache (used by tests + fixture refresh). */
  forceRefresh?: boolean;
}

export interface DeepScanOutput {
  lockfileSummary: LockfileSummary;
  transitiveDelta: TransitiveDelta;
  cveDelta: CveDelta;
  /** True when L2 data came from disk cache rather than fresh fetch. */
  l2CacheHit: boolean;
}

const PACKUMENT_CONCURRENCY = 10;

/**
 * Run a deep scan. The result is the per-spec deterministic L2 payload — no
 * AI involvement. The route handler combines it with the AI narrative via
 * `runDeepUpdateReport`.
 */
export async function runDeepScan(input: DeepScanInput): Promise<DeepScanOutput> {
  // -------------------------------------------------------------------------
  // 1. L2 cache lookup. Hit when forceRefresh is false AND the cached hash
  //    matches the current lockfile state hash.
  // -------------------------------------------------------------------------
  let cache: L2Cache | null = null;
  if (!input.forceRefresh) {
    cache = await tryReadL2Cache(input.slug, input.lockfileStateHash);
  }

  if (cache === null) {
    cache = await buildL2Cache(input);
    await writeL2Cache(input.slug, cache);
  }

  // -------------------------------------------------------------------------
  // 2. Build LockfileSummary — peer deps on target + best-effort attribution.
  // -------------------------------------------------------------------------
  const peerDepsOnTarget: PeerDepOnTarget[] = [];
  for (const pkg of cache.transitives) {
    const peer = cache.peerDepsByPackage[pkg.name]?.[input.targetName];
    if (peer === undefined) continue;
    let satisfied = false;
    try {
      const validRange = semver.validRange(peer, { loose: true, includePrerelease: true });
      if (validRange !== null) {
        satisfied = semver.satisfies(input.toVersion, validRange, { includePrerelease: true });
      }
    } catch {
      satisfied = false;
    }
    peerDepsOnTarget.push({
      package: pkg.name,
      version: pkg.version,
      peerRange: peer,
      satisfiedByCandidate: satisfied
    });
  }

  // packagesByDirectDep — count of transitives whose name starts with each
  // direct dep prefix is a poor proxy; instead we approximate by counting how
  // many transitives declare each direct dep as a peer or list it in their
  // peerDependencies graph. v1 sticks with a simpler count: every transitive
  // that has the target in its peer-deps contributes 1.  Future: walk the
  // node_modules `dependencies` map for true attribution.
  const packagesByDirectDep: Record<string, number> = {};
  packagesByDirectDep[input.targetName] = peerDepsOnTarget.length;

  const lockfileSummary: LockfileSummary = {
    totalPackages: cache.transitives.length,
    packagesByDirectDep,
    peerDepsOnTarget
  };

  // -------------------------------------------------------------------------
  // 3. Build TransitiveDelta — best-effort.
  //    "added": peer deps on target newly required by toVersion (relative to
  //    fromVersion's peers, if known via packument). We don't have the
  //    candidate post-install graph — see file header — so this is a proxy.
  //    "removed": packages where peer on target was unsatisfiable BEFORE but
  //    is satisfied by toVersion (those entries effectively don't need to be
  //    re-locked) — counted as 0 for v1 honesty.
  //    "upgraded": packages whose peer range required the target be upgraded
  //    (i.e. peer satisfaction flips from false → true at toVersion).
  // -------------------------------------------------------------------------
  const transitiveDelta: TransitiveDelta = buildTransitiveDelta(cache, input);

  // -------------------------------------------------------------------------
  // 4. CVE delta — newCves are CVEs introduced by the candidate toVersion
  //    on the target dep itself; resolvedCves are CVEs that existed on the
  //    pre-upgrade installed version that the toVersion no longer carries.
  // -------------------------------------------------------------------------
  const cveDelta = await buildCveDelta(input);

  return {
    lockfileSummary,
    transitiveDelta,
    cveDelta,
    l2CacheHit: !input.forceRefresh && cache.generatedAt < new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// L2 cache I/O
// ---------------------------------------------------------------------------

async function tryReadL2Cache(slug: string, lockfileStateHash: string): Promise<L2Cache | null> {
  const fp = deepCacheFilePath(slug, lockfileStateHash);
  if (!(await pathExists(fp))) return null;
  try {
    const cached = await readJson<L2Cache>(fp);
    if (cached.lockfileStateHash === lockfileStateHash) {
      return cached;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeL2Cache(slug: string, cache: L2Cache): Promise<void> {
  await fs.mkdir(deepCacheDir(slug), { recursive: true });
  await atomicWriteJson(deepCacheFilePath(slug, cache.lockfileStateHash), cache);
}

/**
 * Build a fresh L2 cache from registry + OSV.dev.
 */
async function buildL2Cache(input: DeepScanInput): Promise<L2Cache> {
  const registry =
    input.registryFetcher ?? createRegistryFetcher({ cwd: input.projectPath });

  // Dedupe (name, version) — multiple references to the same install will share
  // a packument fetch.
  const uniqueByKey = new Map<string, { name: string; version: string }>();
  for (const p of input.resolvedPackages) {
    uniqueByKey.set(`${p.name}@${p.version}`, p);
  }

  const peerDepsByPackage: Record<string, Record<string, string>> = {};
  const packumentLimit = pLimit(PACKUMENT_CONCURRENCY);
  let done = 0;
  const total = uniqueByKey.size;

  await Promise.all(
    Array.from(uniqueByKey.values()).map((entry) =>
      packumentLimit(async () => {
        if (input.signal?.aborted === true) return;
        input.report?.({ current: done, total, label: entry.name, phase: 'registry' });
        try {
          // Fetch the full packument; pull peerDependencies for the installed version.
          const packument = await withRegistryLimit(() => registry.fetchPackument(entry.name));
          const peers = extractPeerDepsForVersion(packument, entry.version);
          if (Object.keys(peers).length > 0) {
            peerDepsByPackage[entry.name] = peers;
          }
        } catch {
          // Skip — same failure-mode shape as Phase 2 (packument unavailable).
        } finally {
          done += 1;
          input.report?.({ current: done, total, label: entry.name, phase: 'registry' });
        }
      })
    )
  );

  // CVE batch — query every (name, version) pair so we can build resolvedCves later.
  input.report?.({
    current: 0,
    total: uniqueByKey.size,
    label: 'OSV.dev batch',
    phase: 'cve'
  });
  const pairs: CveQueryPair[] = Array.from(uniqueByKey.values()).map((p) => ({
    name: p.name,
    version: p.version
  }));
  const cveLookup = await queryCves(pairs, { fetcher: input.osvFetch });
  const cveMap: L2Cache['cveMap'] = {};
  for (const [k, cves] of cveLookup.entries()) {
    if (cves === null) continue; // failure mode → no entry, treated as unknown
    cveMap[k] = cves.map((c) => ({ id: c.id, severity: c.severity, summary: c.summary }));
  }

  return {
    lockfileStateHash: input.lockfileStateHash,
    transitives: Array.from(uniqueByKey.values()).map((p) => ({ name: p.name, version: p.version })),
    peerDepsByPackage,
    cveMap,
    generatedAt: new Date().toISOString()
  };
}

// ---------------------------------------------------------------------------
// Packument helpers
// ---------------------------------------------------------------------------

/**
 * Extract `peerDependencies` for a specific version from a packument.
 * `RegistryVersion.peerDependencies` is always defined (empty object when
 * absent) so the lookup is unambiguous.
 */
function extractPeerDepsForVersion(
  packument: RegistryPackument,
  version: string
): Record<string, string> {
  const match = packument.versions.find((v) => v.version === version);
  return match?.peerDependencies ?? {};
}

// ---------------------------------------------------------------------------
// Delta builders
// ---------------------------------------------------------------------------

function buildTransitiveDelta(cache: L2Cache, input: DeepScanInput): TransitiveDelta {
  const added: TransitivePackageRef[] = [];
  const removed: TransitivePackageRef[] = [];
  const upgraded: UpgradedPackage[] = [];

  // For each transitive that peers on the target dep, check whether the peer
  // range required AN upgrade (peer-range satisfied by toVersion but NOT by
  // fromVersion → "upgraded"). This is the best heuristic we can compute
  // without running `npm install --dry-run` against the post-upgrade graph
  // (which we can't — target is read-only).
  for (const pkg of cache.transitives) {
    const peer = cache.peerDepsByPackage[pkg.name]?.[input.targetName];
    if (peer === undefined) continue;
    try {
      const validRange = semver.validRange(peer, { loose: true, includePrerelease: true });
      if (validRange === null) continue;
      const satisfiedByTo = semver.satisfies(input.toVersion, validRange, { includePrerelease: true });
      const satisfiedByFrom = semver.satisfies(input.fromVersion, validRange, { includePrerelease: true });
      if (satisfiedByTo && !satisfiedByFrom) {
        // Conceptually: the peer required an upgrade; lockfile entries that
        // depended on this peer's resolution would be re-resolved. We record
        // it as "upgraded" with the peer constraint as the version mapping.
        upgraded.push({
          name: pkg.name,
          from: pkg.version,
          to: pkg.version // we don't know the post-resolve version; mark unchanged
        });
      } else if (!satisfiedByTo && satisfiedByFrom) {
        // Going backwards — unusual but possible (peer range narrower).
        // Treat as "removed" in the sense that the peer no longer fits.
        removed.push({ name: pkg.name, version: pkg.version });
      }
    } catch {
      // ignore — invalid peer ranges don't contribute to the delta
    }
  }
  return { packagesAdded: added, packagesRemoved: removed, packagesUpgraded: upgraded };
}

/**
 * Build the CVE delta by:
 *   - Fetching CVEs for (target, toVersion) → newCves IF not present on (target, fromVersion).
 *   - Reading cached CVEs on (target, fromVersion) → resolvedCves IF not present on toVersion.
 */
async function buildCveDelta(input: DeepScanInput): Promise<CveDelta> {
  const newCves: CveDeltaEntry[] = [];
  const resolvedCves: CveDeltaEntry[] = [];

  const pairs: CveQueryPair[] = [
    { name: input.targetName, version: input.fromVersion },
    { name: input.targetName, version: input.toVersion }
  ];
  const cveMap = await queryCves(pairs, { fetcher: input.osvFetch });
  const fromKey = keyFor(input.targetName, input.fromVersion);
  const toKey = keyFor(input.targetName, input.toVersion);
  const fromCves = cveMap.get(fromKey);
  const toCves = cveMap.get(toKey);

  if (fromCves !== null && fromCves !== undefined && toCves !== null && toCves !== undefined) {
    const fromIds = new Set(fromCves.map((c) => c.id));
    const toIds = new Set(toCves.map((c) => c.id));
    for (const c of toCves) {
      if (!fromIds.has(c.id)) {
        newCves.push({
          id: c.id,
          package: input.targetName,
          severity: c.severity,
          summary: c.summary
        });
      }
    }
    for (const c of fromCves) {
      if (!toIds.has(c.id)) {
        resolvedCves.push({
          id: c.id,
          package: input.targetName,
          severity: c.severity,
          summary: c.summary
        });
      }
    }
  }
  // If either lookup failed (null), we conservatively leave both arrays empty
  // — Deep Analyze's UI banner surfaces the OSV-unavailable state separately.

  return { newCves, resolvedCves };
}

// ---------------------------------------------------------------------------
// Direct-fetch helper for the peer-dep satisfaction algorithm (§11.6 unit test).
// Exposed for testing in isolation.
// ---------------------------------------------------------------------------

export { extractPeerDepsForVersion };
