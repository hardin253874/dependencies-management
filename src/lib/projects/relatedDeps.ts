/**
 * Compute the "Related deps in this project" section of view [A] — v0.4 shape.
 *
 * For a viewed dep X, scans the project's other deps and surfaces every one
 * (Y) that has a real relationship to X, with per-row health signals.
 *
 * Reasons (a single Y can carry multiple):
 *   - `inbound-peer-dep`:  Y declares `peerDependencies[X]`
 *   - `outbound-peer-dep`: X declares `peerDependencies[Y]`
 *   - `inbound-engine`:    Y declares `engines[X]`  (X is `node`/`npm`/`yarn`)
 *   - `outbound-engine`:   X declares `engines[Y]`  (Y is `node`/`npm`/`yarn`)
 *   - `naming`:            Y === `@types/<X>`
 *
 * Annotations:
 *   - reasons[i].range:      semver range carried by the relation
 *   - reasons[i].satisfied:  semver.satisfies(Y.installedVersion, range)
 *   - health.deprecated:     from Y's cached DepDetail
 *   - health.cveCount + maxCveSeverity: from Y's cached DepDetail
 *   - health.eol:            from endoflife.date (only for tracked products)
 *   - health.ageDays:        days since Y's last npm publish
 *
 * Data sources (per spec §10.5.1 + §10.4 + §10.5):
 *   - sibling `library/<slug>/deps/<name>.json` envelopes (peerDeps, engines,
 *     deprecation, currentVersionCves, lastPublishAt)
 *   - X's own DepDetail (passed in as `currentDetail` to avoid a re-read of
 *     the file the caller is about to write)
 *   - endoflife.date client (cached at `library/_endoflife/`)
 *
 * Reads cached files only — no npm/OSV network calls. Deps whose cache is
 * missing degrade gracefully: relationship from THEIR side is silently
 * skipped, but X's outbound declarations still surface them as rows with
 * `health.deprecated/cveCount/ageDays === null`.
 *
 * Cost: one disk read per project dep + ≤ N endoflife fetches (only for
 * tracked products, all cached). For a 100-dep project that's ~100 small
 * JSON reads, well under a second once endoflife caches are warm.
 */
import { promises as fs } from 'fs';
import semver from 'semver';
import { depFilePath } from '../paths';
import { computeEolInfo, endoflifeSlugFor } from '../scanners/endoflife';
import type {
  CveSeverity,
  DepDetail,
  FileEnvelope,
  RelatedDep,
  RelatedDepHealth,
  RelatedDepReason,
  RelatedReasonKind
} from '../api-types';
import type { ProjectJson, ProjectDependency } from './add';

const TOOLCHAIN_NAMES = new Set(['node', 'npm', 'yarn']);

/**
 * Severity ranking for `maxCveSeverity` reduction. Higher number = worse.
 * (`moderate` is OSV's alias for `medium`; we treat them as equal.)
 */
const SEVERITY_RANK: Record<CveSeverity, number> = {
  unknown: 0,
  low: 1,
  moderate: 2,
  medium: 2,
  high: 3,
  critical: 4
};

const REASON_RANK: Record<RelatedReasonKind, number> = {
  naming: 0,
  'inbound-peer-dep': 1,
  'outbound-peer-dep': 2,
  'inbound-engine': 3,
  'outbound-engine': 4
};

