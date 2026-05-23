/**
 * Cache prune + library size tests (spec §9.3).
 *
 * Covered:
 *   - Dry-run returns counts only; no files deleted
 *   - Non-dry-run actually deletes
 *   - olderThanDays filter respected
 *   - Library size returns correct byte sum
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { createSandbox, disposeAllSandboxes, type Sandbox } from './helpers/sandbox';
import { createSmallNpmProject } from './helpers/fixtures';
import { addProjectPipeline } from '@/lib/projects/add';
import { writeEnvelope } from '@/lib/storage/envelope';
import { depFilePath, versionFilePath } from '@/lib/paths';
import { pruneCache } from '@/lib/storage/prune';
import { computeLibrarySize } from '@/lib/storage/size';

let sandbox: Sandbox | undefined;

afterEach(async () => {
  if (sandbox !== undefined) await sandbox.dispose();
  await disposeAllSandboxes();
});

async function makeProjectWithCache(): Promise<{ slug: string }> {
  sandbox = await createSandbox('prune-test');
  const dir = await sandbox.scratch('project');
  await createSmallNpmProject(dir);
  const result = await addProjectPipeline({ absolutePath: dir });
  if (!result.ok) throw new Error('add failed');
  return { slug: result.slug };
}

describe('pruneCache', () => {
  it('dry-run reports counts but does not delete', async () => {
    const { slug } = await makeProjectWithCache();
    const oldDate = new Date(Date.now() - 30 * 86_400_000).toISOString();
    await writeEnvelope(depFilePath(slug, 'react'), {
      source: 'registry',
      ttlHours: 24,
      data: { fake: true },
      generatedAt: oldDate
    });
    const dry = await pruneCache({ olderThanDays: 7, dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.byKind.deps.files).toBe(1);
    // File should still exist after dry-run.
    await expect(fs.access(depFilePath(slug, 'react'))).resolves.toBeUndefined();
  });

  it('non-dry-run actually deletes', async () => {
    const { slug } = await makeProjectWithCache();
    const oldDate = new Date(Date.now() - 30 * 86_400_000).toISOString();
    await writeEnvelope(depFilePath(slug, 'react'), {
      source: 'registry',
      ttlHours: 24,
      data: { fake: true },
      generatedAt: oldDate
    });
    const out = await pruneCache({ olderThanDays: 7, dryRun: false });
    expect(out.byKind.deps.files).toBe(1);
    await expect(fs.access(depFilePath(slug, 'react'))).rejects.toThrow();
  });

  it('respects olderThanDays threshold', async () => {
    const { slug } = await makeProjectWithCache();
    const recentDate = new Date(Date.now() - 3 * 86_400_000).toISOString();
    await writeEnvelope(depFilePath(slug, 'react'), {
      source: 'registry',
      ttlHours: 24,
      data: { fake: true },
      generatedAt: recentDate
    });
    const out = await pruneCache({ olderThanDays: 7, dryRun: false });
    expect(out.byKind.deps.files).toBe(0); // 3d < 7d threshold
    await expect(fs.access(depFilePath(slug, 'react'))).resolves.toBeUndefined();
  });

  it('walks nested versions directory', async () => {
    const { slug } = await makeProjectWithCache();
    const oldDate = new Date(Date.now() - 30 * 86_400_000).toISOString();
    await writeEnvelope(versionFilePath(slug, 'react', '19.0.0'), {
      source: 'registry',
      ttlHours: 168,
      data: { fake: true },
      generatedAt: oldDate
    });
    const out = await pruneCache({ olderThanDays: 7, dryRun: false });
    expect(out.byKind.versions.files).toBe(1);
  });
});

describe('computeLibrarySize', () => {
  it('returns byte sum across categories', async () => {
    const { slug } = await makeProjectWithCache();
    await writeEnvelope(depFilePath(slug, 'react'), {
      source: 'registry',
      ttlHours: 24,
      data: { fake: true }
    });
    const out = await computeLibrarySize();
    expect(out.totalBytes).toBeGreaterThan(0);
    expect(out.byKind.deps).toBeGreaterThan(0);
    expect(out.byKind.config).toBeGreaterThan(0); // _projects.json
  });
});
