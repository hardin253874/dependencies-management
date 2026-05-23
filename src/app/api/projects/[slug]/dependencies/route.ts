/**
 * GET /api/projects/:slug/dependencies — full project detail for the middle panel.
 * Reads `library/<slug>/project.json`.
 */
import { NextResponse } from 'next/server';
import { findBySlug } from '@/lib/storage/projects';
import { projectJsonPath } from '@/lib/paths';
import { readJson, pathExists } from '@/lib/storage/atomic';
import { badRequest, notFound, internalError } from '@/lib/http/errors';
import { withRequestLog } from '@/lib/http/guards';
import { isValidParam } from '@/lib/http/validate';
import type { ProjectDetail } from '@/lib/api-types';
import type { ProjectJson } from '@/lib/projects/add';

export const GET = withRequestLog<{ params: { slug: string } }>(async (_req, ctx): Promise<NextResponse> => {
  const slug = ctx.params.slug;
  if (!isValidParam(slug)) {
    return badRequest('INVALID_SLUG', 'Slug failed allowlist validation.');
  }
  const entry = await findBySlug(slug);
  if (entry === null) {
    return notFound('PROJECT_NOT_FOUND', `No project with slug ${slug}.`);
  }
  const fp = projectJsonPath(slug);
  if (!(await pathExists(fp))) {
    return notFound('NOT_CACHED', 'project.json has not been written yet.');
  }
  try {
    const pj = await readJson<ProjectJson>(fp);
    const payload: ProjectDetail = {
      schemaVersion: 1,
      name: pj.name,
      slug,
      path: pj.path,
      packageManager: pj.packageManager,
      lockfileHash: pj.lockfileHash,
      lockfileStateHash: pj.lockfileStateHash,
      lastFullScanAt: pj.lastFullScanAt,
      legacyPeerDeps: pj.legacyPeerDeps,
      volta: pj.volta,
      workspacesDetected: pj.workspacesDetected,
      dependencies: pj.dependencies
    };
    return NextResponse.json<ProjectDetail>(payload);
  } catch (err) {
    return internalError('PROJECT_READ_FAILED', (err as Error).message);
  }
});
