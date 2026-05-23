/**
 * POST /api/projects/:slug/refresh — synchronous Phase-1 re-scan (spec §9.3).
 *
 * Re-reads package.json + lockfile from the registered absolute path, rebuilds
 * `library/<slug>/project.json` with empty Phase-2 badges (since this endpoint
 * does not invoke registry/CVE/AI lookups), and returns. Phase-1 typically
 * completes in <1s so no job is enqueued.
 */
import path from 'path';
import { NextResponse } from 'next/server';
import { withCsrf } from '@/lib/http/guards';
import { badRequest, internalError, notFound } from '@/lib/http/errors';
import { isValidParam } from '@/lib/http/validate';
import { findBySlug, updateProject } from '@/lib/storage/projects';
import { readPackageJson } from '@/lib/scanners/packageJson';
import { detectLockfile, parseLockfile } from '@/lib/scanners/lockfile';
import { atomicWriteJson } from '@/lib/storage/atomic';
import { projectJsonPath } from '@/lib/paths';
import type { ProjectJson, ProjectDependency } from '@/lib/projects/add';
import type { RefreshResponse } from '@/lib/api-types';
import { promises as fs } from 'fs';

export const POST = withCsrf<{ params: { slug: string } }>(async (_req, ctx) => {
  const slug = ctx.params.slug;
  if (!isValidParam(slug)) return badRequest('INVALID_SLUG', 'Slug failed allowlist validation.');

  const entry = await findBySlug(slug);
  if (entry === null) return notFound('PROJECT_NOT_FOUND', `No project with slug ${slug}.`);

  // Verify the target still exists and is a directory — but do NOT re-validate
  // workspaces / agent-root, etc. The user already accepted those at add time.
  // The point of this endpoint is a fast incremental re-read after the user
  // changes package.json or runs `npm install`.
  try {
    const stat = await fs.stat(entry.absolutePath);
    if (!stat.isDirectory()) {
      return badRequest('NOT_A_DIRECTORY', `Project path is no longer a directory: ${entry.absolutePath}`);
    }
  } catch {
    return notFound('PATH_NOT_FOUND', `Project path no longer exists: ${entry.absolutePath}`);
  }

  try {
    const pkg = await readPackageJson(entry.absolutePath);
    const detected = await detectLockfile(entry.absolutePath);
    if (detected === null) {
      return badRequest('NO_LOCKFILE', `Lockfile missing at ${entry.absolutePath}.`);
    }
    const lockfile = await parseLockfile(detected);

    // Keep the registry entry in sync with the freshest package-manager
    // detection + package.json name (the user may have switched lockfile or
    // renamed the package). Slug + absolutePath are preserved.
    const updated = await updateProject(slug, {
      name: pkg.name ?? path.basename(entry.absolutePath),
      packageManager: detected.packageManager,
      workspacesDetected: pkg.workspacesDetected
    });

    const deps: ProjectDependency[] = [];
    for (const [name, range] of Object.entries(pkg.dependencies)) {
      deps.push({
        name,
        section: 'dependencies',
        declaredRange: range,
        installedVersion: lockfile.installedVersions[name] ?? null,
        badges: { outdatedSeverity: null, hasCve: null, deprecated: null, lastScannedAt: null }
      });
    }
    for (const [name, range] of Object.entries(pkg.devDependencies)) {
      deps.push({
        name,
        section: 'devDependencies',
        declaredRange: range,
        installedVersion: lockfile.installedVersions[name] ?? null,
        badges: { outdatedSeverity: null, hasCve: null, deprecated: null, lastScannedAt: null }
      });
    }
    deps.sort((a, b) =>
      a.section === b.section ? a.name.localeCompare(b.name) : a.section.localeCompare(b.section)
    );

    const projectJson: ProjectJson = {
      schemaVersion: 1,
      name: updated.name,
      path: updated.absolutePath,
      packageManager: detected.packageManager,
      lockfileHash: lockfile.lockfileHash,
      lockfileStateHash: lockfile.lockfileStateHash,
      lastFullScanAt: new Date().toISOString(),
      legacyPeerDeps: false,
      volta: pkg.volta,
      workspacesDetected: pkg.workspacesDetected,
      dependencies: deps
    };
    await atomicWriteJson(projectJsonPath(slug), projectJson);

    return NextResponse.json<RefreshResponse>({ slug, jobId: null });
  } catch (err) {
    return internalError('REFRESH_FAILED', (err as Error).message);
  }
});
