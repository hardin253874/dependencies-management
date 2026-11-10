/**
 * DELETE /api/projects/:slug — remove a registered project (spec §9.3).
 * Optional query: ?deleteData=true also removes `library/<slug>/`.
 *
 * Before removing the dir: wait for any in-flight graph build (`graph:<slug>`
 * lock) and close cached graph readers. On Windows an open SQLite handle on
 * `graph.db` makes `fs.rm` fail with EBUSY/EPERM.
 */
import { promises as fs } from 'fs';
import { NextResponse } from 'next/server';
import { findBySlug, removeProject } from '@/lib/storage/projects';
import { projectDir } from '@/lib/paths';
import { withProjectGraphLock } from '@/lib/graph/graphService';
import { closeGraphReaders } from '@/lib/graph/readerCache';
import { withCsrf, type RouteCtx } from '@/lib/http/guards';
import { badRequest, internalError, notFound } from '@/lib/http/errors';
import { isValidParam } from '@/lib/http/validate';

export const DELETE = withCsrf<RouteCtx<{ slug: string }>>(async (req, ctx) => {
  const params = await ctx.params;
  const slug = params.slug;
  if (!isValidParam(slug)) {
    return badRequest('INVALID_SLUG', 'Slug failed allowlist validation.');
  }
  const entry = await findBySlug(slug);
  if (entry === null) {
    return notFound('PROJECT_NOT_FOUND', `No project with slug ${slug}.`);
  }
  const url = new URL(req.url);
  const deleteData = url.searchParams.get('deleteData') === 'true';
  try {
    await removeProject(slug);
    if (deleteData) {
      await withProjectGraphLock(slug, async () => {
        closeGraphReaders(slug);
        await fs.rm(projectDir(slug), { recursive: true, force: true });
      });
    }
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return internalError('PROJECT_DELETE_FAILED', (err as Error).message);
  }
});
