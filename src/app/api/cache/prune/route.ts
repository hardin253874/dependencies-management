/**
 * POST /api/cache/prune — prune cached AI/registry reports (spec §9.3).
 *
 * Query params:
 *   - `olderThanDays`: integer ≥ 0
 *   - `dryRun`: 'true' | 'false' (default 'false')
 *
 * Response is the per-category prune counts + dry-run flag (so UI can decide
 * whether to show a preview or a confirmation).
 */
import { NextResponse } from 'next/server';
import { withCsrf } from '@/lib/http/guards';
import { badRequest, internalError } from '@/lib/http/errors';
import { pruneCache } from '@/lib/storage/prune';
import type { CachePruneResponse } from '@/lib/api-types';

export const POST = withCsrf<unknown>(async (req) => {
  const url = new URL(req.url);
  const olderThanDaysRaw = url.searchParams.get('olderThanDays') ?? '0';
  const dryRunRaw = url.searchParams.get('dryRun') ?? 'false';
  const olderThanDays = Number.parseInt(olderThanDaysRaw, 10);
  if (Number.isNaN(olderThanDays) || olderThanDays < 0) {
    return badRequest('INVALID_OLDER_THAN_DAYS', 'olderThanDays must be a non-negative integer.');
  }
  const dryRun = dryRunRaw === 'true';
  try {
    const result: CachePruneResponse = await pruneCache({ olderThanDays, dryRun });
    return NextResponse.json<CachePruneResponse>(result);
  } catch (err) {
    return internalError('PRUNE_FAILED', (err as Error).message);
  }
});
