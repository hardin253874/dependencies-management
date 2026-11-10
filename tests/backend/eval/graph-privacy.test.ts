/**
 * Privacy routing for `eval -- graph` (V2_STAGE3_SPEC 3b-B.3), mirroring
 * results.test.ts: a private case never appears (id, paths, samples,
 * specifiers) in the public file, and its own file carries numbers only.
 * The private case uses the fake id `private-fixture`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { createSandbox, disposeAllSandboxes, type Sandbox } from '../helpers/sandbox';
import { graphResultPath, runGraphEval, type GraphRunDeps } from '../../../eval/lib/graph-score';
import { TRUTH_LIMITATIONS, TRUTH_VERSION, type CaseTruthFile } from '../../../eval/lib/graph-truth';
import type { ProjectDirGraph } from '../../../eval/lib/predict-graph';
import { LabelCollisionError, localDate } from '../../../eval/lib/results';
import type { GraphResultFile, LoadedCase } from '../../../eval/lib/types';

const NOW = new Date(2026, 10, 10, 12, 0, 0);
const PRIVATE_ID = 'private-fixture';
const PRIVATE_PATH = 'src/secret-module/internal.tsx';
const PRIVATE_SPEC = '@/secret-generated/api';
const PRIVATE_PKG = '@secret-scope/internal-sdk';

let sandbox: Sandbox | undefined;
afterEach(async () => {
  if (sandbox !== undefined) await sandbox.dispose();
  sandbox = undefined;
  await disposeAllSandboxes();
});

function loaded(id: string, visibility: 'public' | 'private'): LoadedCase {
  return {
    id,
    repo: visibility === 'private' ? 'C:\\secret\\private-fixture-repo' : `https://github.com/example/${id}`,
    baseCommit: 'a'.repeat(40),
    projectDirs: ['.'],
    phases: [{ id: 'main', toCommit: 'b'.repeat(40), packages: [{ name: 'react', from: '17.0.2', to: '18.2.0' }] }],
    tags: visibility === 'private' ? ['private-only-tag'] : ['react-major'],
    visibility,
    sourceFile: 'x.json'
  };
}

function deps(): GraphRunDeps & { lines: string[] } {
  const lines: string[] = [];
  const fileFor = (c: LoadedCase) => (c.visibility === 'private' ? PRIVATE_PATH : 'src/app.tsx');
  const pkgFor = (c: LoadedCase) => (c.visibility === 'private' ? PRIVATE_PKG : 'react');
  return {
    lines,
    prepare: async (c) => `/cache/${c.id}`,
    declared: async (dir) => [dir.includes(PRIVATE_ID) ? PRIVATE_PKG : 'react'],
    truth: async (c): Promise<{ truth: CaseTruthFile; cached: boolean }> => ({
      cached: false,
      truth: {
        truthVersion: TRUTH_VERSION,
        caseId: c.id,
        baseCommit: c.baseCommit,
        tsVersion: 'x',
        generatedAt: '',
        limitations: TRUTH_LIMITATIONS,
        projectDirs: [
          {
            projectDir: '.',
            files: 2,
            specifiers: 2,
            unresolvedRelative: 0,
            bareByName: 1,
            reexportTruth: 'ok',
            timing: { directMs: 1, reexportMs: 1 },
            packages: { [pkgFor(c)]: { direct: [fileFor(c), `${fileFor(c)}.truth-only.ts`], reexport: [] } }
          }
        ]
      }
    }),
    graph: async (c, _dir, packagesFor): Promise<ProjectDirGraph[]> => [
      {
        projectDir: '.',
        files: 2,
        buildMs: 5,
        unresolved: { totalEdges: 4, unresolved: 1, pct: 0.25, byReason: { 'not-found': 1 } },
        topUnresolved: [{ reason: 'not-found', specifier: c.visibility === 'private' ? PRIVATE_SPEC : './gen', count: 1 }],
        packages: Object.fromEntries(
          packagesFor('.').map((p) => [
            p,
            { direct: [fileFor(c), `${fileFor(c)}.graph-only.ts`], reexport: [], wrapper: [], aliasOnly: [], configRefOnly: [], nonJs: [], isWorkspace: false }
          ])
        )
      }
    ],
    log: (l) => lines.push(l)
  };
}

describe('runGraphEval privacy routing', () => {
  it('writes public and private files separately; the public one never names the private case', async () => {
    sandbox = await createSandbox('graph-privacy');
    const resultsDir = await sandbox.scratch('results');
    const outcome = await runGraphEval({
      cases: [loaded('public-case', 'public'), loaded(PRIVATE_ID, 'private')],
      label: 'priv-test',
      packages: 'declared',
      tool: { commit: 'abc', dirty: false },
      resultsDir,
      now: NOW,
      deps: deps()
    });
    expect(outcome.exitCode).toBe(0);
    const date = localDate(NOW);
    const pubPath = graphResultPath(resultsDir, 'public', date, 'priv-test');
    const privPath = graphResultPath(resultsDir, 'private', date, 'priv-test');
    expect(outcome.written).toEqual([pubPath, privPath]);
    expect(path.basename(pubPath)).toBe(`${date}-priv-test-graph.json`);
    expect(path.dirname(privPath)).toBe(path.join(resultsDir, 'private'));

    const pubText = await fs.readFile(pubPath, 'utf8');
    for (const secret of [PRIVATE_ID, PRIVATE_PATH, PRIVATE_SPEC, PRIVATE_PKG, 'private-only-tag', 'secret']) {
      expect(pubText).not.toContain(secret);
    }
    const pub = JSON.parse(pubText) as GraphResultFile;
    expect(pub).toMatchObject({ kind: 'graph-usage', visibility: 'public', packages: 'declared' });
    expect(pub.cases.map((c) => c.id)).toEqual(['public-case']);
    expect(pub.cases[0]!.graphOnlySample).toEqual([{ pkg: 'react', path: 'src/app.tsx.graph-only.ts' }]);
    expect(pub.cases[0]!.topUnresolved).toEqual([{ projectDir: '.', reason: 'not-found', specifier: './gen', count: 1 }]);

    const priv = JSON.parse(await fs.readFile(privPath, 'utf8')) as GraphResultFile;
    expect(priv.visibility).toBe('private');
    expect(priv.cases.map((c) => c.id)).toEqual([PRIVATE_ID]);
    const pc = priv.cases[0]!;
    expect(pc.graphOnlySample).toBeUndefined();
    expect(pc.truthOnlySample).toBeUndefined();
    expect(pc.topUnresolved).toBeUndefined();
    const privText = JSON.stringify(priv);
    expect(privText).not.toContain(PRIVATE_PATH);
    expect(privText).not.toContain(PRIVATE_SPEC);
    expect(pc.micro).toEqual({ truth: 2, predicted: 2, tp: 1, precision: 0.5, recall: 0.5 });
  });

  it('only public cases → no private file; label collision refuses before running', async () => {
    sandbox = await createSandbox('graph-privacy-2');
    const resultsDir = await sandbox.scratch('results');
    const opts = {
      cases: [loaded('public-case', 'public')],
      label: 'once',
      packages: 'phase' as const,
      tool: { commit: 'abc', dirty: false },
      resultsDir,
      now: NOW,
      deps: deps()
    };
    const first = await runGraphEval(opts);
    expect(first.written).toHaveLength(1);
    await expect(fs.readdir(path.join(resultsDir, 'private'))).rejects.toThrow();
    await expect(runGraphEval(opts)).rejects.toBeInstanceOf(LabelCollisionError);
  });

  it('a failing case is recorded as an error with exit code 2', async () => {
    sandbox = await createSandbox('graph-privacy-3');
    const resultsDir = await sandbox.scratch('results');
    const d = deps();
    d.graph = async () => {
      throw new Error('graph exploded');
    };
    const outcome = await runGraphEval({
      cases: [loaded('public-case', 'public')],
      label: 'err',
      packages: 'phase',
      tool: { commit: 'abc', dirty: false },
      resultsDir,
      now: NOW,
      deps: d
    });
    expect(outcome.exitCode).toBe(2);
    expect(outcome.results[0]!.cases[0]).toMatchObject({ status: 'error', error: 'graph exploded' });
    expect(outcome.results[0]!.aggregate.errors).toBe(1);
  });
});
