/**
 * GET /api/projects/:slug/deep-reports/:name/:from/:to — cache-first read for [D-Deep].
 *
 * The on-disk filename embeds the lockfile-state-hash prefix (§8.2):
 *   `<from>__<to>__lf-<5chars>.json`
 *
 * The URL doesn't carry that prefix — the client only knows `from` + `to`.
 * We resolve it server-side by reading the current `project.json.lockfileStateHash`
 * and taking its 5-char prefix. This naturally invalidates the cache: when the
 * lockfile changes, the on-disk filename changes too, and the next GET returns
 * 404 NOT_CACHED → the FE prompts for regeneration.
 */
import { NextResponse } from 'next/server';
import { findBySlug } from '@/lib/storage/projects';
import { deepReportFilePath, projectJsonPath } from '@/lib/paths';
import { envelopeOr404 } from '@/lib/http/envelopeResponse';
import { badRequest, notFound, internalError } from '@/lib/http/errors';
import { withRequestLog } from '@/lib/http/guards';
import { isValidParam, isValidVersionParam } from '@/lib/http/validate';
import { decodeAndValidatePackageName } from '@/lib/http/packageName';
import { readJson } from '@/lib/storage/atomic';
import type { ProjectJson } from '@/lib/projects/add';
import type { DeepUpdateReportDetail } from '@/lib/api-types';

export const GET = withRequestLog<{ params: { slug: string; name: string; from: string; to: string } }>(async (
  _req,
  ctx
): Promise<NextResponse> => {
  const { slug, from, to } = ctx.params;
  if (!isValidParam(slug)) return badRequest('INVALID_SLUG', 'Slug failed allowlist validation.');
  if (!isValidVersionParam(from)) return badRequest('INVALID_VERSION', '`from` failed allowlist validation.');
  if (!isValidVersionParam(to)) return badRequest('INVALID_VERSION', '`to` failed allowlist validation.');

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
  const lockfileStateHashShort = project.lockfileStateHash.slice(0, 5);

  return envelopeOr404<DeepUpdateReportDetail>(
    deepReportFilePath(slug, name, from, to, lockfileStateHashShort)
  );
});
