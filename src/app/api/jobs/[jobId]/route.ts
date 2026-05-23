/**
 * GET /api/jobs/:jobId — snapshot of a job's state (source of truth).
 * DELETE /api/jobs/:jobId — cancel a job (spec §9.3, §7.9).
 */
import { NextResponse } from 'next/server';
import { getJobQueue } from '@/lib/jobs/queue';
import { withCsrf, withRequestLog } from '@/lib/http/guards';
import { badRequest, notFound } from '@/lib/http/errors';
import { isValidParam } from '@/lib/http/validate';
import type { JobRecord } from '@/lib/api-types';

export const GET = withRequestLog<{ params: { jobId: string } }>(async (_req, ctx) => {
  if (!isValidParam(ctx.params.jobId)) {
    return badRequest('INVALID_JOB_ID', 'Job id failed allowlist validation.');
  }
  const rec = getJobQueue().get(ctx.params.jobId);
  if (rec === null) return notFound('JOB_NOT_FOUND', `No job with id ${ctx.params.jobId}.`);
  return NextResponse.json<JobRecord>(rec);
});

export const DELETE = withCsrf<{ params: { jobId: string } }>(async (_req, ctx) => {
  if (!isValidParam(ctx.params.jobId)) {
    return badRequest('INVALID_JOB_ID', 'Job id failed allowlist validation.');
  }
  const ok = getJobQueue().cancel(ctx.params.jobId);
  if (!ok) return notFound('JOB_NOT_FOUND_OR_DONE', 'Job not found or already finished.');
  return new NextResponse(null, { status: 204 });
});
