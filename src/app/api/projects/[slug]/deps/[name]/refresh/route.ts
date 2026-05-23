/**
 * POST /api/projects/:slug/deps/:name/refresh — view [A] regenerate.
 *
 * Runs a single-dep registry fetch + CVE lookup and writes
 * `library/<slug>/deps/<file-slug>.json`. Enqueued as a job for SSE progress
 * surfacing.
 */
import { NextResponse } from 'next/server';
import { withCsrf } from '@/lib/http/guards';
import { badRequest, notFound, internalError } from '@/lib/http/errors';
import { isValidParam } from '@/lib/http/validate';
import { decodeAndValidatePackageName } from '@/lib/http/packageName';
import { findBySlug } from '@/lib/storage/projects';
import { projectJsonPath, depFilePath } from '@/lib/paths';
import { readJson } from '@/lib/storage/atomic';
import { writeEnvelope } from '@/lib/storage/envelope';
import { getJobQueue } from '@/lib/jobs/queue';
import { createRegistryFetcher, withRegistryLimit } from '@/lib/scanners/registry';
import { queryCves, keyFor } from '@/lib/scanners/cve';
import { applyAvailableVersionsCap } from '@/lib/scanners/phase2';
import { findProjectDep } from '@/lib/projects/lookup';
import { computeRelatedDeps } from '@/lib/projects/relatedDeps';
import type { ProjectJson } from '@/lib/projects/add';
import type { DepDetail, CveRecord, ScanEnqueueResponse } from '@/lib/api-types';

export const POST = withCsrf<{ params: { slug: string; name: string } }>(async (_req, ctx) => {
  const slug = ctx.params.slug;
  if (!isValidParam(slug)) return badRequest('INVALID_SLUG', 'Slug failed allowlist validation.');
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

  // `findProjectDep` checks real deps AND synthesizes Volta toolchain pins
  // (node / npm / yarn) on demand — without this, clicking Volta entries
  // in the middle panel 404s here because Phase 1/2 doesn't populate them
  // into `project.dependencies`.
  const dep = findProjectDep(project, name);
  if (dep === null) {
    return notFound('DEP_NOT_FOUND', `${name} is not a direct dependency of ${slug}.`);
  }

  const queue = getJobQueue();
  const result = await queue.enqueue({
    slug,
    kind: 'refresh:dep',
    resourceKey: `deps:${slug}:${name}`,
    run: async (report) => {
      report({ current: 0, total: 1, label: name, phase: 'registry' });
      const registry = createRegistryFetcher({ cwd: project.path });
      const pack = await withRegistryLimit(() => registry.fetchPackument(name));

      report({ current: 1, total: 1, label: name, phase: 'cve' });
      let cves: CveRecord[] | null = [];
      if (dep.installedVersion !== null) {
        const map = await queryCves([{ name, version: dep.installedVersion }]);
        const lookup = map.get(keyFor(name, dep.installedVersion));
        cves = lookup === undefined ? [] : lookup;
      }

      const { kept } = applyAvailableVersionsCap(pack, dep.installedVersion, dep.declaredRange);

      // Build DepDetail FIRST (without relatedDeps), then compute relatedDeps
      // using it as the source of truth for X's own peerDeps/engines. This
      // avoids a second registry round-trip just to read what we already have.
      const detail: DepDetail = {
        name,
        availableVersions: kept,
        support: {
          homepage: pack.homepage,
          repository: pack.repository,
          lastPublishAt: pack.lastPublishAt
        },
        license: pack.license,
        deprecation: pack.deprecation === null ? null : { message: pack.deprecation },
        currentVersionCves: cves,
        latestPeerDeps: pack.latestPeerDependencies,
        latestEngines: pack.latestEngines,
        relatedDeps: []
      };
      // Compute "Related deps" by scanning other deps' cached envelopes + the
      // global endoflife.date cache for EOL signals. v0.4 shape — one row per
      // related dep with reasons[] and a health profile. See spec §7.6 [A] +
      // §10.5.1 + computeRelatedDeps for the contract.
      detail.relatedDeps = await computeRelatedDeps(slug, project, name, detail);
      await writeEnvelope(depFilePath(slug, name), {
        source: 'registry',
        ttlHours: 24,
        data: detail
      });
      return { resultUrl: `/api/projects/${slug}/deps/${encodeURIComponent(name)}` };
    }
  });

  return NextResponse.json<ScanEnqueueResponse>(
    { jobId: result.jobId, alreadyRunning: result.alreadyRunning },
    { status: result.alreadyRunning ? 200 : 202 }
  );
});
