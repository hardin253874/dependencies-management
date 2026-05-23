/**
 * GET /api/projects/:slug/deep-reports/:name/:from/:to/download?format=md|html
 *
 * Mirror of the [D] download endpoint for [D-Deep] reports. Resolves the
 * lockfile-state-hash short prefix from the project's current `project.json`,
 * locates the on-disk envelope, and renders MD or HTML.
 *
 * Returns 404 NOT_CACHED when the lockfile has changed since the report was
 * generated (the filename suffix won't match) or when no report exists at all.
 */
import { NextResponse } from 'next/server';
import { findBySlug } from '@/lib/storage/projects';
import { deepReportFilePath, projectJsonPath } from '@/lib/paths';
import { readEnvelope } from '@/lib/storage/envelope';
import { pathExists, readJson } from '@/lib/storage/atomic';
import { badRequest, notFound, internalError } from '@/lib/http/errors';
import { withRequestLog } from '@/lib/http/guards';
import { isValidParam, isValidVersionParam } from '@/lib/http/validate';
import { decodeAndValidatePackageName } from '@/lib/http/packageName';
import { renderDeepUpdateReportMd, renderDeepUpdateReportHtml } from '@/lib/reports/render';
import type { ProjectJson } from '@/lib/projects/add';
import type { DeepUpdateReportDetail } from '@/lib/api-types';

export const GET = withRequestLog<{ params: { slug: string; name: string; from: string; to: string } }>(async (
  req,
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

  const url = new URL(req.url);
  const format = (url.searchParams.get('format') ?? 'md').toLowerCase();
  if (format !== 'md' && format !== 'html') {
    return badRequest('INVALID_FORMAT', 'format must be one of: md, html');
  }

  let project: ProjectJson;
  try {
    project = await readJson<ProjectJson>(projectJsonPath(slug));
  } catch (err) {
    return internalError('PROJECT_READ_FAILED', (err as Error).message);
  }
  const hashShort = project.lockfileStateHash.slice(0, 5);
  const fp = deepReportFilePath(slug, name, from, to, hashShort);
  if (!(await pathExists(fp))) {
    return notFound('NOT_CACHED', 'Generate the report first');
  }
  try {
    const env = await readEnvelope<DeepUpdateReportDetail>(fp);
    const meta = {
      slug,
      name,
      generatedAt: env.generatedAt,
      source: env.source
    };
    if (format === 'md') {
      const body = renderDeepUpdateReportMd(meta, env.data);
      return new NextResponse(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="${name.replace(/\//g, '__')}-deep-${from}__${to}.md"`
        }
      });
    }
    const body = renderDeepUpdateReportHtml(meta, env.data);
    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name.replace(/\//g, '__')}-deep-${from}__${to}.html"`
      }
    });
  } catch (err) {
    return internalError('DOWNLOAD_FAILED', (err as Error).message);
  }
});
