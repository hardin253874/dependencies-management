/**
 * GET /api/projects/:slug/reports/:name/:from/:to/cost-estimate — the [D]
 * confirm-modal estimate (v2 Stage 4a.12). Read-only: never starts a run.
 *
 * - `llm.reportEngine: 'agent'` (default): expected cost of a typical agent
 *   run (`estimatedCostUsd`) plus `maxUsd`, the run's hard USD budget the loop
 *   never passes, and the resolved `budgets`.
 * - `'v1'`: the single-shot estimate (one request at the [D] token budgets).
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
import { loadEnv } from '@/lib/config';
import { costEstimateUsd } from '@/lib/llm/cost';
import { agentRunEstimateResponse, UPDATE_SEED_BYTES_ESTIMATE } from '@/lib/agent/reportJobs';
import type { ProjectJson } from '@/lib/projects/add';
import type { DeepReportEstimateResponse } from '@/lib/api-types';

export const GET = withRequestLog<RouteCtx<{ slug: string; name: string; from: string; to: string }>>(async (_req, ctx): Promise<NextResponse> => {
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
    const totalPackages = project.dependencies.length;
    if (reportEngineOf(config.llm.reportEngine) === 'agent') {
      return NextResponse.json<DeepReportEstimateResponse>(
        agentRunEstimateResponse({ view: 'update-report', config, seedPromptBytes: UPDATE_SEED_BYTES_ESTIMATE, totalPackages })
      );
    }
    const budget = loadEnv().budgets.updateReport;
    return NextResponse.json<DeepReportEstimateResponse>({
      estimatedInputTokens: budget.input,
      estimatedOutputTokens: budget.output,
      estimatedCostUsd: costEstimateUsd(config.llm.model, { inputTokens: budget.input, outputTokens: budget.output }),
      provider: config.llm.provider,
      model: config.llm.model,
      totalPackages,
      engine: 'v1'
    });
  } catch (err) {
    return internalError('ESTIMATE_FAILED', (err as Error).message);
  }
});
