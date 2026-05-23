/**
 * Phase 2 background scan (spec §10.1).
 *
 * For each direct dep in `project.json`:
 *   1. Fetch the registry packument (`npm-registry-fetch` honouring target
 *      `.npmrc` via `cwd`). Throttled to 10 parallel via `p-limit`.
 *   2. Compute outdated severity by comparing the installed version to the
 *      registry `latest` dist-tag (semver-aware: major / minor / patch).
 *   3. Determine deprecation from the registry packument.
 *   4. Batch-query OSV.dev for `(name, installedVersion)` pairs.
 *   5. Write per-dep `deps/<name>.json` envelopes.
 *   6. Patch badges on `project.json` via the canonical writer.
 *
 * All progress is streamed through the supplied reporter so the SSE bridge can
 * forward it to the UI status bar.
 */
import path from 'path';
import semver from 'semver';
import { writeEnvelope } from '../storage/envelope';
import { depFilePath } from '../paths';
import { getCanonicalWriter } from '../storage/canonicalWriter';
import { getLogger } from '../logger';
import { createRegistryFetcher, withRegistryLimit, type RegistryPackument } from './registry';
import { queryCves, keyFor, type CveQueryPair } from './cve';
import type {
  AvailableVersion,
  DepDetail,
  CveRecord,
  OutdatedSeverity
} from '../api-types';
import type { JobProgress } from '../jobs/types';
import type { ProjectJson } from '../projects/add';

export interface Phase2Options {
  slug: string;
  projectJson: ProjectJson;
  /** Inject a custom fetcher (tests). */
  registryFetcher?: ReturnType<typeof createRegistryFetcher>;
  /** Inject a custom fetch (tests OSV). */
  osvFetch?: typeof fetch;
  /** Report progress for SSE. */
  report?: (p: JobProgress) => void;
  /** Honour external cancel signal (e.g. job queue). */
  signal?: AbortSignal;
}

export interface Phase2Result {
  depsWithCves: number;
  depsDeprecated: number;
  depsOutdatedMajor: number;
  cveLookupFailed: boolean;
}

