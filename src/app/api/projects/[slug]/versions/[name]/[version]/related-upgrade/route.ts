/**
 * GET /api/projects/:slug/versions/:name/:version/related-upgrade
 *
 * Cache-first read for the view [B] "Related deps upgrade analysis" section.
 * Returns the persisted envelope from
 * `library/<slug>/related-upgrade/<name>/<from>__<to>.json`, or 404
 * NOT_CACHED so the FE can render the "Analyze related deps" CTA.
 *
 * `from` is read from the active project's installed version of `:name`,
 * just like view [D]'s `(from, to)` pair — but here the GET only needs to
 * return whatever was last persisted for that name+version target. The
 * filename's `from` segment matches whatever the POST refresh used.
 *
 * Strategy: since GET only knows `(name, version)` and not `from`, we list
 * the directory and return the most recent envelope whose filename ends in
 * `__<version>.json`. This avoids forcing the FE to know `from` for the
 * GET (it's only relevant for the cache key, not the user-facing payload).
 */
import { promises as fs } from 'fs';
import { NextResponse } from 'next/server';
import { findBySlug } from '@/lib/storage/projects';
import { relatedUpgradeDirForPackage, relatedUpgradeFilePath } from '@/lib/paths';
import { readEnvelope } from '@/lib/storage/envelope';
import { badRequest, notFound, internalError } from '@/lib/http/errors';
import { withRequestLog } from '@/lib/http/guards';
import { isValidParam, isValidVersionParam } from '@/lib/http/validate';
import { decodeAndValidatePackageName } from '@/lib/http/packageName';
import { pathExists } from '@/lib/storage/atomic';
import type { RelatedUpgradeDetail } from '@/lib/api-types';

export const GET = withRequestLog<{
  params: { slug: string; name: string; version: string };
}>(async (_req, ctx): Promise<NextResponse> => {
  const slug = ctx.params.slug;
  if (!isValidParam(slug)) return badRequest('INVALID_SLUG', 'Slug failed allowlist validation.');
  const name = decodeAndValidatePackageName(ctx.params.name);
  if (name === null) return badRequest('INVALID_PACKAGE_NAME', 'Package name failed allowlist validation.');
  if (!isValidVersionParam(ctx.params.version)) {
    return badRequest('INVALID_VERSION', 'Version failed allowlist validation.');
  }

  const entry = await findBySlug(slug);
  if (entry === null) return notFound('PROJECT_NOT_FOUND', `No project with slug ${slug}.`);

  // Find the most recent envelope file matching `*__<version>.json`. If none
  // exists, return NOT_CACHED so the FE shows the CTA. We can't reconstruct
  // `from` from the URL alone; this directory walk is cheap (one project's
  // versions dir is small) and avoids leaking `from` into the GET contract.
  const dir = relatedUpgradeDirForPackage(slug, name);
  if (!(await pathExists(dir))) {
    return notFound('NOT_CACHED', 'Related-deps upgrade analysis not yet generated for this version.');
  }

  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    return internalError('READ_DIR_FAILED', (err as Error).message);
  }
  const suffix = `__${ctx.params.version}.json`;
  const matching = entries.filter((e) => e.endsWith(suffix));
  if (matching.length === 0) {
    return notFound('NOT_CACHED', 'Related-deps upgrade analysis not yet generated for this version.');
  }

  // Multiple `from` values may exist if the user has analyzed this `to` from
  // different installed states (e.g. after a project upgrade). Pick the most
  // recently modified file so the UI shows the freshest analysis.
  let best: { fp: string; mtimeMs: number } | null = null;
  for (const filename of matching) {
    const fp = relatedUpgradeFilePath(
      slug,
      name,
      filename.slice(0, filename.length - suffix.length),
      ctx.params.version
    );
    try {
      const stat = await fs.stat(fp);
      if (best === null || stat.mtimeMs > best.mtimeMs) {
        best = { fp, mtimeMs: stat.mtimeMs };
      }
    } catch {
      // File disappeared between readdir and stat — skip.
    }
  }
  if (best === null) {
    return notFound('NOT_CACHED', 'Related-deps upgrade analysis not yet generated for this version.');
  }
  try {
    const env = await readEnvelope<RelatedUpgradeDetail>(best.fp);
    return NextResponse.json(env);
  } catch (err) {
    return internalError('ENVELOPE_READ_FAILED', (err as Error).message);
  }
});
