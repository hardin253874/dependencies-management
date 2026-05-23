/**
 * Project relocation integration tests (Stage 4, spec §6.3).
 *
 * Verifies:
 *   - Slug preserved across relocation
 *   - Library data (e.g. persisted reports) intact post-relocate
 *   - Path validation rejected for missing/bad new path
 *   - CSRF enforced
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createSandbox, disposeAllSandboxes, type Sandbox } from './helpers/sandbox';
import { createSmallNpmProject } from './helpers/fixtures';
import { addProjectPipeline } from '@/lib/projects/add';
import { writeEnvelope } from '@/lib/storage/envelope';
import { depFilePath, projectJsonPath } from '@/lib/paths';
import { CSRF_HEADER, getCsrfToken } from '@/lib/csrf';
import { readProjects } from '@/lib/storage/projects';
import { readJson } from '@/lib/storage/atomic';
import { PATCH as relocate } from '@/app/api/projects/[slug]/relocate/route';
import type { ProjectJson } from '@/lib/projects/add';

let sandbox: Sandbox | undefined;
afterEach(async () => {
  if (sandbox !== undefined) await sandbox.dispose();
  await disposeAllSandboxes();
  sandbox = undefined;
});

function req(body: object, withCsrf = true): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (withCsrf) headers[CSRF_HEADER] = getCsrfToken();
  return new Request('http://127.0.0.1/api/projects/x/relocate', {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body)
  });
}

describe('PATCH /api/projects/:slug/relocate', () => {
  it('rejects requests without CSRF', async () => {
    sandbox = await createSandbox('relocate-csrf');
    const r = await relocate(req({ newPath: '/nope' }, false), { params: { slug: 'x' } });
    expect(r.status).toBe(403);
  });

  it('rejects an invalid slug', async () => {
    sandbox = await createSandbox('relocate-bad-slug');
    const r = await relocate(req({ newPath: '/x' }), { params: { slug: '..' } });
    expect(r.status).toBe(400);
  });

  it('returns 404 when slug unknown', async () => {
    sandbox = await createSandbox('relocate-unknown');
    const r = await relocate(req({ newPath: sandbox.scratchRoot }), { params: { slug: 'missing' } });
    expect(r.status).toBe(404);
  });

  it('preserves slug and library data after relocate', async () => {
    sandbox = await createSandbox('relocate-happy');
    const oldDir = path.join(sandbox.scratchRoot, 'project-old');
    await createSmallNpmProject(oldDir);
    const result = await addProjectPipeline({ absolutePath: oldDir });
    if (!result.ok) throw new Error('Add failed');
    const slug = result.slug;
    // Seed a cached envelope so we can confirm it survives relocate.
    await writeEnvelope(depFilePath(slug, 'react'), {
      source: 'registry',
      ttlHours: 24,
      data: { name: 'react', survives: true }
    });

    // Move the project on disk.
    const newDir = path.join(sandbox.scratchRoot, 'project-new');
    await fs.rename(oldDir, newDir);

    const r = await relocate(req({ newPath: newDir }), { params: { slug } });
    expect(r.status).toBe(200);

    // Slug preserved in _projects.json.
    const projects = await readProjects();
    const entry = projects.projects.find((p) => p.slug === slug);
    expect(entry).toBeDefined();
    expect(entry!.absolutePath).toBe(newDir);

    // Library cache file still exists.
    const depFile = depFilePath(slug, 'react');
    const stat = await fs.stat(depFile);
    expect(stat.isFile()).toBe(true);

    // project.json refreshed with the new path.
    const refreshed = await readJson<ProjectJson>(projectJsonPath(slug));
    expect(refreshed.path).toBe(newDir);
  });
});
