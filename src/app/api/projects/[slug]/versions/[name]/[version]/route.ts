/**
 * GET /api/projects/:slug/versions/:name/:version — cache-first read for view [B].
 *
 * Returns 404 NOT_CACHED if the cache slot has not yet been populated.
 */
import { NextResponse } from 'next/server';
import { findBySlug } from '@/lib/storage/projects';
import { versionFilePath } from '@/lib/paths';
import { envelopeOr404 } from '@/lib/http/envelopeResponse';
import { badRequest, notFound } from '@/lib/http/errors';
import { withRequestLog } from '@/lib/http/guards';
import { isValidParam } from '@/lib/http/validate';
import { decodeAndValidatePackageName } from '@/lib/http/packageName';
import type { VersionDetail } from '@/lib/api-types';

export const GET = withRequestLog<{ params: { slug: string; name: string; version: string } }>(async (
  _req,
  ctx
): Promise<NextResponse> => {
  const slug = ctx.params.slug;
  if (!isValidParam(slug)) return badRequest('INVALID_SLUG', 'Slug failed allowlist validation.');
  const name = decodeAndValidatePackageName(ctx.params.name);
  if (name === null) return badRequest('INVALID_PACKAGE_NAME', 'Package name failed allowlist validation.');
  const version = ctx.params.version;
  if (!isValidParam(version)) return badRequest('INVALID_VERSION', 'Version failed allowlist validation.');

  const entry = await findBySlug(slug);
  if (entry === null) return notFound('PROJECT_NOT_FOUND', `No project with slug ${slug}.`);

  return envelopeOr404<VersionDetail>(versionFilePath(slug, name, version));
});
