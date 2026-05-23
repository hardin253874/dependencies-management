/**
 * GET /api/projects/:slug/cost-summary
 *
 * Per-project aggregated cost summary for Settings → Cost (spec §7.7, §11.11).
 * Reads every persisted AI envelope under the project's library directory and
 * sums `cost.costEstimateUsd` per provider/model + per category.
 *
 * Always returns a fully-populated response shape — empty projects return 0s.
 */
import { NextResponse } from 'next/server';
import { findBySlug } from '@/lib/storage/projects';
import { computeCostSummary } from '@/lib/storage/costSummary';
import { badRequest, internalError, notFound } from '@/lib/http/errors';
import { withRequestLog } from '@/lib/http/guards';
import { isValidParam } from '@/lib/http/validate';
import type { CostSummaryResponse } from '@/lib/api-types';

export const GET = withRequestLog<{ params: { slug: string } }>(async (
  _req,
  ctx
): Promise<NextResponse> => {
  const slug = ctx.params.slug;
  if (!isValidParam(slug)) return badRequest('INVALID_SLUG', 'Slug failed allowlist validation.');

  const entry = await findBySlug(slug);
  if (entry === null) return notFound('PROJECT_NOT_FOUND', `No project with slug ${slug}.`);

  try {
    const summary = await computeCostSummary(slug);
    return NextResponse.json<CostSummaryResponse>(summary);
  } catch (err) {
    return internalError('COST_SUMMARY_FAILED', (err as Error).message);
  }
});
