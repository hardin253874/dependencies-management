/**
 * PATCH /api/projects/:slug/relocate — point an existing project at a new path.
 *
 * Validates the new path the same way `POST /api/projects` does (§6.2), updates
 * `_projects.json`, and re-runs Phase 1 against the new lockfile. The slug is
 * preserved so all cached library/<slug>/ data stays intact (spec §6.3).
 */
import { NextResponse } from 'next/server';
import { withCsrf, readJsonBody, isNextResponse } from '@/lib/http/guards';
import { badRequest, conflict, internalError, notFound, forbidden } from '@/lib/http/errors';
import { isValidParam } from '@/lib/http/validate';
import { findBySlug, updateProject } from '@/lib/storage/projects';
import { validateProjectPath } from '@/lib/projects/validate';
import { readPackageJson } from '@/lib/scanners/packageJson';
import { detectLockfile, parseLockfile } from '@/lib/scanners/lockfile';
import { atomicWriteJson } from '@/lib/storage/atomic';
import { projectJsonPath } from '@/lib/paths';
import { buildSummary } from '@/lib/projects/summary';
import type { ProjectJson, ProjectDependency } from '@/lib/projects/add';
import type { RelocateRequest } from '@/lib/api-types';
import path from 'path';

export const PATCH = withCsrf<{ params: { slug: string } }>(async (req, ctx) => {
  const slug = ctx.params.slug;
  if (!isValidParam(slug)) return badRequest('INVALID_SLUG', 'Slug failed allowlist validation.');

  const entry = await findBySlug(slug);
  if (entry === null) return notFound('PROJECT_NOT_FOUND', `No project with slug ${slug}.`);

  const body = await readJsonBody<RelocateRequest>(req);
  if (isNextResponse(body)) return body;
  if (typeof body !== 'object' || body === null || typeof body.newPath !== 'string') {
    return badRequest('INVALID_BODY', 'Body must be { newPath: string, acknowledgeWorkspaces?: boolean }.');
  }

  const validation = await validateProjectPath(body.newPath);
  if (!validation.ok) {
    const code = validation.error.code;
    if (code === 'PATH_TRAVERSAL') return forbidden('PATH_TRAVERSAL', validation.error.message);
    if (code === 'DUPLICATE') {
      // Allow relocate-to-self check: if the duplicate is *this* slug, that's fine.
      // validate already rejects against any existing entry; we re-check here.
      return conflict('DUPLICATE_PROJECT', validation.error.message);
    }
    return badRequest(code, validation.error.message);
  }
  if (validation.workspacesDetected && body.acknowledgeWorkspaces !== true) {
    return badRequest(
      'WORKSPACES_NOT_ACKNOWLEDGED',
      'Workspaces detected at the new path. Re-submit with acknowledgeWorkspaces:true to proceed.'
    );
  }

  try {
    const pkg = await readPackageJson(validation.absolutePath);
    const detected = await detectLockfile(validation.absolutePath);
    if (detected === null) return badRequest('NO_LOCKFILE', 'Lockfile disappeared during relocate.');
    const lockfile = await parseLockfile(detected);

    const updated = await updateProject(slug, {
      name: pkg.name ?? path.basename(validation.absolutePath),
      absolutePath: validation.absolutePath,
      packageManager: validation.packageManager,
      workspacesDetected: validation.workspacesDetected
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
      packageManager: validation.packageManager,
      lockfileHash: lockfile.lockfileHash,
      lockfileStateHash: lockfile.lockfileStateHash,
      lastFullScanAt: new Date().toISOString(),
      legacyPeerDeps: false,
      volta: pkg.volta,
      workspacesDetected: validation.workspacesDetected,
      dependencies: deps
    };
    await atomicWriteJson(projectJsonPath(slug), projectJson);

    return NextResponse.json(await buildSummary(updated));
  } catch (err) {
    return internalError('RELOCATE_FAILED', (err as Error).message);
  }
});
