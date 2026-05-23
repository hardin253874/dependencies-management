/**
 * GET /api/projects/:slug/deps/:name — cache-first read for view [A].
 *
 * Returns the persisted envelope (meta + DepDetail data) or 404 NOT_CACHED so
 * the FE knows to render the "Generate analysis" CTA.
 */
import { NextResponse } from 'next/server';
import { findBySlug } from '@/lib/storage/projects';
import { depFilePath } from '@/lib/paths';
import { envelopeOr404 } from '@/lib/http/envelopeResponse';
import { badRequest, notFound } from '@/lib/http/errors';
import { withRequestLog } from '@/lib/http/guards';
import { isValidParam } from '@/lib/http/validate';
import { decodeAndValidatePackageName } from '@/lib/http/packageName';
import type { DepDetail } from '@/lib/api-types';

export const GET = withRequestLog<{ params: { slug: string; name: string } }>(async (_req, ctx): Promise<NextResponse> => {
  const slug = ctx.params.slug;
  if (!isValidParam(slug)) return badRequest('INVALID_SLUG', 'Slug failed allowlist validation.');
  const name = decodeAndValidatePackageName(ctx.params.name);
  if (name === null) return badRequest('INVALID_PACKAGE_NAME', 'Package name failed allowlist validation.');

  const entry = await findBySlug(slug);
  if (entry === null) return notFound('PROJECT_NOT_FOUND', `No project with slug ${slug}.`);

  return envelopeOr404<DepDetail>(depFilePath(slug, name));
});
