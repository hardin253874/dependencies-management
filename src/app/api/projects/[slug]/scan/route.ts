/**
 * POST /api/projects/:slug/scan — kick off the Phase 2 background scan.
 *
 * Phase 2 = registry packument fetch + OSV CVE lookup for every direct dep,
 * batched and written via the canonical writer (spec §10.1).
 *
 * Returns `{ jobId, alreadyRunning }`. Use SSE at `/api/jobs/:jobId/events`
 * for progress.
 */
import { NextResponse } from 'next/server';
import { withCsrf } from '@/lib/http/guards';
import { badRequest, notFound, internalError } from '@/lib/http/errors';
import { isValidParam } from '@/lib/http/validate';
import { findBySlug } from '@/lib/storage/projects';
import { projectJsonPath } from '@/lib/paths';
import { readJson } from '@/lib/storage/atomic';
import { getJobQueue } from '@/lib/jobs/queue';
import { runPhase2Scan } from '@/lib/scanners/phase2';
import type { ProjectJson } from '@/lib/projects/add';
import type { ScanEnqueueResponse } from '@/lib/api-types';

export const POST = withCsrf<{ params: { slug: string } }>(async (_req, ctx) => {
  const slug = ctx.params.slug;
  if (!isValidParam(slug)) return badRequest('INVALID_SLUG', 'Slug failed allowlist validation.');

  const entry = await findBySlug(slug);
  if (entry === null) return notFound('PROJECT_NOT_FOUND', `No project with slug ${slug}.`);

  let project: ProjectJson;
  try {
    project = await readJson<ProjectJson>(projectJsonPath(slug));
  } catch (err) {
    return internalError('PROJECT_READ_FAILED', (err as Error).message);
  }

  const queue = getJobQueue();
  const result = await queue.enqueue({
    slug,
    kind: 'scan:phase-2',
    resourceKey: `scan:phase-2:${slug}`,
    run: async (report, signal) => {
      await runPhase2Scan({
        slug,
        projectJson: project,
        report,
        signal
      });
      return { resultUrl: `/api/projects/${slug}/dependencies` };
    }
  });

  return NextResponse.json<ScanEnqueueResponse>(
    { jobId: result.jobId, alreadyRunning: result.alreadyRunning },
    { status: result.alreadyRunning ? 200 : 202 }
  );
});