export async function computeRelatedDeps(
  slug: string,
  project: ProjectJson,
  currentName: string,
  currentDetail: DepDetail
): Promise<RelatedDep[]> {
  // Bucket relations by dep name. Multiple reasons can land on the same Y.
  const bucket = new Map<string, RelatedDepReason[]>();
  const installedVersionByName = new Map<string, string | null>();

  const recordRelation = (
    name: string,
    installedVersion: string | null,
    reason: RelatedDepReason
  ): void => {
    installedVersionByName.set(name, installedVersion);
    const existing = bucket.get(name);
    if (existing === undefined) {
      bucket.set(name, [reason]);
    } else {
      existing.push(reason);
    }
  };

  // ---- Outbound: relations declared BY X ABOUT other deps ---------------
  //
  // X's `latestPeerDeps[Y]` → Y is in the project (or referenced) → outbound
  // peer-dep relation. We surface Y whether or not it's currently in the
  // project's `dependencies` array; if Y isn't installed, the row still
  // appears (range carried, satisfied=null).
  for (const [otherName, range] of Object.entries(currentDetail.latestPeerDeps ?? {})) {
    if (otherName === currentName) continue;
    const otherInstalled = findInstalledVersion(project, otherName);
    recordRelation(otherName, otherInstalled, {
      kind: 'outbound-peer-dep',
      range,
      satisfied: computeSatisfied(otherInstalled, range)
    });
  }

  // X's `latestEngines[Y]` → outbound engine. Only meaningful when Y is a
  // toolchain name (node/npm/yarn); other engines.* keys are rare and not
  // relevant for cross-project-dep relations.
  for (const [otherName, range] of Object.entries(currentDetail.latestEngines ?? {})) {
    if (!TOOLCHAIN_NAMES.has(otherName)) continue;
    if (otherName === currentName) continue;
    const otherInstalled = findInstalledVersion(project, otherName);
    recordRelation(otherName, otherInstalled, {
      kind: 'outbound-engine',
      range,
      satisfied: computeSatisfied(otherInstalled, range)
    });
  }

  // ---- Inbound: relations from OTHER deps' caches that REFERENCE X ------
  const xIsToolchain = TOOLCHAIN_NAMES.has(currentName);
  const typesName = `@types/${currentName}`;

  // Cache other deps' cached DepDetail keyed by name (used for both the
  // inbound scan and the health-profile build).
  const cachedDetails = new Map<string, DepDetail>();

  for (const dep of project.dependencies) {
    if (dep.name === currentName) continue;

    // Naming relation: cheap, doesn't require Y's cache.
    if (dep.name === typesName) {
      recordRelation(dep.name, dep.installedVersion, {
        kind: 'naming',
        range: null,
        satisfied: null
      });
    }

    // Inbound peer-dep + inbound engine require Y's cached DepDetail.
    const detail = await readDepDetail(slug, dep.name);
    if (detail === null) continue;
    cachedDetails.set(dep.name, detail);

    const peerRange = detail.latestPeerDeps?.[currentName];
    if (typeof peerRange === 'string') {
      recordRelation(dep.name, dep.installedVersion, {
        kind: 'inbound-peer-dep',
        range: peerRange,
        satisfied: computeSatisfied(dep.installedVersion, peerRange)
      });
    }

    if (xIsToolchain) {
      const engineRange = detail.latestEngines?.[currentName];
      if (typeof engineRange === 'string') {
        recordRelation(dep.name, dep.installedVersion, {
          kind: 'inbound-engine',
          range: engineRange,
          satisfied: computeSatisfied(dep.installedVersion, engineRange)
        });
      }
    }
  }

  // ---- Build the final rows with health profile -------------------------
  const rows: RelatedDep[] = [];
  for (const [name, reasons] of bucket) {
    // Reasons are already deduped by kind within the bucket; sort for stable
    // output (e.g. naming first, then peer-dep, then engine).
    reasons.sort((a, b) => REASON_RANK[a.kind] - REASON_RANK[b.kind]);

    const installedVersion = installedVersionByName.get(name) ?? null;
    const detail = cachedDetails.get(name) ?? (await readDepDetail(slug, name));
    const health = await buildHealth(name, installedVersion, detail);

    rows.push({ name, installedVersion, reasons, health });
  }

  // Stable order across rows: by best-reason rank (naming first), then by
  // CVE severity descending so the most pressing items rise, then name.
  rows.sort((a, b) => {
    const ra = REASON_RANK[a.reasons[0]!.kind];
    const rb = REASON_RANK[b.reasons[0]!.kind];
    if (ra !== rb) return ra - rb;
    const sa = a.health.maxCveSeverity ? SEVERITY_RANK[a.health.maxCveSeverity] : -1;
    const sb = b.health.maxCveSeverity ? SEVERITY_RANK[b.health.maxCveSeverity] : -1;
    if (sa !== sb) return sb - sa; // higher severity first
    return a.name.localeCompare(b.name);
  });
  return rows;
}

function findInstalledVersion(project: ProjectJson, name: string): string | null {
  const dep = project.dependencies.find((d) => d.name === name);
  if (dep !== undefined) return dep.installedVersion;
  // Fall back to Volta entries for toolchain names so engines.node etc. get
  // a real version annotation when applicable.
  if (project.volta !== null && TOOLCHAIN_NAMES.has(name)) {
    const v = (project.volta as Record<string, string | null>)[name];
    if (typeof v === 'string' && v !== '') return v;
  }
  return null;
}

function computeSatisfied(version: string | null, range: string): boolean | null {
  if (version === null) return null;
  try {
    // `semver.satisfies` is strict; we coerce to handle ranges like '18.16.0'
    // satisfying '>=18'. Loose mode is on for resilience against odd ranges.
    return semver.satisfies(version, range, { loose: true });
  } catch {
    return null;
  }
}

async function buildHealth(
  name: string,
  installedVersion: string | null,
  detail: DepDetail | null
): Promise<RelatedDepHealth> {
  const eol = endoflifeSlugFor(name) === null
    ? null
    : await computeEolInfo(name, installedVersion);

  if (detail === null) {
    return {
      deprecated: null,
      cveCount: null,
      maxCveSeverity: null,
      eol,
      ageDays: null
    };
  }

  // Deprecation: detail.deprecation is { message: string } | null.
  const deprecated = detail.deprecation !== null;
  const cves = detail.currentVersionCves;
  const cveCount = cves === null ? null : cves.length;
  const maxCveSeverity = cves === null ? null : maxSeverityOf(cves);
  const ageDays = computeAgeDays(detail.support.lastPublishAt);

  return { deprecated, cveCount, maxCveSeverity, eol, ageDays };
}

function maxSeverityOf(cves: DepDetail['currentVersionCves']): CveSeverity | null {
  if (cves === null || cves.length === 0) return null;
  let best: CveSeverity = 'unknown';
  for (const cve of cves) {
    if (SEVERITY_RANK[cve.severity] > SEVERITY_RANK[best]) best = cve.severity;
  }
  return best;
}

function computeAgeDays(lastPublishIso: string | null): number | null {
  if (lastPublishIso === null) return null;
  const ms = Date.parse(lastPublishIso);
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
}

async function readDepDetail(slug: string, name: string): Promise<DepDetail | null> {
  try {
    const raw = await fs.readFile(depFilePath(slug, name), 'utf8');
    const env = JSON.parse(raw) as FileEnvelope<DepDetail>;
    return env.data;
  } catch {
    return null;
  }
}

/** Unused legacy reference required by external callers — keeping import stable. */
export type { ProjectDependency };
