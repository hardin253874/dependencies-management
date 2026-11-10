/**
 * V2_STAGE3_SPEC 3b-A.4: the graph never blocks project deletion (Windows
 * keeps open SQLite files locked) and is rebuilt in full after a relocation.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { createSandbox, disposeAllSandboxes, type Sandbox } from './helpers/sandbox';
import { createSmallNpmProject, routeCtx } from './helpers/fixtures';
import { writeProjectFile } from './helpers/graphFixture';
import { addProjectPipeline } from '@/lib/projects/add';
import { CSRF_HEADER, getCsrfToken } from '@/lib/csrf';
import { graphDbPath, projectDir, projectJsonPath } from '@/lib/paths';
import { readJson } from '@/lib/storage/atomic';
import { graphLockKey, refreshProjectGraph } from '@/lib/graph/graphService';
import { _openGraphReaderCount, closeGraphReaders, getGraphReader } from '@/lib/graph/readerCache';
import { withProjectLock } from '@/lib/storage/projectLock';
import type { ProjectJson } from '@/lib/projects/add';

import { DELETE as deleteProject } from '@/app/api/projects/[slug]/route';
import { PATCH as relocateProject } from '@/app/api/projects/[slug]/relocate/route';

let sandbox: Sandbox | undefined;
let slug = '';

afterEach(async () => {
  if (slug !== '') closeGraphReaders(slug);
  slug = '';
  if (sandbox !== undefined) await sandbox.dispose();
  sandbox = undefined;
  await disposeAllSandboxes();
});

function req(method: string, url: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { [CSRF_HEADER]: getCsrfToken(), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

async function setup(name: string): Promise<{ dir: string; slug: string }> {
  sandbox = await createSandbox(name);
  const dir = await sandbox.scratch('app');
  await createSmallNpmProject(dir);
  await writeProjectFile(dir, 'src/index.ts', `import React from 'react';\nexport default React;\n`);
  const add = await addProjectPipeline({ absolutePath: dir });
  if (!add.ok) throw new Error(`add failed: ${add.error.code}`);
  slug = add.slug;
  return { dir, slug: add.slug };
}

describe('DELETE /api/projects/:slug with a graph', () => {
  it('closes the cached reader and removes library/<slug>/ including graph.db', async () => {
    const { dir, slug: s } = await setup('delete-graph');
    await refreshProjectGraph({ slug: s, projectRoot: dir });
    getGraphReader(s);
    expect(_openGraphReaderCount()).toBe(1);
    expect(existsSync(graphDbPath(s))).toBe(true);

    const res = await deleteProject(req('DELETE', `http://127.0.0.1/api/projects/${s}?deleteData=true`), routeCtx({ slug: s }));
    expect(res.status).toBe(204);
    expect(_openGraphReaderCount()).toBe(0);
    expect(existsSync(projectDir(s))).toBe(false);
  });

  it('waits for an in-flight graph build before removing the dir', async () => {
    const { slug: s } = await setup('delete-graph-wait');
    const order: string[] = [];
    let release!: () => void;
    const build = withProjectLock(graphLockKey(s), () => {
      order.push('build-start');
      return new Promise<void>((resolve) => (release = resolve)).then(() => {
        order.push('build-end');
      });
    });
    const del = Promise.resolve(deleteProject(req('DELETE', `http://127.0.0.1/api/projects/${s}?deleteData=true`), routeCtx({ slug: s }))).then(
      (r) => {
        order.push('deleted');
        return r;
      }
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(projectDir(s))).toBe(true);
    release();
    const [, res] = await Promise.all([build, del]);
    expect(res.status).toBe(204);
    expect(order).toEqual(['build-start', 'build-end', 'deleted']);
    expect(existsSync(projectDir(s))).toBe(false);
  });

  it('keeps library data (and the graph) without deleteData', async () => {
    const { dir, slug: s } = await setup('delete-graph-keep');
    await refreshProjectGraph({ slug: s, projectRoot: dir });
    const res = await deleteProject(req('DELETE', `http://127.0.0.1/api/projects/${s}`), routeCtx({ slug: s }));
    expect(res.status).toBe(204);
    expect(existsSync(graphDbPath(s))).toBe(true);
  });
});

describe('relocate then refresh', () => {
  it('rebuilds the graph in full because the project root changed', async () => {
    const { dir, slug: s } = await setup('relocate-graph');
    const first = await refreshProjectGraph({ slug: s, projectRoot: dir });
    expect(first.mode).toBe('full');
    getGraphReader(s);

    const moved = path.join(path.dirname(dir), 'app-moved');
    await fs.cp(dir, moved, { recursive: true });
    const res = await relocateProject(req('PATCH', `http://127.0.0.1/api/projects/${s}/relocate`, { newPath: moved }), routeCtx({ slug: s }));
    expect(res.status).toBe(200);
    const project = await readJson<ProjectJson>(projectJsonPath(s));
    expect(path.resolve(project.path)).toBe(path.resolve(moved));

    const again = await refreshProjectGraph({ slug: s, projectRoot: project.path });
    expect(again.mode).toBe('full');
    expect(again.rebuildReason).toBeUndefined();
  });
});
