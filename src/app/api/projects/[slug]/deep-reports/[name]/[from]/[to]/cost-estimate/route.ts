/**
 * GET /api/projects/:slug/deep-reports/:name/:from/:to/cost-estimate
 *
 * Returns a cost estimate for the FIRST-Deep-Analyze confirmation prompt
 * (spec §7.6 — "estimated cost: ~$X. Continue?"). The estimate is based on:
 *   - Total lockfile package count (proxy for transitive complexity)
 *   - Baked-in heuristic input-token formula
 *   - Active model's pricing from `cost.ts`
 *
 * This is intentionally generous so the actual call rarely exceeds the
 * estimate. The Settings → Behavior toggle "Show Deep Analyze cost warning"
 * controls whether the UI surfaces this on subsequent runs.
 *
 * Path-naming note: the folder used to be `estimate/`, which served at
 * `/estimate`. The client (api-client.ts `getDeepReportCostEstimate`) and
 * the test fake fetcher both pointed at `/cost-estimate`, so the modal
 * always 404'd in dev/prod. Renamed to `cost-estimate/` to match the
 * canonical contract.
 */
import { NextResponse } from 'next/server';
import { findBySlug } from '@/lib/storage/projects';
import { projectJsonPath } from '@/lib/paths';
import { readJson } from '@/lib/storage/atomic';
import { badRequest, notFound, internalError } from '@/lib/http/errors';
import { withRequestLog } from '@/lib/http/guards';
import { isValidParam, isValidVersionParam } from '@/lib/http/validate';
import { decodeAndValidatePackageName } from '@/lib/http/packageName';
import { readConfig } from '@/lib/storage/config';
import { loadEnv } from '@/lib/config';
import { computeDeepReportEstimate } from '@/lib/llm/estimate';
import type { ProjectJson } from '@/lib/projects/add';
import type { DeepReportEstimateResponse } from '@/lib/api-types';

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

  try {
    const project = await readJson<ProjectJson>(projectJsonPath(slug));
    const config = await readConfig();
    const env = loadEnv();
    const totalPackages = project.dependencies.length; // direct deps proxy when no full scan
    // Better proxy: parse the lockfile? Phase 1 already stored lockfileStateHash
    // but not the package count. For v1 we use direct dep count as the lower
    // bound; the deep scan itself will compute the true count.

    const result = computeDeepReportEstimate({
      provider: config.llm.provider,
      model: config.llm.model,
      totalPackages,
      outputBudgetTokens: env.budgets.deepReport.output
    });

    return NextResponse.json<DeepReportEstimateResponse>(result);
  } catch (err) {
    return internalError('ESTIMATE_FAILED', (err as Error).message);
  }
});
