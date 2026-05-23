/**
 * GET /api/projects/:slug/reports/:name/:from/:to — cache-first read for [D].
 *
 * Returns a `FileEnvelope<UpdateReportDetail>` (spec §8.3) or 404 NOT_CACHED so
 * the FE renders the "Generate analysis" CTA card.
 */
import { NextResponse } from 'next/server';
import { findBySlug } from '@/lib/storage/projects';
import { reportFilePath } from '@/lib/paths';
import { envelopeOr404 } from '@/lib/http/envelopeResponse';
import { badRequest, notFound } from '@/lib/http/errors';
import { withRequestLog } from '@/lib/http/guards';
import { isValidParam, isValidVersionParam } from '@/lib/http/validate';
import { decodeAndValidatePackageName } from '@/lib/http/packageName';
import type { UpdateReportDetail } from '@/lib/api-types';

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

  return envelopeOr404<UpdateReportDetail>(reportFilePath(slug, name, from, to));
});
