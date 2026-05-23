import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createSandbox, disposeAllSandboxes, type Sandbox } from './helpers/sandbox';
import { createSmallNpmProject, createLegacyNpmProject, snapshotDirectory } from './helpers/fixtures';
import { addProjectPipeline } from '@/lib/projects/add';
import { readProjects } from '@/lib/storage/projects';
import { projectJsonPath, projectDir } from '@/lib/paths';
import { readJson } from '@/lib/storage/atomic';
import type { ProjectJson } from '@/lib/projects/add';

let sandbox: Sandbox | undefined;

afterEach(async () => {
  if (sandbox !== undefined) await sandbox.dispose();
  await disposeAllSandboxes();
});

describe('addProjectPipeline against small-modern fixture', () => {
  it('writes _projects.json with one entry and project.json with correct shape', async () => {
    sandbox = await createSandbox('add-small');
    const dir = await sandbox.scratch('small-modern');
    await createSmallNpmProject(dir, { includeVolta: true });

    const result = await addProjectPipeline({ absolutePath: dir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reg = await readProjects();
    expect(reg.projects.length).toBe(1);
    expect(reg.projects[0]?.absolutePath).toBe(path.resolve(dir));

    const pj = await readJson<ProjectJson>(projectJsonPath(result.slug));
    expect(pj.name).toBe('small-modern');
    expect(pj.packageManager).toBe('npm');
    expect(pj.dependencies.find((d) => d.name === 'react')).toMatchObject({
      section: 'dependencies',
      installedVersion: '18.3.1'
    });
    expect(pj.dependencies.find((d) => d.name === 'typescript')).toMatchObject({
      section: 'devDependencies',
      installedVersion: '5.5.3'
    });
    expect(pj.volta).toMatchObject({ node: '18.19.0', npm: '10.2.3' });
    expect(pj.workspacesDetected).toBe(false);
    // Badges are empty after Phase 1.
    for (const dep of pj.dependencies) {
      expect(dep.badges.outdatedSeverity).toBeNull();
      expect(dep.badges.hasCve).toBeNull();
    }
    expect(pj.lockfileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(pj.lockfileStateHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('leaves no .tmp files in library/<slug>/', async () => {
    sandbox = await createSandbox('add-small-clean');
    const dir = await sandbox.scratch('small');
    await createSmallNpmProject(dir);
    const result = await addProjectPipeline({ absolutePath: dir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const slugDir = projectDir(result.slug);
    const entries = await fs.readdir(slugDir);
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false);
  });
});

describe('addProjectPipeline against large-legacy fixture', () => {
  it('populates dependencies for ~150 deps', async () => {
    sandbox = await createSandbox('add-large');
    const dir = await sandbox.scratch('large-legacy');
    await createLegacyNpmProject(dir, { depCount: 150 });
    const result = await addProjectPipeline({ absolutePath: dir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pj = await readJson<ProjectJson>(projectJsonPath(result.slug));
    expect(pj.dependencies.length).toBe(150);
  });
});

describe('workspaces detection', () => {
  it('requires acknowledgement when package.json has workspaces field', async () => {
    sandbox = await createSandbox('add-ws-block');
    const dir = await sandbox.scratch('ws-proj');
    await createSmallNpmProject(dir, { workspaces: true });
    const result = await addProjectPipeline({ absolutePath: dir });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('WORKSPACES_NOT_ACKNOWLEDGED');
  });

  it('proceeds when acknowledgeWorkspaces is true (root-only scan)', async () => {
    sandbox = await createSandbox('add-ws-ack');
    const dir = await sandbox.scratch('ws-proj');
    await createSmallNpmProject(dir, { workspaces: true });
    const result = await addProjectPipeline({ absolutePath: dir, acknowledgeWorkspaces: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pj = await readJson<ProjectJson>(projectJsonPath(result.slug));
    expect(pj.workspacesDetected).toBe(true);
  });
});

describe('target read-only invariant (§3.1 / §16.3 — BLOCKER)', () => {
  it('does not modify the target directory during a Phase 1 scan', async () => {
    sandbox = await createSandbox('readonly-invariant');
    const dir = await sandbox.scratch('target');
    await createSmallNpmProject(dir);

    const before = await snapshotDirectory(dir);
    const result = await addProjectPipeline({ absolutePath: dir });
    expect(result.ok).toBe(true);
    const after = await snapshotDirectory(dir);

    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const key of Object.keys(before)) {
      expect(after[key]).toBe(before[key]);
    }
  });
});
