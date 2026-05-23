/**
 * GET /api/projects/:slug/reports/:name/:from/:to/download?format=md|html
 *
 * Spec §9.3 downloads. Reads the cached report envelope; if absent, returns
 * 404 NOT_CACHED with the FE-friendly "Generate the report first" message
 * (never auto-generates).
 *
 * Two formats supported:
 *   - md   → `text/markdown; charset=utf-8`
 *   - html → `text/html; charset=utf-8`
 */
import { NextResponse } from 'next/server';
import { findBySlug } from '@/lib/storage/projects';
import {
  reportFilePath,
  relatedUpgradeFilePath,
  usageFilePath
} from '@/lib/paths';
import { readEnvelope } from '@/lib/storage/envelope';
import { pathExists } from '@/lib/storage/atomic';
import { badRequest, notFound, internalError } from '@/lib/http/errors';
import { withRequestLog } from '@/lib/http/guards';
import { isValidParam, isValidVersionParam } from '@/lib/http/validate';
import { decodeAndValidatePackageName } from '@/lib/http/packageName';
import {
  renderUpdateReportMd,
  renderUpdateReportHtml,
  type ExtendedReportContext
} from '@/lib/reports/render';
import type {
  RelatedUpgradeDetail,
  UpdateReportDetail,
  UsageDetail
} from '@/lib/api-types';

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

  const fp = reportFilePath(slug, name, from, to);
  if (!(await pathExists(fp))) {
    return notFound('NOT_CACHED', 'Generate the report first');
  }

  try {
    const env = await readEnvelope<UpdateReportDetail>(fp);
    const meta = {
      slug,
      name,
      generatedAt: env.generatedAt,
      source: env.source
    };

    // Best-effort: stitch in the related-deps upgrade analysis + each
    // related dep's usage cache so the downloaded report mirrors what the
    // user sees in view [D]. Each side is independently optional:
    //   - If the related-upgrade envelope is missing, we omit BOTH sections
    //     (we don't know which deps to list).
    //   - If individual usage caches are missing, the related-usage section
    //     still renders, with "No usage cache" stubs for the missing deps.
    // A failure here NEVER blocks the download — the core update report is
    // already loaded above.
    const extras = await loadExtendedReportContext(slug, name, from, to);

    if (format === 'md') {
      const body = renderUpdateReportMd(meta, env.data, extras);
      return new NextResponse(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="${name.replace(/\//g, '__')}-${from}__${to}.md"`
        }
      });
    }
    const body = renderUpdateReportHtml(meta, env.data, extras);
    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name.replace(/\//g, '__')}-${from}__${to}.html"`
      }
    });
  } catch (err) {
    return internalError('DOWNLOAD_FAILED', (err as Error).message);
  }
});

/**
 * Load the optional companion caches that enrich the downloaded report:
 *   - `library/<slug>/related-upgrade/<name>/<from>__<to>.json` (one file)
 *   - `library/<slug>/usage/<related-dep>.json` (one per related dep)
 *
 * All reads are best-effort. The function never throws — missing caches just
 * mean the corresponding sections are omitted or stubbed in the rendered
 * output. Reads are parallelised to keep the download fast.
 */
async function loadExtendedReportContext(
  slug: string,
  name: string,
  from: string,
  to: string
): Promise<ExtendedReportContext> {
  const fp = relatedUpgradeFilePath(slug, name, from, to);
  if (!(await pathExists(fp))) {
    return {};
  }
  let relatedUpgrade: RelatedUpgradeDetail;
  let relatedMeta: { generatedAt: string; source: string };
  try {
    const env = await readEnvelope<RelatedUpgradeDetail>(fp);
    relatedUpgrade = env.data;
    relatedMeta = { generatedAt: env.generatedAt, source: env.source };
  } catch {
    return {};
  }

  const usage: Record<string, UsageDetail> = {};
  await Promise.all(
    relatedUpgrade.recommendations.map(async (rec) => {
      const ufp = usageFilePath(slug, rec.name);
      if (!(await pathExists(ufp))) return;
      try {
        const env = await readEnvelope<UsageDetail>(ufp);
        usage[rec.name] = env.data;
      } catch {
        // Skip — render falls back to "no usage cache" stub for this name.
      }
    })
  );

  return {
    relatedUpgrade,
    relatedUpgradeMeta: relatedMeta,
    relatedUsage: usage
  };
}
