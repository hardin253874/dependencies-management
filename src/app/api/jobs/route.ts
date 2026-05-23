/**
 * GET /api/jobs — list in-flight + recent jobs + orphans from prior boots.
 *
 * Spec §10.10: orphans surface here so the UI can show
 * "Previous job interrupted — Re-run? / Discard".
 */
import { NextResponse } from 'next/server';
import { getJobQueue } from '@/lib/jobs/queue';
import { detectOrphans } from '@/lib/jobs/orphans';
import { withRequestLog } from '@/lib/http/guards';
import type { JobsListWithOrphansResponse } from '@/lib/api-types';

export const GET = withRequestLog<unknown>(async () => {
  const queue = getJobQueue();
  const orphans = await detectOrphans();
  return NextResponse.json<JobsListWithOrphansResponse>({
    jobs: queue.list(),
    orphans
  });
});
