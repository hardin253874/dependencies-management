/**
 * DELETE /api/jobs/orphans/:slug/:jobId — discard an orphan journal entry.
 *
 * Spec §10.10: lets the UI dismiss the "Previous job interrupted" banner. The
 * actual restart-from-orphan UX is implemented client-side: the FE inspects
 * the orphan kind + resourceKey and re-issues the appropriate POST refresh.
 */
import { NextResponse } from 'next/server';
import { withCsrf } from '@/lib/http/guards';
import { badRequest, notFound } from '@/lib/http/errors';
import { isValidParam } from '@/lib/http/validate';
import { discardOrphan } from '@/lib/jobs/orphans';

export const DELETE = withCsrf<{ params: { slug: string; jobId: string } }>(async (_req, ctx) => {
  const { slug, jobId } = ctx.params;
  if (!isValidParam(slug)) return badRequest('INVALID_SLUG', 'Slug failed allowlist validation.');
  if (!isValidParam(jobId)) return badRequest('INVALID_JOB_ID', 'Job id failed allowlist validation.');
  const ok = await discardOrphan(slug, jobId);
  if (!ok) return notFound('ORPHAN_NOT_FOUND', 'No orphan with that id for that project.');
  return new NextResponse(null, { status: 204 });
});
