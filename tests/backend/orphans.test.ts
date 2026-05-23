/**
 * Job journal orphan detection (spec §10.10).
 *
 * Covered:
 *   - Stale `_jobs/<jobId>.json` from a prior boot is surfaced via detectOrphans
 *   - discardOrphan deletes the journal file
 *   - Cache invalidation: subsequent detect picks up new state immediately
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { createSandbox, disposeAllSandboxes, type Sandbox } from './helpers/sandbox';
import { createSmallNpmProject } from './helpers/fixtures';
import { addProjectPipeline } from '@/lib/projects/add';
import { detectOrphans, discardOrphan, resetOrphanCache } from '@/lib/jobs/orphans';
import { jobJournalPath, projectJobsDir } from '@/lib/paths';
import { atomicWriteJson } from '@/lib/storage/atomic';

let sandbox: Sandbox | undefined;

afterEach(async () => {
  if (sandbox !== undefined) await sandbox.dispose();
  await disposeAllSandboxes();
  resetOrphanCache();
});

describe('orphan detection on boot', () => {
  it('surfaces a stale _jobs/<jobId>.json as an orphan', async () => {
    sandbox = await createSandbox('orphans');
    const dir = await sandbox.scratch('proj');
    await createSmallNpmProject(dir);
    const add = await addProjectPipeline({ absolutePath: dir });
    if (!add.ok) return;
    const jobId = 'aaaaaaaaaaaaaaaaaaaaaaaa';

    await fs.mkdir(projectJobsDir(add.slug), { recursive: true });
    await atomicWriteJson(jobJournalPath(add.slug, jobId), {
      jobId,
      slug: add.slug,
      resourceKey: 'scan:phase-2:' + add.slug,
      kind: 'scan:phase-2',
      state: 'running',
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      startedAt: new Date(Date.now() - 30_000).toISOString(),
      finishedAt: null,
      progress: null,
      error: null,
      resultUrl: null
    });

    const orphans = await detectOrphans(true);
    expect(orphans.length).toBe(1);
    expect(orphans[0]?.slug).toBe(add.slug);
    expect(orphans[0]?.jobId).toBe(jobId);
    expect(orphans[0]?.kind).toBe('scan:phase-2');
  });

  it('discardOrphan deletes the journal and clears it from the next detection', async () => {
    sandbox = await createSandbox('orphans-discard');
    const dir = await sandbox.scratch('proj');
    await createSmallNpmProject(dir);
    const add = await addProjectPipeline({ absolutePath: dir });
    if (!add.ok) return;
    const jobId = 'bbbbbbbbbbbbbbbbbbbbbbbb';

    await fs.mkdir(projectJobsDir(add.slug), { recursive: true });
    await atomicWriteJson(jobJournalPath(add.slug, jobId), {
      jobId,
      slug: add.slug,
      resourceKey: 'k',
      kind: 'noop',
      state: 'running',
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      progress: null,
      error: null,
      resultUrl: null
    });

    const before = await detectOrphans(true);
    expect(before.length).toBe(1);

    const discarded = await discardOrphan(add.slug, jobId);
    expect(discarded).toBe(true);

    const after = await detectOrphans(true);
    expect(after.length).toBe(0);
  });
});
