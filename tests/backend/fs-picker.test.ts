import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { listDirectory } from '@/lib/fs/picker';
import { createSandbox, disposeAllSandboxes, type Sandbox } from './helpers/sandbox';
import { createSmallNpmProject } from './helpers/fixtures';

let sandbox: Sandbox | undefined;

afterEach(async () => {
  if (sandbox !== undefined) await sandbox.dispose();
  await disposeAllSandboxes();
});

describe('listDirectory happy path', () => {
  it('lists immediate children, directories first', async () => {
    sandbox = await createSandbox('list-children');
    await fs.mkdir(path.join(sandbox.scratchRoot, 'dirB'));
    await fs.mkdir(path.join(sandbox.scratchRoot, 'dirA'));
    await fs.writeFile(path.join(sandbox.scratchRoot, 'fileZ.txt'), 'z');
    await fs.writeFile(path.join(sandbox.scratchRoot, 'fileA.txt'), 'a');

    const result = await listDirectory(sandbox.scratchRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.result.children.map((c) => c.name);
    // Directories first, then files; within each, alphabetical.
    expect(names).toEqual(['dirA', 'dirB', 'fileA.txt', 'fileZ.txt']);
  });

  it('flags entries that look like target projects', async () => {
    sandbox = await createSandbox('list-flags');
    const projDir = path.join(sandbox.scratchRoot, 'my-app');
    await createSmallNpmProject(projDir);
    const result = await listDirectory(sandbox.scratchRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const proj = result.result.children.find((c) => c.name === 'my-app');
    expect(proj).toBeDefined();
    expect(proj?.hasPackageJson).toBe(true);
    expect(proj?.hasLockfile).toBe(true);
  });
});
