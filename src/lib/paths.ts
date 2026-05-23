/**
 * Filesystem path helpers shared across the backend.
 *
 * The library directory is the agent's persistent store. In production this is
 * `<repo-root>/library/`. Tests inject a sandboxed path via setLibraryRoot()
 * so they never write to the developer's real library.
 */
import path from 'path';

let libraryRootOverride: string | null = null;

/**
 * Override the library root. Used by tests (§3.5 test isolation) and by setup
 * scripts that need to target a specific location. The override persists for
 * the lifetime of the process unless cleared.
 */
export function setLibraryRoot(absPath: string | null): void {
  if (absPath !== null && !path.isAbsolute(absPath)) {
    throw new Error(`Library root must be absolute: ${absPath}`);
  }
  libraryRootOverride = absPath;
}

export function getLibraryRoot(): string {
  if (libraryRootOverride !== null) return libraryRootOverride;
  return path.resolve(process.cwd(), 'library');
}

export function configFilePath(): string {
  return path.join(getLibraryRoot(), '_config.json');
}

export function projectsFilePath(): string {
  return path.join(getLibraryRoot(), '_projects.json');
}

export function projectDir(slug: string): string {
  return path.join(getLibraryRoot(), slug);
}

export function projectJsonPath(slug: string): string {
  return path.join(projectDir(slug), 'project.json');
}

export function projectJobsDir(slug: string): string {
  return path.join(projectDir(slug), '_jobs');
}

export function jobJournalPath(slug: string, jobId: string): string {
  return path.join(projectJobsDir(slug), `${jobId}.json`);
}

export function logsDir(): string {
  return path.join(getLibraryRoot(), '_logs');
}

export function serverLogPath(): string {
  return path.join(logsDir(), 'server.log');
}

// ----------------------------------------------------------------------------
// Per-view payload paths (spec §8.1 + §8.2 naming rules)
// ----------------------------------------------------------------------------

/**
 * Translate a package name into a safe filename segment.
 * Scoped packages: `@types/react` → `@types__react` (replace `/` with `__`).
 * Names without a slash pass through unchanged.
 */
export function pkgFileSlug(name: string): string {
  return name.replace(/\//g, '__');
}

export function depsDir(slug: string): string {
  return path.join(projectDir(slug), 'deps');
}

export function depFilePath(slug: string, name: string): string {
  return path.join(depsDir(slug), `${pkgFileSlug(name)}.json`);
}

export function versionsDir(slug: string): string {
  return path.join(projectDir(slug), 'versions');
}

export function versionsDirForPackage(slug: string, name: string): string {
  return path.join(versionsDir(slug), pkgFileSlug(name));
}

export function versionFilePath(slug: string, name: string, version: string): string {
  return path.join(versionsDirForPackage(slug, name), `${version}.json`);
}

export function usageDir(slug: string): string {
  return path.join(projectDir(slug), 'usage');
}

export function usageFilePath(slug: string, name: string): string {
  return path.join(usageDir(slug), `${pkgFileSlug(name)}.json`);
}

export function reportsDir(slug: string): string {
  return path.join(projectDir(slug), 'reports');
}

export function reportsDirForPackage(slug: string, name: string): string {
  return path.join(reportsDir(slug), pkgFileSlug(name));
}

/**
 * `library/<slug>/reports/<name>/<from>__<to>.json` (spec §8.1 + §8.2).
 */
export function reportFilePath(slug: string, name: string, from: string, to: string): string {
  return path.join(reportsDirForPackage(slug, name), `${from}__${to}.json`);
}

/**
 * Related-deps upgrade analysis cache (view [B] new section).
 *
 *   library/<slug>/related-upgrade/<name>/<from>__<to>.json
 *
 * One envelope per (viewed-dep, fromVersion, toVersion). Mirrors the
 * `reports/<name>/<from>__<to>.json` layout used by view [D] so users have
 * an intuitive parallel.
 */
export function relatedUpgradeDir(slug: string): string {
  return path.join(projectDir(slug), 'related-upgrade');
}

export function relatedUpgradeDirForPackage(slug: string, name: string): string {
  return path.join(relatedUpgradeDir(slug), pkgFileSlug(name));
}

export function relatedUpgradeFilePath(
  slug: string,
  name: string,
  from: string,
  to: string
): string {
  return path.join(relatedUpgradeDirForPackage(slug, name), `${from}__${to}.json`);
}

export function deepReportsDir(slug: string): string {
  return path.join(projectDir(slug), 'deep-reports');
}

export function deepReportsDirForPackage(slug: string, name: string): string {
  return path.join(deepReportsDir(slug), pkgFileSlug(name));
}

/**
 * `library/<slug>/deep-reports/<name>/<from>__<to>__lf-<5chars>.json` (§8.2).
 * `lockfileStateHashShort` is the first 5 chars of the project's
 * `lockfileStateHash`. Including it in the filename invalidates the cache
 * automatically when the lockfile resolves to a new set of packages.
 */
export function deepReportFilePath(
  slug: string,
  name: string,
  from: string,
  to: string,
  lockfileStateHashShort: string
): string {
  return path.join(
    deepReportsDirForPackage(slug, name),
    `${from}__${to}__lf-${lockfileStateHashShort}.json`
  );
}

/**
 * L2 deep-scan cache directory — per-project, indexed by lockfile-state hash.
 * Reuses transitive packument + CVE data across consecutive Deep Analyze runs
 * on the same project (spec §7.6 — "subsequent Deep Analyze clicks in the same
 * project reuse cached L2 data").
 */
export function deepCacheDir(slug: string): string {
  return path.join(projectDir(slug), 'deep-cache');
}

export function deepCacheFilePath(slug: string, lockfileStateHash: string): string {
  return path.join(deepCacheDir(slug), `${lockfileStateHash}.json`);
}

export function fileReviewsDir(slug: string): string {
  return path.join(projectDir(slug), 'file-reviews');
}

export function fileReviewsDirForPackage(slug: string, name: string): string {
  return path.join(fileReviewsDir(slug), pkgFileSlug(name));
}

/**
 * `library/<slug>/file-reviews/<name>/<pathHash>.json` (spec §8.1 + §8.2).
 * `pathHash` is the first 12 chars of sha1(relativeFilePath).
 */
export function fileReviewFilePath(slug: string, name: string, pathHash: string): string {
  return path.join(fileReviewsDirForPackage(slug, name), `${pathHash}.json`);
}

/** Returns the absolute path of the agent's own repository root (cwd). */
export function agentRepoRoot(): string {
  return path.resolve(process.cwd());
}
