/**
 * POST /api/projects/:slug/usage/:name/refresh — view [C] regenerate.
 *
 * Refreshes the project's code graph (`library/<slug>/graph.db`; incremental
 * after the first build), reads the requested dep's usage from it through the
 * v1-shaped compatibility layer, and writes `library/<slug>/usage/<file-slug>.json`.
 * Concurrent refreshes for different deps share the graph build via the
 * `graph:<slug>` lock: the second one waits and then finds nothing to re-parse.
 */
import { NextResponse } from 'next/server';
import { withCsrf, type RouteCtx } from '@/lib/http/guards';
import { badRequest, notFound, internalError } from '@/lib/http/errors';
import { isValidParam } from '@/lib/http/validate';
import { decodeAndValidatePackageName } from '@/lib/http/packageName';
import { findBySlug } from '@/lib/storage/projects';
import { projectJsonPath, usageFilePath } from '@/lib/paths';
import { readJson } from '@/lib/storage/atomic';
import { writeEnvelope } from '@/lib/storage/envelope';
import { getJobQueue } from '@/lib/jobs/queue';
import { refreshProjectGraph } from '@/lib/graph/graphService';
import { getGraphReader } from '@/lib/graph/readerCache';
import { usageFromGraph } from '@/lib/graph/usageFromGraph';
import type { ProjectJson } from '@/lib/projects/add';
import type { ScanEnqueueResponse } from '@/lib/api-types';

export const POST = withCsrf<RouteCtx<{ slug: string; name: string }>>(async (_req, ctx) => {
  const params = await ctx.params;
  const slug = params.slug;
  if (!isValidParam(slug)) return badRequest('INVALID_SLUG', 'Slug failed allowlist validation.');
  const name = decodeAndValidatePackageName(params.name);
  if (name === null) return badRequest('INVALID_PACKAGE_NAME', 'Package name failed allowlist validation.');

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
    kind: 'refresh:usage',
    // Note: the resourceKey is per-dep — Stage 4 may optimise to a shared key
    // (`usage-scan:<slug>`) when multiple deps need rescanning. For now we
    // keep per-dep keys so the SSE progress stream stays per-view.
    resourceKey: `usage:${slug}:${name}`,
    run: async (report, signal) => {
      report({ current: 0, total: 1, label: name, phase: 'scan' });
      await refreshProjectGraph({ slug, projectRoot: project.path, report, signal });
      if (signal.aborted) return;
      const detail = usageFromGraph(getGraphReader(slug), name);
      await writeEnvelope(usageFilePath(slug, name), {
        source: 'deterministic',
        ttlHours: null, // manual trigger only in v1 (§8.5)
        data: detail
      });
      return { resultUrl: `/api/projects/${slug}/usage/${encodeURIComponent(name)}` };
    }
  });

  return NextResponse.json<ScanEnqueueResponse>(
    { jobId: result.jobId, alreadyRunning: result.alreadyRunning },
    { status: result.alreadyRunning ? 200 : 202 }
  );
});
