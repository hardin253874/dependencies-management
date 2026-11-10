/**
 * V2_STAGE3_SPEC 3b-A.3: the three former `scanCode` call sites now read
 * from the code graph. Job kinds, envelope source/TTL, response shapes and
 * status codes stay as they were.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { createSandbox, disposeAllSandboxes, type Sandbox } from './helpers/sandbox';
import { createSmallNpmProject, routeCtx } from './helpers/fixtures';
import { writeProjectFile } from './helpers/graphFixture';
import { addProjectPipeline } from '@/lib/projects/add';
import { CSRF_HEADER, getCsrfToken } from '@/lib/csrf';
import { getJobQueue } from '@/lib/jobs/queue';
import { depFilePath, graphDbPath, usageFilePath } from '@/lib/paths';
import { readEnvelope, writeEnvelope } from '@/lib/storage/envelope';
import { closeGraphReaders } from '@/lib/graph/readerCache';
import type { DepDetail, RelatedUsageEnqueueResponse, ScanEnqueueResponse, UsageDetail } from '@/lib/api-types';
import type { JobRecord } from '@/lib/jobs/types';

import { POST as refreshUsage } from '@/app/api/projects/[slug]/usage/[name]/refresh/route';
import { POST as refreshRelated } from '@/app/api/projects/[slug]/usage/related/[name]/refresh/route';
import { POST as refreshCveImpact } from '@/app/api/projects/[slug]/deps/[name]/cve-impact/refresh/route';

let sandbox: Sandbox | undefined;
let slug = '';

beforeEach(() => {
  process.env.MOCK_LLM = 'true';
});

afterEach(async () => {
  delete process.env.MOCK_LLM;
  if (slug !== '') closeGraphReaders(slug);
  slug = '';
  if (sandbox !== undefined) await sandbox.dispose();
  sandbox = undefined;
  await disposeAllSandboxes();
});

function post(): Request {
  return new Request('http://127.0.0.1/test', { method: 'POST', headers: { [CSRF_HEADER]: getCsrfToken() } });
}

async function awaitJob(jobId: string): Promise<JobRecord> {
  const queue = getJobQueue();
  for (let i = 0; i < 500; i += 1) {
    const rec = queue.get(jobId);
    if (rec !== null && (rec.state === 'done' || rec.state === 'error' || rec.state === 'cancelled')) return rec;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`job ${jobId} did not finish`);
}

/** A registered small project whose sources use react / react-dom, one through a barrel. */
async function setupProject(name: string): Promise<string> {
  sandbox = await createSandbox(name);
  const dir = await sandbox.scratch('app');
  await createSmallNpmProject(dir);
  await writeProjectFile(dir, 'src/App.tsx', `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nexport default React;\n`);
  await writeProjectFile(dir, 'src/App.test.tsx', `import { render } from 'react-dom';\nexport const t = render;\n`);
  await writeProjectFile(dir, 'src/ui/index.ts', `export { useState } from 'react';\n`);
  await writeProjectFile(dir, 'src/Counter.tsx', `import { useState } from './ui';\nexport const c = useState;\n`);
  await writeProjectFile(dir, 'src/dyn.ts', `const m = 'x';\nimport(m);\n`);
  const add = await addProjectPipeline({ absolutePath: dir });
  if (!add.ok) throw new Error(`add failed: ${add.error.code}`);
  slug = add.slug;
  return slug;
}

async function cacheDepDetail(s: string, name: string, extra: Partial<DepDetail>): Promise<void> {
  const detail = {
    name,
    availableVersions: [],
    support: null,
    license: null,
    deprecation: null,
    currentVersionCves: [],
    latestPeerDeps: {},
    latestEngines: {},
    relatedDeps: [],
    ...extra
  } as unknown as DepDetail;
  await writeEnvelope(depFilePath(s, name), { source: 'registry', ttlHours: 24, data: detail });
}

