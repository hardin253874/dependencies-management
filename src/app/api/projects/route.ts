/**
 * GET /api/projects — list registered projects.
 * POST /api/projects — register a new target project + run Phase 1 scan.
 *
 * Spec §6.2 + §10.1 Phase 1.
 */
import { NextResponse } from 'next/server';
import { readProjects } from '@/lib/storage/projects';
import { buildSummary } from '@/lib/projects/summary';
import { addProjectPipeline } from '@/lib/projects/add';
import { withCsrf, withRequestLog, readJsonBody, isNextResponse } from '@/lib/http/guards';
import { badRequest, conflict, forbidden, internalError, notFound } from '@/lib/http/errors';
import type { AddProjectRequest, AddProjectResponse, ProjectsListResponse } from '@/lib/api-types';

export const GET = withRequestLog<unknown>(async () => {
  const reg = await readProjects();
  const projects = await Promise.all(reg.projects.map(buildSummary));
  return NextResponse.json<ProjectsListResponse>({ projects });
});

export const POST = withCsrf<unknown>(async (req) => {
  const body = await readJsonBody<AddProjectRequest>(req);
  if (isNextResponse(body)) return body;

  if (typeof body !== 'object' || body === null || typeof body.path !== 'string') {
    return badRequest('INVALID_BODY', 'Body must be { path: string, acknowledgeWorkspaces?: boolean }.');
  }

  const result = await addProjectPipeline({
    absolutePath: body.path,
    acknowledgeWorkspaces: body.acknowledgeWorkspaces === true
  });

  if (!result.ok) {
    switch (result.error.code) {
      case 'NOT_ABSOLUTE':
        return badRequest('PATH_NOT_ABSOLUTE', result.error.message);
      case 'PATH_TRAVERSAL':
        return forbidden('PATH_TRAVERSAL', result.error.message);
      case 'NOT_FOUND':
        return notFound('PATH_NOT_FOUND', result.error.message);
      case 'NOT_DIRECTORY':
        return badRequest('NOT_A_DIRECTORY', result.error.message);
      case 'NO_PACKAGE_JSON':
        return badRequest('NO_PACKAGE_JSON', result.error.message);
      case 'INVALID_PACKAGE_JSON':
        return badRequest('INVALID_PACKAGE_JSON', result.error.message);
      case 'NO_LOCKFILE':
        return badRequest('NO_LOCKFILE', result.error.message);
      case 'INSIDE_AGENT':
        return badRequest('INSIDE_AGENT', result.error.message);
      case 'DUPLICATE':
        return conflict('DUPLICATE_PROJECT', result.error.message);
      case 'WORKSPACES_NOT_ACKNOWLEDGED':
        return badRequest('WORKSPACES_NOT_ACKNOWLEDGED', result.error.message);
      default:
        return internalError('PROJECT_ADD_FAILED', result.error.message);
    }
  }

  return NextResponse.json<AddProjectResponse>(
    { slug: result.slug, jobId: null },
    { status: 202 }
  );
});
