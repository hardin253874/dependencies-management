/**
 * POST /api/projects/:slug/versions/:name/:version/related-upgrade/refresh
 *
 * View [B] "Analyze related deps" trigger. Mirrors the view [D]
 * `reports/.../refresh` shape closely so future maintenance is symmetric.
 *
 * Steps:
 *   1. Resolve `:name`'s installed version from `project.json` → that's `from`.
 *   2. Read `:name`'s cached DepDetail (must exist; produced by view [A]).
 *      Surfaces 404 NOT_CACHED otherwise — the FE prompts the user to open
 *      view [A] first.
 *   3. Load each related dep's own cached DepDetail (best-effort — null when
 *      missing). These provide latest-version + latest-engines context to
 *      the LLM prompt.
 *   4. Read `_config.json` for the active LLM model.
 *   5. Call `runRelatedUpgrade(client, ...)` which:
 *      - Runs deterministic verdict per related dep.
 *      - Calls the LLM with one batched prompt.
 *      - Falls back to `deterministic-partial` on LLM error.
 *   6. Persist envelope to
 *      `library/<slug>/related-upgrade/<name>/<from>__<to>.json`.
 */
import { NextResponse } from 'next/server';
import { withCsrf } from '@/lib/http/guards';
import { badRequest, notFound, internalError } from '@/lib/http/errors';
import { isValidParam, isValidVersionParam } from '@/lib/http/validate';
import { decodeAndValidatePackageName } from '@/lib/http/packageName';
import { findBySlug } from '@/lib/storage/projects';
import {
  projectJsonPath,
  depFilePath,
  relatedUpgradeFilePath
} from '@/lib/paths';
import { readJson } from '@/lib/storage/atomic';
import { readEnvelope, writeEnvelope } from '@/lib/storage/envelope';
import { getJobQueue } from '@/lib/jobs/queue';
import { runRelatedUpgrade } from '@/lib/llm/relatedUpgradeService';
import { getLlmClient, withLlmLimit } from '@/lib/llm/factory';
import { readConfig } from '@/lib/storage/config';
import { loadEnv } from '@/lib/config';
import { findProjectDep } from '@/lib/projects/lookup';
import { getLogger } from '@/lib/logger';
import type {
  DepDetail,
  RelatedUpgradeDetail,
  RelatedUpgradeEnqueueResponse
} from '@/lib/api-types';
import type { Envelope } from '@/lib/storage/envelope';
import type { ProjectJson } from '@/lib/projects/add';

export const POST = withCsrf<{
  params: { slug: string; name: string; version: string };
}>(async (_req, ctx) => {
  const slug = ctx.params.slug;
  if (!isValidParam(slug)) return badRequest('INVALID_SLUG', 'Slug failed allowlist validation.');
  const name = decodeAndValidatePackageName(ctx.params.name);
  if (name === null) return badRequest('INVALID_PACKAGE_NAME', 'Package name failed allowlist validation.');
  const toVersion = ctx.params.version;
  if (!isValidVersionParam(toVersion)) {
    return badRequest('INVALID_VERSION', 'Version failed allowlist validation.');
  }

  const entry = await findBySlug(slug);
  if (entry === null) return notFound('PROJECT_NOT_FOUND', `No project with slug ${slug}.`);

  let project: ProjectJson;
  try {
    project = await readJson<ProjectJson>(projectJsonPath(slug));
  } catch (err) {
    return internalError('PROJECT_READ_FAILED', (err as Error).message);
  }

  const dep = findProjectDep(project, name);
  if (dep === null) {
    return notFound(
      'DEP_NOT_FOUND',
      `${name} is not a direct dependency of ${slug} and not a Volta toolchain entry.`
    );
  }
  const fromVersion = dep.installedVersion;
  if (fromVersion === null) {
    return badRequest(
      'INSTALLED_VERSION_UNKNOWN',
      `${name} has no installed version in the lockfile; cannot compute an upgrade analysis.`
    );
  }

  // The viewed dep's DepDetail carries the `relatedDeps[]` list this analysis
  // depends on. If it's not cached, the user hasn't generated view [A] yet.
  let viewedEnv: Envelope<DepDetail>;
  try {
    viewedEnv = await readEnvelope<DepDetail>(depFilePath(slug, name));
  } catch {
    return notFound(
      'DEP_DETAIL_NOT_CACHED',
      `Open view [A] for ${name} first — its related-deps list is read from there.`
    );
  }
  const relatedDeps = viewedEnv.data.relatedDeps ?? [];

  const queue = getJobQueue();
  const result = await queue.enqueue({
    slug,
    kind: 'refresh:related-upgrade',
    // Dedupe by (slug, name, from, to). Distinct from view [D] reports.
    resourceKey: `related-upgrade:${slug}:${name}:${fromVersion}:${toVersion}`,
    run: async (report, signal) => {
      const log = (await getLogger()).child({
        scope: 'related-upgrade',
        slug,
        viewedDep: name,
        from: fromVersion,
        to: toVersion,
        relatedCount: relatedDeps.length
      });
      log.info({}, `related-upgrade start — ${relatedDeps.length} related deps`);
      report({
        current: 0,
        total: 2,
        label: `${name} ${fromVersion} → ${toVersion}`,
        phase: 'ai'
      });

      // Best-effort: load each related dep's own DepDetail payload (unwrapped
      // from its envelope) for the LLM context (latest version, latest
      // engines). Missing caches are OK — the prompt degrades gracefully
      // (`latestAvailableVersion=null`).
      const relatedDetails: Record<string, DepDetail | null> = {};
      await Promise.all(
        relatedDeps.map(async (rel) => {
          try {
            const env = await readEnvelope<DepDetail>(depFilePath(slug, rel.name));
            relatedDetails[rel.name] = env.data;
          } catch {
            relatedDetails[rel.name] = null;
          }
        })
      );

      report({ current: 1, total: 2, label: 'Calling LLM', phase: 'ai' });

      const config = await readConfig();
      const client = await getLlmClient();
      const env = loadEnv();
      const run = await withLlmLimit(client.provider, () =>
        runRelatedUpgrade(client, {
          model: config.llm.model,
          maxOutputTokens: env.budgets.updateReport.output,
          maxInputTokens: env.budgets.updateReport.input,
          viewedDep: name,
          fromVersion,
          toVersion,
          relatedDeps,
          relatedDetails,
          onPhase: (phaseEvent) => {
            report({
              current: 1,
              total: 2,
              label: phaseEvent.message,
              phase: 'ai',
              attempt: phaseEvent.attempt,
              maxAttempts: phaseEvent.maxAttempts
            });
          },
          signal
        })
      );

      await writeEnvelope<RelatedUpgradeDetail>(
        relatedUpgradeFilePath(slug, name, fromVersion, toVersion),
        {
          source: run.source,
          ttlHours: null, // manual regenerate only
          data: run.detail
        }
      );

      log.info(
        {
          source: run.source,
          recommendations: run.detail.recommendations.length,
          costEstimateUsd: run.detail.cost?.costEstimateUsd ?? null
        },
        `related-upgrade complete — source=${run.source}`
      );
      report({ current: 2, total: 2, label: 'Done', phase: 'ai' });

      return {
        resultUrl: `/api/projects/${slug}/versions/${encodeURIComponent(name)}/${encodeURIComponent(toVersion)}/related-upgrade`
      };
    }
  });

  return NextResponse.json<RelatedUpgradeEnqueueResponse>(
    { jobId: result.jobId, alreadyRunning: result.alreadyRunning },
    { status: result.alreadyRunning ? 200 : 202 }
  );
});
