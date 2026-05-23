/**
 * POST /api/projects/:slug/versions/:name/:version/refresh — view [B] regenerate.
 *
 * Fetches the registry packument, isolates the requested version, and queries
 * OSV for `(name, version)`. Persists `library/<slug>/versions/<name>/<v>.json`.
 */
import { NextResponse } from 'next/server';
import { withCsrf } from '@/lib/http/guards';
import { badRequest, notFound, internalError } from '@/lib/http/errors';
import { isValidParam } from '@/lib/http/validate';
import { decodeAndValidatePackageName } from '@/lib/http/packageName';
import { findBySlug } from '@/lib/storage/projects';
import { projectJsonPath, versionFilePath } from '@/lib/paths';
import { readJson } from '@/lib/storage/atomic';
import { writeEnvelope } from '@/lib/storage/envelope';
import { getJobQueue } from '@/lib/jobs/queue';
import { createRegistryFetcher, withRegistryLimit } from '@/lib/scanners/registry';
import { queryCves, keyFor } from '@/lib/scanners/cve';
import type { ProjectJson } from '@/lib/projects/add';
import type { VersionDetail, CveRecord, ScanEnqueueResponse } from '@/lib/api-types';

export const POST = withCsrf<{ params: { slug: string; name: string; version: string } }>(async (_req, ctx) => {
  const slug = ctx.params.slug;
  if (!isValidParam(slug)) return badRequest('INVALID_SLUG', 'Slug failed allowlist validation.');
  const name = decodeAndValidatePackageName(ctx.params.name);
  if (name === null) return badRequest('INVALID_PACKAGE_NAME', 'Package name failed allowlist validation.');
  const version = ctx.params.version;
  if (!isValidParam(version)) return badRequest('INVALID_VERSION', 'Version failed allowlist validation.');

  const entry = await findBySlug(slug);
  if (entry === null) return notFound('PROJECT_NOT_FOUND', `No project with slug ${slug}.`);

  let project: ProjectJson;
  try {
    project = await readJson<ProjectJson>(projectJsonPath(slug));
  } catch (err) {
    return internalError('PROJECT_READ_FAILED', (err as Error).message);
  }

  const queue = getJobQueue();
  const result = await queue.enqueue({
    slug,
    kind: 'refresh:version',
    resourceKey: `versions:${slug}:${name}:${version}`,
    run: async (report) => {
      report({ current: 0, total: 1, label: `${name}@${version}`, phase: 'registry' });
      const registry = createRegistryFetcher({ cwd: project.path });
      const pack = await withRegistryLimit(() => registry.fetchPackument(name));
      const versionMeta = pack.versions.find((v) => v.version === version);
      if (versionMeta === undefined) {
        throw new Error(`Version ${version} not found in registry for ${name}.`);
      }

      report({ current: 1, total: 1, label: `${name}@${version}`, phase: 'cve' });
      const cveMap = await queryCves([{ name, version }]);
      const lookup = cveMap.get(keyFor(name, version));
      const cves: CveRecord[] | null = lookup === undefined ? [] : lookup;

      const detail: VersionDetail = {
        version,
        publishedAt: versionMeta.publishedAt,
        cves,
        changelogUrl: null,
        notes: null
      };
      await writeEnvelope(versionFilePath(slug, name, version), {
        source: 'registry',
        ttlHours: 168, // 7 days per spec §8.5
        data: detail
      });
      return {
        resultUrl: `/api/projects/${slug}/versions/${encodeURIComponent(name)}/${encodeURIComponent(version)}`
      };
    }
  });

  return NextResponse.json<ScanEnqueueResponse>(
    { jobId: result.jobId, alreadyRunning: result.alreadyRunning },
    { status: result.alreadyRunning ? 200 : 202 }
  );
});