describe('POST /usage/:name/refresh reads from the graph', () => {
  it('writes the v1-shaped usage envelope and library/<slug>/graph.db', async () => {
    const s = await setupProject('usage-route-graph');
    const res = await refreshUsage(post(), routeCtx({ slug: s, name: 'react' }));
    expect(res.status).toBe(202);
    const body = (await res.json()) as ScanEnqueueResponse;
    expect(body.alreadyRunning).toBe(false);
    const job = await awaitJob(body.jobId);
    expect(job.state).toBe('done');
    expect(job.kind).toBe('refresh:usage');
    expect(job.resultUrl).toBe(`/api/projects/${s}/usage/react`);

    expect(existsSync(graphDbPath(s))).toBe(true);
    const env = await readEnvelope<UsageDetail>(usageFilePath(s, 'react'));
    expect(env.source).toBe('deterministic');
    expect(env.ttlHours).toBeNull();
    expect(env.data.files.map((f) => [f.path, f.category, f.importCount])).toEqual([
      ['src/App.tsx', 'prod', 1],
      ['src/Counter.tsx', 'prod', 1],
      ['src/ui/index.ts', 'prod', 1]
    ]);
    expect(env.data.totalFiles).toBe(3);
    expect(env.data.declaredButUnused).toBe(false);
    expect(env.data.dynamicImports).toEqual([{ file: 'src/dyn.ts', line: 2, snippet: 'import(m);' }]);
    expect(env.data.oversizedSkipped).toEqual([]);
  });

  it('marks a declared dep nobody imports as declaredButUnused', async () => {
    const s = await setupProject('usage-route-unused');
    const body = (await (await refreshUsage(post(), routeCtx({ slug: s, name: 'typescript' }))).json()) as ScanEnqueueResponse;
    expect((await awaitJob(body.jobId)).state).toBe('done');
    const env = await readEnvelope<UsageDetail>(usageFilePath(s, 'typescript'));
    expect(env.data).toMatchObject({ files: [], totalFiles: 0, declaredButUnused: true });
  });

  it('keeps the 404 for an unknown project', async () => {
    sandbox = await createSandbox('usage-route-404');
    const res = await refreshUsage(post(), routeCtx({ slug: 'nope', name: 'react' }));
    expect(res.status).toBe(404);
  });
});

describe('POST /usage/related/:name/refresh reads from the graph', () => {
  it('builds the graph once and writes one envelope per related dep', async () => {
    const s = await setupProject('related-route-graph');
    await cacheDepDetail(s, 'react', {
      relatedDeps: [
        { name: 'react-dom', installedVersion: '18.3.1', reasons: [], health: { deprecated: null, cveCount: null, maxCveSeverity: null, eol: null, ageDays: null } },
        { name: 'typescript', installedVersion: '5.5.3', reasons: [], health: { deprecated: null, cveCount: null, maxCveSeverity: null, eol: null, ageDays: null } }
      ]
    });
    const res = await refreshRelated(post(), routeCtx({ slug: s, name: 'react' }));
    expect(res.status).toBe(202);
    const body = (await res.json()) as RelatedUsageEnqueueResponse;
    expect(body.names).toEqual(['react-dom', 'typescript']);
    const job = await awaitJob(body.jobId);
    expect(job.state).toBe('done');
    expect(job.kind).toBe('refresh:usage-related');
    expect(existsSync(graphDbPath(s))).toBe(true);

    const dom = await readEnvelope<UsageDetail>(usageFilePath(s, 'react-dom'));
    expect(dom.source).toBe('deterministic');
    expect(dom.data.files.map((f) => [f.path, f.category])).toEqual([
      ['src/App.test.tsx', 'test'],
      ['src/App.tsx', 'prod']
    ]);
    const ts = await readEnvelope<UsageDetail>(usageFilePath(s, 'typescript'));
    expect(ts.data.declaredButUnused).toBe(true);
  });
});

describe('POST /deps/:name/cve-impact/refresh cascade reads from the graph', () => {
  it('runs the graph-backed usage step when the usage cache is missing', async () => {
    const s = await setupProject('cve-route-graph');
    await cacheDepDetail(s, 'react', { currentVersionCves: [{ id: 'GHSA-test-0001', severity: 'high', summary: 'test advisory' }] });
    const res = await refreshCveImpact(post(), routeCtx({ slug: s, name: 'react' }));
    expect(res.status).toBe(202);
    const body = (await res.json()) as ScanEnqueueResponse;
    const job = await awaitJob(body.jobId);
    expect(job.state).toBe('done');
    expect(existsSync(graphDbPath(s))).toBe(true);
    const usage = await readEnvelope<UsageDetail>(usageFilePath(s, 'react'));
    expect(usage.source).toBe('deterministic');
    expect(usage.data.files.map((f) => f.path)).toEqual(['src/App.tsx', 'src/Counter.tsx', 'src/ui/index.ts']);
  });

  it('does not touch the graph when the usage cache already exists', async () => {
    const s = await setupProject('cve-route-cached');
    await cacheDepDetail(s, 'react', { currentVersionCves: [{ id: 'GHSA-test-0002', severity: 'low', summary: 'test advisory' }] });
    const cached: UsageDetail = { files: [], dynamicImports: [], totalFiles: 0, declaredButUnused: true, oversizedSkipped: [] };
    await writeEnvelope(usageFilePath(s, 'react'), { source: 'deterministic', ttlHours: null, data: cached });
    const body = (await (await refreshCveImpact(post(), routeCtx({ slug: s, name: 'react' }))).json()) as ScanEnqueueResponse;
    expect((await awaitJob(body.jobId)).state).toBe('done');
    expect(existsSync(graphDbPath(s))).toBe(false);
  });
});
