/**
 * Results writer + `run` orchestration (v2 Stage 0.7). Fake predictor and
 * fake truth — no git. The private case uses the fake id `private-fixture`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { createSandbox, disposeAllSandboxes, type Sandbox } from '../helpers/sandbox';
import { LabelCollisionError, localDate, runEval, type RunDeps } from '../../../eval/lib/results';
import type { CasePrediction, LoadedCase, ResultFile, TruthSet } from '../../../eval/lib/types';

const NOW = new Date(2026, 10, 9, 12, 0, 0);
const PRIVATE_REPO = 'C:\\secret\\private-fixture-repo';
const PRIVATE_PATH = 'src/secret-module/internal.tsx';

function loaded(id: string, visibility: 'public' | 'private', extra: Partial<LoadedCase> = {}): LoadedCase {
  return {
    id,
    repo: visibility === 'private' ? PRIVATE_REPO : `https://github.com/example/${id}`,
    baseCommit: 'a'.repeat(40),
    projectDirs: ['.'],
    phases: [{ id: 'main', toCommit: 'b'.repeat(40), packages: [{ name: 'react', from: '17.0.2', to: '18.2.0' }] }],
    tags: visibility === 'private' ? ['private-only-tag'] : ['react-major'],
    visibility,
    sourceFile: 'x.json',
    ...extra
  };
}

function truthFor(c: LoadedCase): TruthSet {
  const p = c.visibility === 'private' ? PRIVATE_PATH : 'src/app.tsx';
  return { kept: [{ path: p, kind: 'source', status: 'M' }], dropped: [], addedCount: 0, outOfScope: [] };
}

function deps(overrides: Partial<RunDeps> = {}): RunDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    prepare: async (c) => `/cache/${c.id}`,
    truth: async (c) => [{ phaseId: 'main', truth: truthFor(c) }],
    predict: async (c): Promise<CasePrediction> => ({
      filesScanned: 3,
      durationMs: 5,
      byPhase: new Map([['main', [truthFor(c).kept[0]?.path ?? '']]])
    }),
    log: (l) => lines.push(l),
    ...overrides
  };
}

let sandbox: Sandbox | undefined;
afterEach(async () => {
  if (sandbox !== undefined) await sandbox.dispose();
  sandbox = undefined;
  await disposeAllSandboxes();
});

async function resultsDir(): Promise<string> {
  sandbox = await createSandbox('eval-results');
  return sandbox.scratch('results');
}

const base = {
  label: 'unit-run',
  predictor: 'v1-code-scan' as const,
  tool: { commit: 'deadbeef', dirty: true },
  now: NOW
};

describe('runEval', () => {
  it('splits public and private cases into separate files', async () => {
    const dir = await resultsDir();
    const outcome = await runEval({
      ...base,
      resultsDir: dir,
      cases: [loaded('demo-public', 'public'), loaded('private-fixture', 'private')],
      deps: deps()
    });
    expect(outcome.exitCode).toBe(0);
    const pubPath = path.join(dir, `${localDate(NOW)}-unit-run.json`);
    const privPath = path.join(dir, 'private', `${localDate(NOW)}-unit-run.json`);
    expect(outcome.written).toEqual([pubPath, privPath]);

    const pubText = await fs.readFile(pubPath, 'utf8');
    for (const secret of ['private-fixture', 'private-only-tag', 'secret-module', 'secret\\\\private', 'private-fixture-repo']) {
      expect(pubText).not.toContain(secret);
    }
    const pub = JSON.parse(pubText) as ResultFile;
    expect(pub.visibility).toBe('public');
    expect(pub.cases.map((c) => c.id)).toEqual(['demo-public']);
    expect(Object.keys(pub.aggregate.byTag)).toEqual(['react-major']);

    const priv = JSON.parse(await fs.readFile(privPath, 'utf8')) as ResultFile;
    expect(priv.visibility).toBe('private');
    expect(priv.cases.map((c) => c.id)).toEqual(['private-fixture']);
    expect(priv.aggregate.micro.recall).toBe(1);
  });

  it('refuses to overwrite an existing label', async () => {
    const dir = await resultsDir();
    const opts = { ...base, resultsDir: dir, cases: [loaded('demo-public', 'public')], deps: deps() };
    await runEval(opts);
    await expect(runEval(opts)).rejects.toBeInstanceOf(LabelCollisionError);
  });

  it('records a failing case as error, keeps going and exits 2', async () => {
    const dir = await resultsDir();
    const outcome = await runEval({
      ...base,
      resultsDir: dir,
      cases: [loaded('bad-case', 'public'), loaded('good-case', 'public')],
      deps: deps({
        prepare: async (c) => {
          if (c.id === 'bad-case') throw new Error('commit 1234 not found');
          return '/cache/x';
        }
      })
    });
    expect(outcome.exitCode).toBe(2);
    const file = JSON.parse(await fs.readFile(outcome.written[0] as string, 'utf8')) as ResultFile;
    expect(file.cases.map((c) => [c.id, c.status])).toEqual([
      ['bad-case', 'error'],
      ['good-case', 'ok']
    ]);
    expect(file.cases[0]?.error).toContain('1234');
    expect(file.aggregate.errors).toBe(1);
  });

  it('writes a findings sheet next to the private results for golden findings', async () => {
    const dir = await resultsDir();
    const c = loaded('private-fixture', 'private', {
      goldenFindings: [{ id: 'G01', phase: 'main', title: 't', category: 'c', expected: 'yes', verified: false }]
    });
    const outcome = await runEval({ ...base, resultsDir: dir, cases: [c], deps: deps() });
    const sheet = outcome.written.find((w) => w.endsWith('.findings.md'));
    expect(sheet).toBe(path.join(dir, 'private', `${localDate(NOW)}-unit-run.findings.md`));
  });
});
