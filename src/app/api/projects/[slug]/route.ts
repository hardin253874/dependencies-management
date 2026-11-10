/**
 * PATCH /api/projects/:slug — per-project Jev settings (v2 Stage 5b.9):
 * `privacy` ('public' | 'private' | null = unknown), `judge` ('on' | 'off'),
 * `judgeSourceOptIn` (J1-J3 source snippets on a private project). Writes
 * `library/<slug>/project.json` only (via the canonical writer, under the project lock).
 *
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
import { withCsrf, readJsonBody, isNextResponse, type RouteCtx } from '@/lib/http/guards';
import { withProjectLock } from '@/lib/storage/projectLock';
import { getCanonicalWriter } from '@/lib/storage/canonicalWriter';
import { buildSummary } from '@/lib/projects/summary';
import type { ProjectJson } from '@/lib/projects/add';
import type { ProjectSettingsPatch, ProjectSummary } from '@/lib/api-types';
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

export const PATCH = withCsrf<RouteCtx<{ slug: string }>>(async (req, ctx) => {
  const params = await ctx.params;
  const slug = params.slug;
  if (!isValidParam(slug)) return badRequest('INVALID_SLUG', 'Slug failed allowlist validation.');
  const body = await readJsonBody<ProjectSettingsPatch>(req);
  if (isNextResponse(body)) return body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return badRequest('INVALID_BODY', 'Body must be an object.');
  if (body.privacy !== undefined && body.privacy !== null && body.privacy !== 'public' && body.privacy !== 'private') {
    return badRequest('INVALID_BODY', 'privacy must be "public", "private" or null.');
  }
  if (body.judge !== undefined && body.judge !== 'on' && body.judge !== 'off') return badRequest('INVALID_BODY', 'judge must be "on" or "off".');
  if (body.judgeSourceOptIn !== undefined && typeof body.judgeSourceOptIn !== 'boolean') return badRequest('INVALID_BODY', 'judgeSourceOptIn must be a boolean.');
  const entry = await findBySlug(slug);
  if (entry === null) return notFound('PROJECT_NOT_FOUND', `No project with slug ${slug}.`);
  try {
    // Through the canonical writer: it holds project.json in memory (badge patches), so a direct
    // file write would be overwritten by its next flush. `undefined` drops the field on write.
    await withProjectLock(slug, async () => {
      const writer = await getCanonicalWriter(slug);
      const patch: Partial<ProjectJson> = {};
      if (body.privacy !== undefined) patch.privacy = body.privacy ?? undefined;
      if (body.judge !== undefined) patch.judge = body.judge;
      if (body.judgeSourceOptIn !== undefined) patch.judgeSourceOptIn = body.judgeSourceOptIn ? true : undefined;
      writer.patchTopLevel(patch);
      await writer.flush();
    });
    return NextResponse.json<ProjectSummary>(await buildSummary(entry));
  } catch (err) {
    return internalError('PROJECT_SETTINGS_FAILED', (err as Error).message);
  }
});
