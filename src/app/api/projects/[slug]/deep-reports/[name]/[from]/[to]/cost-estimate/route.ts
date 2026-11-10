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
 *
 * v2 Stage 4a.12: with `llm.reportEngine: 'agent'` (default) the response is
 * the agent-run estimate (`estimatedCostUsd` = expected, plus `maxUsd` = the
 * run's hard USD budget and the resolved `budgets`). Never starts a run.
 */
import { NextResponse } from 'next/server';
import { findBySlug } from '@/lib/storage/projects';
import { projectJsonPath } from '@/lib/paths';
import { readJson } from '@/lib/storage/atomic';
import { badRequest, notFound, internalError } from '@/lib/http/errors';
import { withRequestLog, type RouteCtx } from '@/lib/http/guards';
import { isValidParam, isValidVersionParam } from '@/lib/http/validate';
import { decodeAndValidatePackageName } from '@/lib/http/packageName';
import { readConfig, reportEngineOf } from '@/lib/storage/config';
import { agentRunEstimateResponse } from '@/lib/agent/reportJobs';
import { loadEnv } from '@/lib/config';
import { computeDeepReportEstimate, ESTIMATE_BASE_TOKENS, ESTIMATE_INPUT_CAP, ESTIMATE_TOKENS_PER_PACKAGE } from '@/lib/llm/estimate';
import type { ProjectJson } from '@/lib/projects/add';
import type { DeepReportEstimateResponse } from '@/lib/api-types';

export const GET = withRequestLog<RouteCtx<{ slug: string; name: string; from: string; to: string }>>(async (
  _req,
  ctx
): Promise<NextResponse> => {
  const params = await ctx.params;
  const { slug, from, to } = params;
  if (!isValidParam(slug)) return badRequest('INVALID_SLUG', 'Slug failed allowlist validation.');
  if (!isValidVersionParam(from)) return badRequest('INVALID_VERSION', '`from` failed allowlist validation.');
  if (!isValidVersionParam(to)) return badRequest('INVALID_VERSION', '`to` failed allowlist validation.');

  const name = decodeAndValidatePackageName(params.name);
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

    if (reportEngineOf(config.llm.reportEngine) === 'agent') {
      // The agent seed embeds the same pre-computed deep facts as the v1 prompt.
      const seedTokens = Math.min(ESTIMATE_BASE_TOKENS + totalPackages * ESTIMATE_TOKENS_PER_PACKAGE, ESTIMATE_INPUT_CAP);
      return NextResponse.json<DeepReportEstimateResponse>(
        agentRunEstimateResponse({ view: 'deep-report', config, seedPromptBytes: seedTokens * 4, totalPackages })
      );
    }

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