export async function runPhase2Scan(opts: Phase2Options): Promise<Phase2Result> {
  const { slug, projectJson } = opts;
  const log = (await getLogger()).child({ scope: 'phase2', slug });
  const startedAt = Date.now();
  const writer = await getCanonicalWriter(slug);
  const registry =
    opts.registryFetcher ??
    createRegistryFetcher({ cwd: projectJson.path });

  // Stage 1 — Registry packuments.
  const direct = projectJson.dependencies;
  const total = direct.length;
  log.info({ total }, `phase2 start — ${total} direct deps`);

  const packuments = new Map<string, RegistryPackument | null>();
  const pairs: CveQueryPair[] = [];

  let registryDone = 0;
  let registryFailed = 0;
  const failedNames: string[] = [];

  await Promise.all(
    direct.map((dep) =>
      withRegistryLimit(async () => {
        if (opts.signal?.aborted === true) return;
        opts.report?.({
          current: registryDone,
          total,
          label: dep.name,
          phase: 'registry'
        });
        try {
          const pack = await registry.fetchPackument(dep.name);
          packuments.set(dep.name, pack);

          // Compute outdated severity from latest dist-tag.
          const latest = pack.distTags.latest ?? null;
          const installed = dep.installedVersion;
          let outdated: OutdatedSeverity = null;
          if (latest !== null && installed !== null) {
            outdated = compareOutdatedSeverity(installed, latest);
          }

          // Determine deprecation. Latest version's deprecation overrides
          // older versions for the dep-level badge.
          const installedVersionDeprecated =
            installed !== null &&
            pack.versions.find((v) => v.version === installed)?.deprecated !== null &&
            pack.versions.find((v) => v.version === installed)?.deprecated !== undefined;
          const latestDeprecated = pack.deprecation !== null;

          writer.patchBadges(dep.name, {
            outdatedSeverity: outdated,
            deprecated: installedVersionDeprecated || latestDeprecated
            // hasCve patched after OSV pass
          });

          // Build the deps/<name>.json envelope.
          if (installed !== null) {
            pairs.push({ name: dep.name, version: installed });
          }
        } catch (err) {
          packuments.set(dep.name, null);
          registryFailed += 1;
          failedNames.push(dep.name);
          log.warn(
            { dep: dep.name, err: (err as Error).message },
            `phase2 registry fetch failed: ${dep.name}`
          );
          // Leave badges as-is so the UI can show "scan failed" via the
          // unchanged null badges.
        } finally {
          registryDone += 1;
          opts.report?.({
            current: registryDone,
            total,
            label: dep.name,
            phase: 'registry'
          });
        }
      })
    )
  );
  log.info(
    {
      total,
      ok: total - registryFailed,
      failed: registryFailed,
      durationMs: Date.now() - startedAt,
      failedSample: failedNames.slice(0, 10)
    },
    `phase2 registry done — ${total - registryFailed}/${total} ok`
  );

  if (opts.signal?.aborted === true) {
    log.info({ durationMs: Date.now() - startedAt }, 'phase2 aborted after registry stage');
    return { depsWithCves: 0, depsDeprecated: 0, depsOutdatedMajor: 0, cveLookupFailed: false };
  }

  // Stage 2 — OSV CVE lookup.
  log.info({ pairs: pairs.length }, `phase2 OSV start — ${pairs.length} pairs`);
  const cveStartedAt = Date.now();
  opts.report?.({ current: 0, total: pairs.length, label: 'OSV.dev batch', phase: 'cve' });
  const cveMap = await queryCves(pairs, { fetcher: opts.osvFetch, signal: opts.signal });
  log.info(
    { pairs: pairs.length, durationMs: Date.now() - cveStartedAt },
    `phase2 OSV done (${Date.now() - cveStartedAt}ms)`
  );
  let cveLookupFailed = false;

  // Stage 3 — Build deps envelopes + patch CVE badge.
  // Patch all badges synchronously first (in-memory only), then write envelopes
  // in parallel — independent files, no serialisation needed. The canonical
  // writer collapses 150 patches into one or two flushes (timer-debounced).
  const depsWithCves = { v: 0 };
  const depsDeprecated = { v: 0 };
  const depsOutdatedMajor = { v: 0 };
  const writeTasks: Promise<void>[] = [];

  for (let i = 0; i < direct.length; i += 1) {
    const dep = direct[i]!;
    opts.report?.({
      current: i + 1,
      total,
      label: dep.name,
      phase: 'cve'
    });
    const pack = packuments.get(dep.name) ?? null;
    if (pack === null) continue; // registry failed; skip envelope

    let cvesForInstalled: CveRecord[] | null;
    if (dep.installedVersion === null) {
      cvesForInstalled = [];
    } else {
      const lookup = cveMap.get(keyFor(dep.name, dep.installedVersion));
      // Map miss (undefined) → treat as empty. Explicit null = batch failed.
      if (lookup === undefined) cvesForInstalled = [];
      else cvesForInstalled = lookup;
    }
    if (cvesForInstalled === null) cveLookupFailed = true;

    const hasCveValue = cvesForInstalled === null ? null : cvesForInstalled.length > 0;
    if (hasCveValue === true) depsWithCves.v += 1;

    writer.patchBadges(dep.name, { hasCve: hasCveValue });

    // Track counters for the result.
    const cur = writer.read().dependencies.find((d) => d.name === dep.name);
    if (cur?.badges.deprecated === true) depsDeprecated.v += 1;
    if (cur?.badges.outdatedSeverity === 'major') depsOutdatedMajor.v += 1;

    const detail = buildDepDetail(dep.name, dep.installedVersion, dep.declaredRange, pack, cvesForInstalled);
    writeTasks.push(
      writeEnvelope(depFilePath(slug, dep.name), {
        source: 'registry',
        ttlHours: 24,
        data: detail
      }).then(() => undefined)
    );
  }
  // Parallel writes for the deps/<name>.json files (independent paths).
  log.info({ count: writeTasks.length }, `phase2 envelope writes start — ${writeTasks.length} files`);
  const writeStartedAt = Date.now();
  await Promise.all(writeTasks);
  log.info(
    { count: writeTasks.length, durationMs: Date.now() - writeStartedAt },
    `phase2 envelope writes done (${Date.now() - writeStartedAt}ms)`
  );

  // Update project.json lastFullScanAt + flush all pending badge writes.
  writer.patchTopLevel({ lastFullScanAt: new Date().toISOString() });
  log.info({}, 'phase2 flush start — draining canonical writer');
  const flushStartedAt = Date.now();
  await writer.flush();
  log.info(
    { durationMs: Date.now() - flushStartedAt },
    `phase2 flush done (${Date.now() - flushStartedAt}ms)`
  );
  log.info(
    {
      totalMs: Date.now() - startedAt,
      depsWithCves: depsWithCves.v,
      depsDeprecated: depsDeprecated.v,
      depsOutdatedMajor: depsOutdatedMajor.v,
      cveLookupFailed
    },
    `phase2 complete in ${Date.now() - startedAt}ms`
  );

  return {
    depsWithCves: depsWithCves.v,
    depsDeprecated: depsDeprecated.v,
    depsOutdatedMajor: depsOutdatedMajor.v,
    cveLookupFailed
  };
}

