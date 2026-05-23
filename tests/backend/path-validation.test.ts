import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { validateProjectPath } from '@/lib/projects/validate';
import { addProject } from '@/lib/storage/projects';
import { createSandbox, disposeAllSandboxes, type Sandbox } from './helpers/sandbox';
import { createSmallNpmProject } from './helpers/fixtures';

let sandbox: Sandbox | undefined;

afterEach(async () => {
  if (sandbox !== undefined) await sandbox.dispose();
  await disposeAllSandboxes();
});

describe('validateProjectPath', () => {
  it('rejects relative paths', async () => {
    sandbox = await createSandbox('val-rel');
    const result = await validateProjectPath('relative/path');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_ABSOLUTE');
  });

  it('rejects empty string', async () => {
    const result = await validateProjectPath('');
    expect(result.ok).toBe(false);
  });

  it('rejects path-traversal segments (..)', async () => {
    sandbox = await createSandbox('val-trav');
    const dir = await sandbox.scratch('proj');
    await createSmallNpmProject(dir);
    // Build with string concat, not path.join. path.join would normalize `..`
    // away before validateProjectPath ever sees it, which would defeat the
    // intent of this test (and silently hide a real bug — see spec §9.4).
    const naughty = `${dir}${path.sep}..${path.sep}${path.basename(dir)}`;
    const result = await validateProjectPath(naughty);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PATH_TRAVERSAL');
  });

  it('rejects non-existent path', async () => {
    sandbox = await createSandbox('val-missing');
    const result = await validateProjectPath(path.join(sandbox.scratchRoot, 'does-not-exist'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
  });

  it('rejects path that is a file, not a directory', async () => {
    sandbox = await createSandbox('val-file');
    const f = path.join(sandbox.scratchRoot, 'a-file');
    await fs.writeFile(f, 'x');
    const result = await validateProjectPath(f);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_DIRECTORY');
  });

  it('rejects path without package.json', async () => {
    sandbox = await createSandbox('val-no-pkg');
    const dir = await sandbox.scratch('proj');
    const result = await validateProjectPath(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NO_PACKAGE_JSON');
  });

  it('rejects path without lockfile', async () => {
    sandbox = await createSandbox('val-no-lock');
    const dir = await sandbox.scratch('proj');
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    const result = await validateProjectPath(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NO_LOCKFILE');
  });

  it('rejects the agent\'s own directory', async () => {
    sandbox = await createSandbox('val-self');
    const result = await validateProjectPath(process.cwd());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INSIDE_AGENT');
  });

  it('rejects duplicate registration', async () => {
    sandbox = await createSandbox('val-dup');
    const dir = await sandbox.scratch('proj');
    await createSmallNpmProject(dir);
    // Register the path via storage directly.
    await addProject({
      slug: 'abcd1234',
      name: 'x',
      absolutePath: path.resolve(dir),
      packageManager: 'npm',
      addedAt: new Date().toISOString(),
      workspacesDetected: false
    });
    const result = await validateProjectPath(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('DUPLICATE');
  });

  it('accepts a valid npm project', async () => {
    sandbox = await createSandbox('val-ok');
    const dir = await sandbox.scratch('proj');
    await createSmallNpmProject(dir);
    const result = await validateProjectPath(dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.packageManager).toBe('npm');
      expect(result.workspacesDetected).toBe(false);
    }
  });

  it('flags workspaces detection on valid input', async () => {
    sandbox = await createSandbox('val-ws');
    const dir = await sandbox.scratch('proj');
    await createSmallNpmProject(dir, { workspaces: true });
    const result = await validateProjectPath(dir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.workspacesDetected).toBe(true);
  });
});
