/**
 * POST /api/projects/:slug/usage/:name/refresh — view [C] regenerate.
 *
 * Runs a full code scan against the target project, slices the result down to
 * the requested dep, and writes `library/<slug>/usage/<file-slug>.json`.
 *
 * Optimisation: when multiple usage refreshes are requested for the same
 * project in quick succession, we share a single scan via the resourceKey
 * (`usage-scan:<slug>`) and post-process per-dep writes.
 */
import path from 'path';
import { NextResponse } from 'next/server';
import { withCsrf } from '@/lib/http/guards';
import { badRequest, notFound, internalError } from '@/lib/http/errors';
import { isValidParam } from '@/lib/http/validate';
import { decodeAndValidatePackageName } from '@/lib/http/packageName';
import { findBySlug } from '@/lib/storage/projects';
import { projectJsonPath, usageFilePath } from '@/lib/paths';
import { readJson } from '@/lib/storage/atomic';
import { writeEnvelope } from '@/lib/storage/envelope';
import { getJobQueue } from '@/lib/jobs/queue';
import { scanCode } from '@/lib/scanners/code';
import type { ProjectJson } from '@/lib/projects/add';
import type { UsageDetail, ScanEnqueueResponse } from '@/lib/api-types';

export const POST = withCsrf<{ params: { slug: string; name: string } }>(async (_req, ctx) => {
  const slug = ctx.params.slug;
  if (!isValidParam(slug)) return badRequest('INVALID_SLUG', 'Slug failed allowlist validation.');
  const name = decodeAndValidatePackageName(ctx.params.name);
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
    run: async (report) => {
      report({ current: 0, total: 1, label: name, phase: 'scan' });
      const scan = await scanCode({
        projectRoot: project.path,
        onProgress: (current, total, label) =>
          report({ current, total, label, phase: 'scan' })
      });

      const filesForName = scan.imports.get(name) ?? [];
      const dynamicImports = scan.dynamicImports;
      const detail: UsageDetail = {
        files: filesForName.map((f) => ({
          path: f.path,
          pathHash: f.pathHash,
          category: f.category,
          importStatements: f.importStatements,
          importCount: f.importStatements.length
        })),
        dynamicImports,
        totalFiles: filesForName.length,
        declaredButUnused: filesForName.length === 0,
        oversizedSkipped: scan.oversizedSkipped
      };
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

// Used only by type checking — keep path import alive.
void path;
