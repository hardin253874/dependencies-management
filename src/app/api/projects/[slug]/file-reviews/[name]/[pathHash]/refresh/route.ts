/**
 * POST /api/projects/:slug/file-reviews/:name/:pathHash/refresh — view [E] regenerate.
 *
 * Steps (spec §11 + §11.4):
 *  1. Validate slug / name / pathHash.
 *  2. Resolve the file path via the usage cache (must round-trip from §10.6 scan).
 *  3. Load the dep's [A] cache (for dep metadata) — best-effort.
 *  4. Run `runFileReview` (mocked when MOCK_LLM=true). No graceful fallback per §11.9.
 *  5. Persist envelope to `library/<slug>/file-reviews/<name>/<pathHash>.json`.
 *
 * Returns `JobEnqueueResponse` (202 new / 200 dedupe).
 */
import path from 'path';
import { NextResponse } from 'next/server';
import { withCsrf } from '@/lib/http/guards';
import { badRequest, notFound, internalError } from '@/lib/http/errors';
import { isValidParam } from '@/lib/http/validate';
import { decodeAndValidatePackageName } from '@/lib/http/packageName';
import { findBySlug } from '@/lib/storage/projects';
import {
  projectJsonPath,
  fileReviewFilePath,
  usageFilePath,
  depFilePath
} from '@/lib/paths';
import { readJson, pathExists } from '@/lib/storage/atomic';
import { readEnvelope, writeEnvelope } from '@/lib/storage/envelope';
import { getJobQueue } from '@/lib/jobs/queue';
import { runFileReview } from '@/lib/llm/fileReviewService';
import { getLlmClient, withLlmLimit } from '@/lib/llm/factory';
import { readConfig } from '@/lib/storage/config';
import { findProjectDep } from '@/lib/projects/lookup';
import type {
  DepDetail,
  FileReviewDetail,
  JobEnqueueResponse,
  UsageDetail,
  UsageFile
} from '@/lib/api-types';
import type { ProjectJson } from '@/lib/projects/add';

export const POST = withCsrf<{
  params: { slug: string; name: string; pathHash: string };
}>(async (_req, ctx) => {
  const { slug, pathHash } = ctx.params;
  if (!isValidParam(slug)) return badRequest('INVALID_SLUG', 'Slug failed allowlist validation.');
  if (!isValidParam(pathHash)) return badRequest('INVALID_PATH_HASH', 'pathHash failed allowlist validation.');

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

  const dep = findProjectDep(project, name);
  if (dep === null) {
    return notFound('DEP_NOT_FOUND', `${name} is not a direct dependency of ${slug}.`);
  }

  // The usage cache is REQUIRED to resolve a pathHash to a real file. If the
  // user invoked view [E] without a prior usage scan, the FE should have
  // triggered [C] first. Surface a clear error code.
  if (!(await pathExists(usageFilePath(slug, name)))) {
    return notFound(
      'USAGE_NOT_CACHED',
      'Cannot resolve file. Generate the usage view first (POST /usage/<name>/refresh).'
    );
  }

  let usageEnv: Awaited<ReturnType<typeof readEnvelope<UsageDetail>>>;
  try {
    usageEnv = await readEnvelope<UsageDetail>(usageFilePath(slug, name));
  } catch (err) {
    return internalError('USAGE_READ_FAILED', (err as Error).message);
  }
  const usageFile: UsageFile | undefined = usageEnv.data.files.find((f) => f.pathHash === pathHash);
  if (usageFile === undefined) {
    return notFound('FILE_NOT_IN_USAGE', `No file with pathHash ${pathHash} for ${name} in usage cache.`);
  }

  // Safety: persisted relative path must not escape the project root.
  if (
    usageFile.path.startsWith('/') ||
    /^[a-zA-Z]:[\\/]/.test(usageFile.path) ||
    usageFile.path.split(/[/\\]/).some((seg) => seg === '..')
  ) {
    return badRequest('UNSAFE_FILE_PATH', 'Cached file path is invalid.');
  }
  const absolutePath = path.join(project.path, usageFile.path);

  // Best-effort dep metadata for the prompt (we don't fail the refresh on a
  // cache miss — view [E] is allowed to operate without [A]).
  let depDetail: DepDetail | null = null;
  if (await pathExists(depFilePath(slug, name))) {
    try {
      const depEnv = await readEnvelope<DepDetail>(depFilePath(slug, name));
      depDetail = depEnv.data;
    } catch {
      depDetail = null;
    }
  }

  const queue = getJobQueue();
  const result = await queue.enqueue({
    slug,
    kind: 'refresh:file-review',
    resourceKey: `file-review:${slug}:${name}:${pathHash}`,
    run: async (report, signal) => {
      report({ current: 0, total: 2, label: usageFile.path, phase: 'ai' });

      const config = await readConfig();
      const client = await getLlmClient();

      const run = await withLlmLimit(client.provider, () =>
        runFileReview(client, {
          relativePath: usageFile.path,
          absolutePath,
          depName: name,
          installedVersion: dep.installedVersion,
          latestVersion: extractLatestVersion(depDetail),
          deprecation: depDetail?.deprecation ?? null,
          currentCves: depDetail?.currentVersionCves ?? [],
          importStatements: usageFile.importStatements,
          knownSymbols: [name],
          model: config.llm.model,
          onPhase: (phaseEvent) => {
            report({
              current: 1,
              total: 2,
              label: phaseEvent.message,
              phase: 'ai',
              attempt: phaseEvent.attempt,
              maxAttempts: phaseEvent.maxAttempts
            });
          },
          signal
        })
      );

      await writeEnvelope<FileReviewDetail>(fileReviewFilePath(slug, name, pathHash), {
        source: run.source,
        ttlHours: null,
        data: run.detail
      });

      report({ current: 2, total: 2, label: 'Done', phase: 'ai' });
      return {
        resultUrl: `/api/projects/${slug}/file-reviews/${encodeURIComponent(name)}/${pathHash}`
      };
    }
  });

  return NextResponse.json<JobEnqueueResponse>(
    { jobId: result.jobId, alreadyRunning: result.alreadyRunning },
    { status: result.alreadyRunning ? 200 : 202 }
  );
});

function extractLatestVersion(detail: DepDetail | null): string | null {
  if (detail === null) return null;
  // Pick the last entry (availableVersions is sorted oldest → newest per §8.7).
  // Fall back to null if empty.
  const last = detail.availableVersions[detail.availableVersions.length - 1];
  return last === undefined ? null : last.version;
}
