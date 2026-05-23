/**
 * POST /api/projects/:slug/usage/related/:name/refresh — batch usage refresh
 * for every related dep of `:name`.
 *
 * Why a batch endpoint instead of fanning out per-dep refreshes from the
 * client: each individual `POST /usage/:n/refresh` runs a full `scanCode` of
 * the target project (every parseable file walked, parsed, and import-graphed)
 * and writes ONE envelope. With 5–15 related deps that would re-parse the
 * entire project 5–15 times. This route runs `scanCode` once and writes a
 * usage envelope for every related dep in one pass.
 *
 * Inputs:
 *   - :slug = project slug
 *   - :name = the dep currently being viewed in [C]; its `relatedDeps` list
 *     is read from `deps/<name>.json` to determine the targets.
 *
 * Response: `RelatedUsageEnqueueResponse` — `jobId`, `alreadyRunning`, and
 * `names[]` (the list of related dep names the job will scan + cache, so the
 * client can `getUsageDetail` each in parallel after the job completes).
 */
import { NextResponse } from 'next/server';
import { withCsrf } from '@/lib/http/guards';
import { badRequest, notFound, internalError } from '@/lib/http/errors';
import { isValidParam } from '@/lib/http/validate';
import { decodeAndValidatePackageName } from '@/lib/http/packageName';
import { findBySlug } from '@/lib/storage/projects';
import { projectJsonPath, depFilePath, usageFilePath } from '@/lib/paths';
import { readJson } from '@/lib/storage/atomic';
import { readEnvelope, writeEnvelope } from '@/lib/storage/envelope';
import { getJobQueue } from '@/lib/jobs/queue';
import { scanCode } from '@/lib/scanners/code';
import { getLogger } from '@/lib/logger';
import type { ProjectJson } from '@/lib/projects/add';
import type { DepDetail, UsageDetail, RelatedUsageEnqueueResponse } from '@/lib/api-types';

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

  // Resolve the viewed dep's `relatedDeps` list. This requires the dep's
  // cache to exist — if it doesn't, the caller hasn't generated view [A] for
  // this dep yet and we have nothing to fan out to.
  let depDetail: DepDetail;
  try {
    const env = await readEnvelope<DepDetail>(depFilePath(slug, name));
    depDetail = env.data;
  } catch {
    return notFound(
      'DEP_NOT_CACHED',
      `Dep ${name} has no cached detail. Open view [A] to generate it first.`
    );
  }

  // Dedup by name. Empty list is allowed — the response just reports nothing
  // to scan; the client can short-circuit.
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const rel of depDetail.relatedDeps ?? []) {
    if (!seen.has(rel.name)) {
      seen.add(rel.name);
      targets.push(rel.name);
    }
  }

  const queue = getJobQueue();
  const result = await queue.enqueue({
    slug,
    kind: 'refresh:usage-related',
    // Per-viewed-dep key so concurrent clicks on different deps don't
    // collapse; clicks on the same dep dedupe (alreadyRunning=true).
    resourceKey: `usage-related:${slug}:${name}`,
    run: async (report, signal) => {
      const log = (await getLogger()).child({
        scope: 'usage-related',
        slug,
        viewedDep: name,
        targetCount: targets.length
      });
      log.info({ targets }, `usage-related scan start — ${targets.length} deps`);
      report({ current: 0, total: Math.max(targets.length, 1), label: 'scanning project', phase: 'scan' });

      const scan = await scanCode({
        projectRoot: project.path,
        onProgress: (current, total, label) =>
          report({ current, total, label, phase: 'scan' })
      });
      if (signal.aborted) {
        log.info({}, 'usage-related scan aborted before envelope writes');
        return;
      }

      // Write one usage envelope per related dep. Independent paths — safe
      // to parallelise.
      const writeTasks: Promise<void>[] = [];
      let writeIndex = 0;
      for (const targetName of targets) {
        writeIndex += 1;
        const filesForName = scan.imports.get(targetName) ?? [];
        const detail: UsageDetail = {
          files: filesForName.map((f) => ({
            path: f.path,
            pathHash: f.pathHash,
            category: f.category,
            importStatements: f.importStatements,
            importCount: f.importStatements.length
          })),
          dynamicImports: scan.dynamicImports,
          totalFiles: filesForName.length,
          declaredButUnused: filesForName.length === 0,
          oversizedSkipped: scan.oversizedSkipped
        };
        report({
          current: writeIndex,
          total: targets.length,
          label: targetName,
          phase: 'scan'
        });
        writeTasks.push(
          writeEnvelope(usageFilePath(slug, targetName), {
            source: 'deterministic',
            ttlHours: null,
            data: detail
          }).then(() => undefined)
        );
      }
      await Promise.all(writeTasks);
      log.info(
        { writes: writeTasks.length },
        `usage-related scan done — wrote ${writeTasks.length} envelope${writeTasks.length === 1 ? '' : 's'}`
      );
      return { resultUrl: `/api/projects/${slug}/deps/${encodeURIComponent(name)}` };
    }
  });

  return NextResponse.json<RelatedUsageEnqueueResponse>(
    { jobId: result.jobId, alreadyRunning: result.alreadyRunning, names: targets },
    { status: result.alreadyRunning ? 200 : 202 }
  );
});
