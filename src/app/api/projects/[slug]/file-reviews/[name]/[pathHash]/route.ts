/**
 * GET /api/projects/:slug/file-reviews/:name/:pathHash — cache-first read for [E].
 *
 * Returns a `FileEnvelope<FileReviewDetail>` (spec §8.3) or `404 NOT_CACHED`
 * so the FE renders the "Generate review" CTA card.
 *
 * Stale check (§7.6): if the on-disk envelope's `fileHashAtReview` differs
 * from the current file's hash (computed fresh here), we set `data.stale = true`
 * in the response so the FE renders the StaleCacheBanner. The persisted file
 * is NOT rewritten — staleness is a transient, derived signal.
 */
import path from 'path';
import { NextResponse } from 'next/server';
import { findBySlug } from '@/lib/storage/projects';
import { fileReviewFilePath, usageFilePath, projectJsonPath } from '@/lib/paths';
import { badRequest, notFound, internalError } from '@/lib/http/errors';
import { withRequestLog } from '@/lib/http/guards';
import { isValidParam } from '@/lib/http/validate';
import { decodeAndValidatePackageName } from '@/lib/http/packageName';
import { pathExists, readJson } from '@/lib/storage/atomic';
import { readEnvelope } from '@/lib/storage/envelope';
import { computeCurrentFileHash } from '@/lib/llm/fileReviewService';
import type { FileEnvelope, FileReviewDetail, UsageDetail } from '@/lib/api-types';
import type { ProjectJson } from '@/lib/projects/add';

export const GET = withRequestLog<{ params: { slug: string; name: string; pathHash: string } }>(async (
  _req,
  ctx
): Promise<NextResponse> => {
  const { slug, pathHash } = ctx.params;
  if (!isValidParam(slug)) return badRequest('INVALID_SLUG', 'Slug failed allowlist validation.');
  if (!isValidParam(pathHash)) return badRequest('INVALID_PATH_HASH', 'pathHash failed allowlist validation.');

  const name = decodeAndValidatePackageName(ctx.params.name);
  if (name === null) return badRequest('INVALID_PACKAGE_NAME', 'Package name failed allowlist validation.');

  const entry = await findBySlug(slug);
  if (entry === null) return notFound('PROJECT_NOT_FOUND', `No project with slug ${slug}.`);

  const fp = fileReviewFilePath(slug, name, pathHash);
  if (!(await pathExists(fp))) {
    return notFound('NOT_CACHED', 'No cached file review. POST refresh first.');
  }

  let env: Awaited<ReturnType<typeof readEnvelope<FileReviewDetail>>>;
  try {
    env = await readEnvelope<FileReviewDetail>(fp);
  } catch (err) {
    return internalError('ENVELOPE_READ_FAILED', (err as Error).message);
  }

  // Stale check: compute the current hash and compare.
  let stale = env.data.stale === true;
  try {
    const project = await readJson<ProjectJson>(projectJsonPath(slug));
    const abs = await resolveAbsolutePathForReview(project, slug, name, pathHash, env.data.filePath);
    if (abs !== null) {
      const currentHash = await computeCurrentFileHash(abs);
      if (currentHash === null) {
        // File disappeared — treat as stale; client can prompt to re-scan.
        stale = true;
      } else if (currentHash !== env.data.fileHashAtReview) {
        stale = true;
      }
    } else {
      // We couldn't resolve the file path on disk (e.g. usage cache absent and
      // file moved). Surface stale = true so the user is nudged to regenerate.
      stale = true;
    }
  } catch {
    // Don't fail the GET on stale-check errors; default to whatever's persisted.
  }

  const flat: FileEnvelope<FileReviewDetail> = {
    schemaVersion: env.schemaVersion as 1,
    generatedAt: env.generatedAt,
    source: env.source,
    ttlHours: env.ttlHours,
    data: { ...env.data, stale }
  };
  return NextResponse.json<FileEnvelope<FileReviewDetail>>(flat);
});

/**
 * Resolve the absolute path on disk for a file under review. We trust the
 * persisted `filePath` (it was originally derived from a server-side scan)
 * and join it under the target project root. If the persisted path is
 * suspicious (absolute or contains `..` after normalization), reject.
 */
async function resolveAbsolutePathForReview(
  project: ProjectJson,
  slug: string,
  name: string,
  pathHash: string,
  persistedRelPath: string
): Promise<string | null> {
  if (typeof persistedRelPath !== 'string' || persistedRelPath === '') return null;

  // Validate using `..` and absolute-path guards — both unacceptable for a
  // relative path stored in the cache.
  if (persistedRelPath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(persistedRelPath)) return null;
  const normalised = persistedRelPath.split(/[/\\]/);
  if (normalised.some((seg) => seg === '..')) return null;

  // Cross-check against the usage cache when present (defense in depth: the
  // pathHash must round-trip from the usage payload).
  if (await pathExists(usageFilePath(slug, name))) {
    try {
      const usage = await readEnvelope<UsageDetail>(usageFilePath(slug, name));
      const match = usage.data.files.find((f) => f.pathHash === pathHash);
      if (match !== undefined && match.path !== persistedRelPath) {
        // Trust the usage cache when it disagrees (it's the source of truth).
        return path.join(project.path, match.path);
      }
    } catch {
      // ignore; we already have the persisted path
    }
  }
  return path.join(project.path, persistedRelPath);
}