/**
 * Compare installed against latest; returns the worst severity bump applicable.
 * Returns null when installed >= latest or comparison fails.
 */
export function compareOutdatedSeverity(installed: string, latest: string): OutdatedSeverity {
  const cleanInstalled = semver.coerce(installed)?.version ?? installed;
  const cleanLatest = semver.coerce(latest)?.version ?? latest;
  if (!semver.valid(cleanInstalled) || !semver.valid(cleanLatest)) return null;
  if (semver.gte(cleanInstalled, cleanLatest)) return null;
  const diff = semver.diff(cleanInstalled, cleanLatest);
  if (diff === 'major' || diff === 'premajor') return 'major';
  if (diff === 'minor' || diff === 'preminor') return 'minor';
  if (diff === 'patch' || diff === 'prepatch' || diff === 'prerelease') return 'patch';
  return null;
}

/**
 * Apply the §8.7 availableVersions cap:
 *   - All versions of the current installed major
 *   - Last 50 major versions (any minor/patch from each)
 *   - All versions matching the declared range
 *
 * The union is taken and sorted semver-descending.
 *
 * Exported for testing.
 */
export function applyAvailableVersionsCap(
  packument: RegistryPackument,
  installedVersion: string | null,
  declaredRange: string
): { kept: AvailableVersion[]; total: number } {
  const all = packument.versions;
  const total = all.length;

  // Map versions by major.
  const installedMajor = installedVersion === null ? null : semver.coerce(installedVersion)?.major ?? null;
  const validRange = semver.validRange(declaredRange);

  const allMajors = new Set<number>();
  for (const v of all) {
    const m = semver.coerce(v.version)?.major;
    if (typeof m === 'number') allMajors.add(m);
  }
  const sortedMajors = Array.from(allMajors).sort((a, b) => b - a);
  const keepMajors = new Set(sortedMajors.slice(0, 50));

  const kept: AvailableVersion[] = [];
  for (const v of all) {
    const coerced = semver.coerce(v.version);
    if (coerced === null) continue;
    const major = coerced.major;
    let keep = false;
    if (installedMajor !== null && major === installedMajor) keep = true;
    if (keepMajors.has(major)) keep = true;
    if (validRange !== null && semver.satisfies(v.version, validRange, { includePrerelease: true })) keep = true;
    if (keep) {
      kept.push({
        version: v.version,
        publishedAt: v.publishedAt,
        isPrerelease: v.isPrerelease
      });
    }
  }

  // Sort semver-descending (highest first).
  kept.sort((a, b) => semver.rcompare(a.version, b.version));
  return { kept, total };
}

function buildDepDetail(
  name: string,
  installedVersion: string | null,
  declaredRange: string,
  packument: RegistryPackument,
  cves: CveRecord[] | null
): DepDetail {
  const { kept } = applyAvailableVersionsCap(packument, installedVersion, declaredRange);
  return {
    name,
    availableVersions: kept,
    support: {
      homepage: packument.homepage,
      repository: packument.repository,
      lastPublishAt: packument.lastPublishAt
    },
    license: packument.license,
    deprecation: packument.deprecation === null ? null : { message: packument.deprecation },
    currentVersionCves: cves,
    latestPeerDeps: packument.latestPeerDependencies,
    latestEngines: packument.latestEngines,
    // Phase 2 writes deps in parallel; computing relatedDeps here would race
    // on cross-dep cache reads. The view-[A] refresh of an individual dep
    // computes its `relatedDeps` lazily (when all other caches are in place).
    // Empty here is the correct initial state.
    relatedDeps: []
  };
}

// Suppress unused import noise (path is intentionally available for callers
// that subclass / extend this file in tests).
void path;
