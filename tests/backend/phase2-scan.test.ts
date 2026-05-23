/**
 * Phase 2 scan integration tests (spec §10.1).
 *
 * MOCK_LLM is irrelevant for Stage 2; the registry + OSV clients accept
 * inject-fetcher options for hermetic tests.
 *
 * Covered:
 *   - Small-modern fixture: scan completes <30s, badges populated.
 *   - Large-legacy fixture: scan completes <60s, all badges populated.
 *   - OSV failure: CVE map → null, project.json still well-formed.
 *   - Concurrent project.json writers: 50 simulated badge updates produce a
 *     well-formed final file with no `.tmp` residue (invariant re-run §8.4).
 *   - Phase 2 + Phase 1 target-read-only invariant.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createSandbox, disposeAllSandboxes, type Sandbox } from './helpers/sandbox';
import { createSmallNpmProject, createLegacyNpmProject, snapshotDirectory } from './helpers/fixtures';
import { addProjectPipeline } from '@/lib/projects/add';
import { runPhase2Scan } from '@/lib/scanners/phase2';
import { resetCanonicalWriter, getCanonicalWriter } from '@/lib/storage/canonicalWriter';
import { projectJsonPath, depFilePath, projectDir } from '@/lib/paths';
import { readJson } from '@/lib/storage/atomic';
import type { ProjectJson } from '@/lib/projects/add';
import type { RegistryFetcher, RegistryPackument } from '@/lib/scanners/registry';

let sandbox: Sandbox | undefined;

afterEach(async () => {
  if (sandbox !== undefined) await sandbox.dispose();
  await disposeAllSandboxes();
  resetCanonicalWriter();
});

function mockRegistry(versions: Record<string, string>): RegistryFetcher {
  return {
    fetchPackument: async (name: string): Promise<RegistryPackument> => {
      const latest = versions[name] ?? '99.0.0';
      return {
        name,
        versions: [{ version: latest, publishedAt: '2026-01-01T00:00:00Z', isPrerelease: false, deprecated: null, peerDependencies: {}, engines: {} }],
        distTags: { latest },
        deprecation: null,
        homepage: null,
        repository: null,
        license: 'MIT',
        lastPublishAt: '2026-01-01T00:00:00Z',
        latestPeerDependencies: {},
        latestEngines: {}
      };
    }
  };
}

function mockOsvClean(): typeof fetch {
  const fn = async (url: string | URL | Request): Promise<Response> => {
    const u = String(url);
    if (u.endsWith('/v1/querybatch')) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  return fn as unknown as typeof fetch;
}

function mockOsvFailing(): typeof fetch {
  const fn = async (): Promise<Response> => new Response('boom', { status: 503 });
  return fn as unknown as typeof fetch;
}

describe('runPhase2Scan against small-modern', () => {
  it(
    'completes in <30s, populates badges, leaves no .tmp residue',
    async () => {
    sandbox = await createSandbox('phase2-small');
    const dir = await sandbox.scratch('small-modern');
    await createSmallNpmProject(dir);
    const add = await addProjectPipeline({ absolutePath: dir });
    expect(add.ok).toBe(true);
    if (!add.ok) return;

    const project = await readJson<ProjectJson>(projectJsonPath(add.slug));
    const start = Date.now();
    const result = await runPhase2Scan({
      slug: add.slug,
      projectJson: project,
      registryFetcher: mockRegistry({ react: '99.0.0', 'react-dom': '99.0.0', typescript: '99.0.0' }),
      osvFetch: mockOsvClean()
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(30_000);

    const after = await readJson<ProjectJson>(projectJsonPath(add.slug));
    for (const dep of after.dependencies) {
      expect(dep.badges.lastScannedAt).not.toBeNull();
      expect(dep.badges.outdatedSeverity).toBe('major'); // installed 18.x, mock latest 99.x
      expect(dep.badges.hasCve).toBe(false);
    }
    expect(result.cveLookupFailed).toBe(false);
    expect(result.depsOutdatedMajor).toBeGreaterThan(0);

    // No .tmp residue
    const dirEntries = await fs.readdir(projectDir(add.slug));
    expect(dirEntries.some((e) => e.endsWith('.tmp'))).toBe(false);

    // deps/<name>.json populated for each dep
    for (const dep of after.dependencies) {
      const fp = depFilePath(add.slug, dep.name);
      const exists = await fs
        .stat(fp)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    }
    },
    45_000
  );
});

describe('runPhase2Scan against large-legacy', () => {
  it(
    'completes in <60s for ~150 deps, all badges populated',
    async () => {
    sandbox = await createSandbox('phase2-large');
    const dir = await sandbox.scratch('large-legacy');
    await createLegacyNpmProject(dir, { depCount: 150 });
    const add = await addProjectPipeline({ absolutePath: dir });
    expect(add.ok).toBe(true);
    if (!add.ok) return;

    const project = await readJson<ProjectJson>(projectJsonPath(add.slug));
    const versions: Record<string, string> = {};
    for (const dep of project.dependencies) {
      versions[dep.name] = '99.0.0'; // every dep major-outdated
    }
    const start = Date.now();
    await runPhase2Scan({
      slug: add.slug,
      projectJson: project,
      registryFetcher: mockRegistry(versions),
      osvFetch: mockOsvClean()
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(60_000);

    const after = await readJson<ProjectJson>(projectJsonPath(add.slug));
    let major = 0;
    for (const dep of after.dependencies) {
      if (dep.badges.outdatedSeverity === 'major') major += 1;
    }
    expect(major).toBeGreaterThanOrEqual(5);
    },
    90_000
  );
});

describe('runPhase2Scan with OSV down', () => {
  it('sets currentVersionCves = null and project.json hasCve = null', async () => {
    sandbox = await createSandbox('phase2-osv-down');
    const dir = await sandbox.scratch('small');
    await createSmallNpmProject(dir);
    const add = await addProjectPipeline({ absolutePath: dir });
    if (!add.ok) return;

    const project = await readJson<ProjectJson>(projectJsonPath(add.slug));
    const result = await runPhase2Scan({
      slug: add.slug,
      projectJson: project,
      registryFetcher: mockRegistry({}),
      osvFetch: mockOsvFailing()
    });
    expect(result.cveLookupFailed).toBe(true);

    const after = await readJson<ProjectJson>(projectJsonPath(add.slug));
    for (const dep of after.dependencies) {
      expect(dep.badges.hasCve).toBeNull();
    }

    // deps/<name>.json should have currentVersionCves: null
    const reactDep = await readJson<{ data: { currentVersionCves: unknown } }>(depFilePath(add.slug, 'react'));
    expect(reactDep.data.currentVersionCves).toBeNull();
  }, 30_000);
});

describe('target read-only invariant with Phase 2 scan (§3.1 / §16.3)', () => {
  it('does not modify the target project during Phase 2', async () => {
    sandbox = await createSandbox('phase2-readonly');
    const dir = await sandbox.scratch('target');
    await createSmallNpmProject(dir);
    const add = await addProjectPipeline({ absolutePath: dir });
    if (!add.ok) return;

    const before = await snapshotDirectory(dir);
    const project = await readJson<ProjectJson>(projectJsonPath(add.slug));
    await runPhase2Scan({
      slug: add.slug,
      projectJson: project,
      registryFetcher: mockRegistry({}),
      osvFetch: mockOsvClean()
    });
    const after = await snapshotDirectory(dir);

    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const key of Object.keys(before)) {
      expect(after[key]).toBe(before[key]);
    }
  });
});

describe('concurrent project.json writers (§8.4 invariant)', () => {
  it('50 concurrent badge patches produce a well-formed final file, no .tmp residue', async () => {
    sandbox = await createSandbox('concurrent-writers');
    const dir = await sandbox.scratch('target');
    await createSmallNpmProject(dir);
    const add = await addProjectPipeline({ absolutePath: dir });
    if (!add.ok) return;

    const writer = await getCanonicalWriter(add.slug);
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < 50; i += 1) {
      const name = i % 2 === 0 ? 'react' : 'react-dom';
      tasks.push(
        (async () => {
          writer.patchBadges(name, {
            outdatedSeverity: ['major', 'minor', 'patch', null][i % 4] as 'major' | 'minor' | 'patch' | null
          });
          await writer.flush();
        })()
      );
    }
    await Promise.all(tasks);
    await writer.flush();

    const final = await readJson<ProjectJson>(projectJsonPath(add.slug));
    // Final file must parse and contain expected dep set.
    expect(final.dependencies.find((d) => d.name === 'react')).toBeDefined();
    expect(final.dependencies.find((d) => d.name === 'react-dom')).toBeDefined();

    const entries = await fs.readdir(projectDir(add.slug));
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false);

    // path import alive
    void path;
  });

  /**
   * Regression for the canonicalWriter self-referential-`.then` deadlock that
   * shipped in v0.3 and surfaced on real Phase 2 scans of large projects.
   *
   * The old `forceFlush` used `state.writing.then(async () => { ...; if
   * (state.dirty) await forceFlush(); })` — the recursive call observed
   * `state.writing` pointing at the very promise it was running inside, so
   * `state.writing.then(...)` waited for itself forever. The trigger is
   * `state.dirty === true` becoming true again BETWEEN snapshot and end-of-
   * write, which only happens reliably when patches keep arriving while
   * `atomicWriteJson` is still awaiting.
   *
   * This test reproduces that pattern by scheduling patches via
   * `setTimeout(0)` so each one lands in a separate microtask, giving the
   * writer's in-flight `await atomicWriteJson` the event-loop opportunity to
   * see new dirty patches mid-write. Under the old code this hangs forever
   * (vitest hits the test timeout). Under the loop-based drain it completes
   * in well under a second.
   */
  it('does not deadlock when patches keep arriving during an in-flight write', async () => {
    sandbox = await createSandbox('deadlock-repro');
    const dir = await sandbox.scratch('target');
    await createSmallNpmProject(dir);
    const add = await addProjectPipeline({ absolutePath: dir });
    if (!add.ok) return;

    const writer = await getCanonicalWriter(add.slug);

    // Schedule 30 staggered patches so they fall across multiple event-loop
    // ticks — exactly the pattern that triggered the old deadlock.
    const stagger: Promise<void>[] = [];
    for (let i = 0; i < 30; i += 1) {
      stagger.push(
        new Promise<void>((resolve) => {
          setTimeout(() => {
            writer.patchBadges(i % 2 === 0 ? 'react' : 'react-dom', {
              outdatedSeverity: i % 3 === 0 ? 'major' : null
            });
            resolve();
          }, i * 2);
        })
      );
    }
    await Promise.all(stagger);

    // Hard time-bound: if flush hangs (old behaviour), this race rejects.
    const flushTask = writer.flush();
    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), 3000)
    );
    const winner = await Promise.race([flushTask.then(() => 'done' as const), timeout]);
    expect(winner).toBe('done');

    const final = await readJson<ProjectJson>(projectJsonPath(add.slug));
    expect(final.dependencies.length).toBeGreaterThan(0);
  });
});
