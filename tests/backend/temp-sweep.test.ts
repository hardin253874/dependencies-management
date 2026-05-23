import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sweepTempSandboxes, depAgentTempRoot } from '@/lib/jobs/tempSweep';

afterEach(async () => {
  await fs.rm(depAgentTempRoot(), { recursive: true, force: true }).catch(() => undefined);
});

describe('boot-time temp sweep (spec §10.7)', () => {
  it('removes orphan dirs older than the threshold', async () => {
    const root = depAgentTempRoot();
    await fs.mkdir(root, { recursive: true });
    const orphan = path.join(root, 'orphan');
    await fs.mkdir(orphan);
    // Backdate mtime so it appears older than the cutoff
    const ago = new Date(Date.now() - 7_200_000);
    await fs.utimes(orphan, ago, ago);

    const fresh = path.join(root, 'fresh');
    await fs.mkdir(fresh);

    const result = await sweepTempSandboxes(3_600_000);
    expect(result.removed.some((p) => p.endsWith('orphan'))).toBe(true);
    expect(result.kept.some((p) => p.endsWith('fresh'))).toBe(true);

    // Re-verify on disk
    await expect(fs.stat(orphan)).rejects.toThrow();
    await expect(fs.stat(fresh)).resolves.toBeDefined();
  });

  it('returns empty result when root does not exist', async () => {
    await fs.rm(depAgentTempRoot(), { recursive: true, force: true }).catch(() => undefined);
    const result = await sweepTempSandboxes();
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([]);
  });
});
