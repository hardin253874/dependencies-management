/**
 * V2_STAGE3_SPEC 3b-A.1: app-side graph service + reader cache.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { createSandbox, disposeAllSandboxes, type Sandbox } from './helpers/sandbox';
import { copyGraphFixture, writeProjectFile } from './helpers/graphFixture';
import { graphDbPath } from '@/lib/paths';
import { graphLockKey, refreshProjectGraph } from '@/lib/graph/graphService';
import { _openGraphReaderCount, closeGraphReaders, getGraphReader } from '@/lib/graph/readerCache';
import { withProjectLock, _activeProjectLockCount } from '@/lib/storage/projectLock';
import { GraphNotBuiltError } from '@/core/graph/store';
import { graphInfo } from '@/core/graph/query';
import { buildGraph } from '@/core/graph/build';
import type { JobProgress } from '@/lib/jobs/types';

let sandbox: Sandbox | undefined;
const SLUG = 'svc';

afterEach(async () => {
  closeGraphReaders(SLUG);
  if (sandbox !== undefined) await sandbox.dispose();
  sandbox = undefined;
  await disposeAllSandboxes();
});

async function fixture(): Promise<string> {
  sandbox = await createSandbox('graph-service');
  const { projectRoot } = await copyGraphFixture(sandbox, 'wrapper-module');
  return projectRoot;
}

describe('refreshProjectGraph', () => {
  it('does a full build first, then an incremental build with 0 changes', async () => {
    const projectRoot = await fixture();
    const first = await refreshProjectGraph({ slug: SLUG, projectRoot });
    expect(first.mode).toBe('full');
    expect(first.rebuildReason).toBe('new');
    const second = await refreshProjectGraph({ slug: SLUG, projectRoot });
    expect(second.mode).toBe('incremental');
    expect(second.filesChanged).toBe(0);
  });

  it('writes graph.db under library/<slug>/ and nothing under the project', async () => {
    const projectRoot = await fixture();
    await refreshProjectGraph({ slug: SLUG, projectRoot });
    const dbPath = graphDbPath(SLUG);
    expect(dbPath).toBe(path.join(sandbox!.libraryRoot, SLUG, 'graph.db'));
    expect(existsSync(dbPath)).toBe(true);
    const entries = await fs.readdir(projectRoot, { recursive: true });
    expect(entries.some((e) => String(e).endsWith('.db'))).toBe(false);
  });

  it('reports progress as phase "scan"', async () => {
    const projectRoot = await fixture();
    const reports: JobProgress[] = [];
    await refreshProjectGraph({ slug: SLUG, projectRoot, report: (p) => reports.push(p) });
    expect(reports.length).toBeGreaterThan(0);
    expect(reports.every((r) => r.phase === 'scan')).toBe(true);
    expect(reports.some((r) => r.label === 'graph: parsing')).toBe(true);
  });

  it('serializes two concurrent refreshes of the same project on the graph:<slug> lock', async () => {
    const projectRoot = await fixture();
    const [a, b] = await Promise.all([
      refreshProjectGraph({ slug: SLUG, projectRoot }),
      refreshProjectGraph({ slug: SLUG, projectRoot })
    ]);
    expect([a.mode, b.mode]).toEqual(['full', 'incremental']);
    expect(_activeProjectLockCount()).toBe(0);
  });

  it('waits for a holder of the graph:<slug> lock before building', async () => {
    const projectRoot = await fixture();
    const order: string[] = [];
    let release!: () => void;
    const held = withProjectLock(graphLockKey(SLUG), () => {
      order.push('holder');
      return new Promise<void>((resolve) => (release = resolve));
    });
    const build = refreshProjectGraph({ slug: SLUG, projectRoot }).then(() => order.push('build'));
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['holder']);
    release();
    await Promise.all([held, build]);
    expect(order).toEqual(['holder', 'build']);
  });

  // Stage 3c (3b QA m3): a reader cached while this refresh waited for the lock must be closed
  // before the build runs (a corrupt-DB delete would otherwise hit EBUSY on Windows).
  it('closes readers cached while waiting for the lock before building', async () => {
    const projectRoot = await fixture();
    await refreshProjectGraph({ slug: SLUG, projectRoot });
    let release!: () => void;
    const held = withProjectLock(graphLockKey(SLUG), () => new Promise<void>((resolve) => (release = resolve)));
    const openDuringBuild: number[] = [];
    const waiting = refreshProjectGraph({ slug: SLUG, projectRoot, report: () => openDuringBuild.push(_openGraphReaderCount()) });
    await new Promise((r) => setTimeout(r, 20));
    getGraphReader(SLUG); // another job reads the committed graph while the refresh waits
    expect(_openGraphReaderCount()).toBe(1);
    release();
    await Promise.all([held, waiting]);
    expect(openDuringBuild.length).toBeGreaterThan(0);
    expect(openDuringBuild.every((n) => n === 0)).toBe(true);
  });

  it('rethrows an abort and leaves no readable graph behind on a first build', async () => {
    const projectRoot = await fixture();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(refreshProjectGraph({ slug: SLUG, projectRoot, signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(() => getGraphReader(SLUG)).toThrow(GraphNotBuiltError);
  });

  it('logs and rethrows build errors (no silent swallow)', async () => {
    sandbox = await createSandbox('graph-service-missing');
    const missing = path.join(sandbox.scratchRoot, 'does-not-exist');
    await expect(refreshProjectGraph({ slug: SLUG, projectRoot: missing })).rejects.toThrow();
  });
});

describe('graph reader cache', () => {
  it('throws GraphNotBuiltError before any build', async () => {
    sandbox = await createSandbox('graph-reader-none');
    expect(() => getGraphReader(SLUG)).toThrow(GraphNotBuiltError);
  });

  it('treats an initialised DB without a completed build as not built (3a QA m1)', async () => {
    const projectRoot = await fixture();
    // An aborted build after the writer opened leaves tables but no meta.builtAt.
    const ctrl = new AbortController();
    const report = vi.fn((p: JobProgress) => {
      if (p.label === 'graph: parsing') ctrl.abort();
    });
    await expect(refreshProjectGraph({ slug: SLUG, projectRoot, report, signal: ctrl.signal })).rejects.toMatchObject({
      name: 'AbortError'
    });
    expect(existsSync(graphDbPath(SLUG))).toBe(true);
    expect(() => getGraphReader(SLUG)).toThrow(GraphNotBuiltError);
    expect(_openGraphReaderCount()).toBe(0);
  });

  it('returns the same handle until a rebuild, then reopens it', async () => {
    const projectRoot = await fixture();
    await refreshProjectGraph({ slug: SLUG, projectRoot });
    const h1 = getGraphReader(SLUG);
    expect(getGraphReader(SLUG)).toBe(h1);
    const builtAt1 = graphInfo(h1).meta.builtAt;

    await new Promise((r) => setTimeout(r, 5));
    await writeProjectFile(projectRoot, 'src/new.ts', `import axios from 'axios';\nexport const n = axios;\n`);
    await refreshProjectGraph({ slug: SLUG, projectRoot });
    const h2 = getGraphReader(SLUG);
    expect(h2 === h1).toBe(false);
    expect(graphInfo(h2).meta.builtAt).not.toBe(builtAt1);
  });

  it('notices a build committed outside the service (meta.builtAt changed) and reopens', async () => {
    const projectRoot = await fixture();
    await refreshProjectGraph({ slug: SLUG, projectRoot });
    const h1 = getGraphReader(SLUG);
    await new Promise((r) => setTimeout(r, 5));
    await buildGraph({ projectRoot, dbPath: graphDbPath(SLUG), mode: 'auto', lock: (_k, fn) => fn() });
    const h2 = getGraphReader(SLUG);
    expect(h2 === h1).toBe(false);
    expect(_openGraphReaderCount()).toBe(1);
  });

  it('closeGraphReaders releases the file so the DB can be deleted (Windows lock)', async () => {
    const projectRoot = await fixture();
    await refreshProjectGraph({ slug: SLUG, projectRoot });
    getGraphReader(SLUG);
    expect(_openGraphReaderCount()).toBe(1);
    closeGraphReaders(SLUG);
    expect(_openGraphReaderCount()).toBe(0);
    const dir = path.dirname(graphDbPath(SLUG));
    await fs.rm(dir, { recursive: true });
    expect(existsSync(dir)).toBe(false);
  });
});
