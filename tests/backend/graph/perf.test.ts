/**
 * Graph performance budgets (design §10, V2_STAGE3_SPEC 3a.10) on a seeded
 * synthetic repo. The 2,000-file budgets are gated behind GRAPH_PERF=1 so the
 * default suite stays fast:
 *
 *   $env:GRAPH_PERF='1'; npx vitest run tests/backend/graph/perf.test.ts
 *
 * The always-on smoke test (200 files) catches gross regressions.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createSandbox, type Sandbox } from '../helpers/sandbox';
import { generateSynthRepo, type SynthRepoInfo } from './helpers/synthRepo';
import { buildGraph } from '@/core/graph/build';
import { openGraphReader, type GraphDriver } from '@/core/graph/store';
import { filesUsingPackage, unresolved } from '@/core/graph/query';

const lock = <T>(_key: string, fn: () => Promise<T>): Promise<T> => fn();

function report(label: string, value: number | string): void {
  process.stderr.write(`[graph-perf] ${label}: ${typeof value === 'number' ? value.toFixed(1) : value}\n`);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

describe('graph perf smoke (always on, 200 files)', () => {
  let sandbox: Sandbox;
  beforeAll(async () => {
    sandbox = await createSandbox('graph-perf-smoke');
  });
  afterAll(async () => {
    await sandbox.dispose();
  });

  it('full build of a 200-file synthetic repo finishes in < 5 s', async () => {
    const root = await sandbox.scratch('synth200');
    const info = await generateSynthRepo({ root, files: 200 });
    const dbPath = path.join(sandbox.libraryRoot, 'synth200', 'graph.db');
    const res = await buildGraph({ projectRoot: root, dbPath, mode: 'full', lock });
    expect(res.files).toBeGreaterThanOrEqual(200);
    expect(res.durationMs).toBeLessThan(5000);
    const r = openGraphReader(dbPath);
    try {
      expect(filesUsingPackage(r, 'axios').length).toBeGreaterThan(0);
      expect(unresolved(r).summary.unresolved).toBe(0);
    } finally {
      r.close();
    }
    expect(info.files.length).toBeGreaterThan(150);
  }, 30_000);
});

describe.runIf(process.env.GRAPH_PERF === '1')('graph perf budgets (GRAPH_PERF=1, 2,000 files)', () => {
  let sandbox: Sandbox;
  let root: string;
  let dbPath: string;
  let info: SynthRepoInfo;

  beforeAll(async () => {
    sandbox = await createSandbox('graph-perf');
    root = await sandbox.scratch('synth2000');
    const t0 = performance.now();
    info = await generateSynthRepo({ root, files: 2000 });
    report('generate synthetic repo ms', performance.now() - t0);
    dbPath = path.join(sandbox.libraryRoot, 'synth2000', 'graph.db');
  }, 120_000);

  afterAll(async () => {
    await sandbox.dispose();
  });

  it('full build < 30 s', async () => {
    const res = await buildGraph({ projectRoot: root, dbPath, mode: 'full', lock });
    report('files', res.files);
    report('edges', res.edges);
    report('unresolved edges', res.unresolved);
    report('full build ms', res.durationMs);
    const st = await fs.stat(dbPath);
    report('graph.db bytes', st.size);
    expect(res.files).toBeGreaterThanOrEqual(2000);
    expect(res.durationMs).toBeLessThan(30_000);
  }, 120_000);

  it('no-change rescan < 3 s', async () => {
    const res = await buildGraph({ projectRoot: root, dbPath, mode: 'auto', lock });
    report('no-change rescan ms', res.durationMs);
    expect(res.mode).toBe('incremental');
    expect(res.filesChanged).toBe(0);
    expect(res.durationMs).toBeLessThan(3000);
  }, 60_000);

  it('one-file-edit rescan < 3 s', async () => {
    const file = path.join(root, ...info.editable.split('/'));
    const src = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, `${src}\nexport const edited = 1;\n`);
    const t = new Date(Date.now() + 10_000);
    await fs.utimes(file, t, t);
    const res = await buildGraph({ projectRoot: root, dbPath, mode: 'auto', lock });
    report('one-file-edit rescan ms', res.durationMs);
    expect(res.mode).toBe('incremental');
    expect(res.filesChanged).toBe(1);
    expect(res.durationMs).toBeLessThan(3000);
  }, 60_000);

  it('filesUsingPackage (transitive) median of 20 < 50 ms on an open reader', () => {
    const t0 = performance.now();
    const r: GraphDriver = openGraphReader(dbPath);
    report('open reader ms', performance.now() - t0);
    try {
      const times: number[] = [];
      let hits = 0;
      for (let i = 0; i < 20; i += 1) {
        const t = performance.now();
        hits = filesUsingPackage(r, i % 2 === 0 ? 'axios' : 'clsx', { transitive: true }).length;
        times.push(performance.now() - t);
      }
      report('filesUsingPackage median ms', median(times));
      report('filesUsingPackage max ms', Math.max(...times));
      report('filesUsingPackage last hit count', hits);
      expect(median(times)).toBeLessThan(50);
    } finally {
      r.close();
    }
  });
});
