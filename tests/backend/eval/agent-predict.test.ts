/**
 * `run --predictor v2-agent` (V2_STAGE4_SPEC 4a.14): scripted runs over
 * sandbox fixture copies that act as clones in an injected eval cache. No
 * network, no API, nothing written into the clone.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs, existsSync, readFileSync, readdirSync, statSync } from 'fs';
import crypto from 'crypto';
import path from 'path';
import { createSandbox, type Sandbox } from '../helpers/sandbox';
import { copyGraphFixture } from '../helpers/graphFixture';
import { EVAL_AGENT_BUDGETS, predictV2Agent, runRecordPath, scriptedModelFactory, type AgentPredictOptions } from '../../../eval/lib/predict-agent';
import { runEval } from '../../../eval/lib/results';
import { ScriptedAgentModel, type ScriptedTurn } from '@/core/agent/model';
import { costEstimateUsd } from '@/lib/llm/cost';
import type { CorpusCase, LoadedCase, ResultFile } from '../../../eval/lib/types';

let sandbox: Sandbox;
let cacheDir: string;

async function clone(caseId: string, subs: string[] = ['.']): Promise<string> {
  const { projectRoot } = await copyGraphFixture(sandbox, 'wrapper-module', `${caseId}-src`);
  const cloneDir = path.join(cacheDir, caseId);
  for (const sub of subs) await fs.cp(projectRoot, path.join(cloneDir, sub), { recursive: true });
  return cloneDir;
}

function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(`${path.relative(root, full)}:${statSync(full).mtimeMs}:${crypto.createHash('sha256').update(readFileSync(full)).digest('hex')}`);
    }
  };
  walk(root);
  return out.sort();
}

const explore: ScriptedTurn = { content: [{ type: 'tool_use', name: 'usage_sites', input: { pkg: 'axios' } }], usage: { inputTokens: 4000, outputTokens: 150 } };
function submit(paths: string[], excludeFiles: Array<{ path: string; evidence: string }> = []): ScriptedTurn {
  return {
    content: [
      {
        type: 'tool_use',
        name: 'submit_update_report',
        input: {
          summary: 's',
          riskLevel: 'medium',
          breakingChanges: [],
          coUpgradeDeps: [],
          filesToModify: paths.map((p) => ({ path: p, brief: 'b', estimatedChangeSize: 'small' })),
          recommendations: [],
          excludeFiles
        }
      }
    ],
    usage: { inputTokens: 500, outputTokens: 800, cacheReadInputTokens: 4000 }
  };
}
/** wrapper-module base set for axios (impactBaseSet): 1 direct + 3 wrapper users. */
const WM_BASE = ['src/components/Avatar.tsx', 'src/features/posts.ts', 'src/features/users.ts', 'src/lib/http.ts'];
const readPosts: ScriptedTurn = { content: [{ type: 'tool_use', name: 'read_file', input: { path: 'src/features/posts.ts' } }] };
const excludeScript = (): ScriptedAgentModel =>
  new ScriptedAgentModel([
    readPosts,
    submit(['src/lib/http.ts', 'src/features/__tests__/users.test.ts'], [
      { path: 'src/features/posts.ts', evidence: 'type-only use' },
      { path: 'src/components/Avatar.tsx', evidence: 'never read' }
    ])
  ]);
const prose: ScriptedTurn = { content: [{ type: 'text', text: 'done thinking' }], usage: { inputTokens: 100, outputTokens: 20 } };

const CASE: Pick<CorpusCase, 'id' | 'projectDirs' | 'phases'> = {
  id: 'wm-case',
  projectDirs: ['.'],
  phases: [
    { id: 'upgrade', toCommit: 'b'.repeat(40), packages: [{ name: 'axios', from: '0.27.2', to: '1.6.8' }] },
    { id: 'drop', toCommit: 'c'.repeat(40), packages: [{ name: 'axios', from: '1.6.8', to: null }, { name: 'ky', from: null, to: '1.2.0' }] }
  ]
};

function opts(models: Record<string, ScriptedAgentModel>, over: Partial<AgentPredictOptions> = {}): AgentPredictOptions {
  return {
    cacheDir,
    label: 'agent-test',
    modelFor: (caseId, phaseId, dir) => {
      const m = models[`${phaseId}:${dir}`] ?? models[phaseId];
      if (m === undefined) throw new Error(`no model for ${caseId}/${phaseId}/${dir}`);
      return m;
    },
    modelId: 'claude-sonnet-5-5',
    effort: 'medium',
    budgets: { ...EVAL_AGENT_BUDGETS.update },
    playbooks: 'off',
    ...over
  };
}

beforeAll(async () => {
  sandbox = await createSandbox('agent-predict');
  cacheDir = await sandbox.scratch('eval-cache');
});

afterAll(async () => {
  await sandbox.dispose();
});

describe('predictV2Agent (4a.14)', () => {
  it('predicted sets, hallucinated paths, cost sum and per-phase agent fields', async () => {
    const cloneDir = await clone(CASE.id);
    const before = snapshot(cloneDir);
    const up = new ScriptedAgentModel([explore, submit(['src/lib/http.ts', 'src/features/users.ts', 'src/made/up.ts'])]);
    const drop = new ScriptedAgentModel([prose, prose]);
    const pred = await predictV2Agent(CASE, cloneDir, opts({ upgrade: up, drop }));

    // 5a.7: full set = base ∪ added − valid excluded; the agent's pick is the subset
    expect(pred.byPhase.get('upgrade')).toEqual(WM_BASE);
    expect(pred.subsetByPhase!.get('upgrade')).toEqual(['src/features/users.ts', 'src/lib/http.ts']);
    // a run that does not submit predicts the base set (same as the app's partial envelope)
    expect(pred.byPhase.get('drop')).toEqual(WM_BASE);
    expect(pred.subsetByPhase!.get('drop')).toEqual([]);
    expect(pred.agentByPhase!.get('upgrade')!.impact).toEqual({ base: 4, confirmed: 2, added: 0, excluded: 0, rejectedExclusions: 0, excludedTruePositives: 0 });
    expect(pred.agentByPhase!.get('drop')!.impact).toEqual({ base: 4, confirmed: 0, added: 0, excluded: 0, rejectedExclusions: 0, excludedTruePositives: 0 });
    const a = pred.agentByPhase!.get('upgrade')!;
    expect(a).toMatchObject({ status: 'submitted', runs: 1, toolCalls: 1, hallucinatedPaths: 1, inputTokens: 4500, outputTokens: 950, cacheReadTokens: 4000 });
    expect(pred.agentByPhase!.get('drop')).toMatchObject({ status: 'no-submit', runs: 1, toolCalls: 0 });
    const expected =
      costEstimateUsd('claude-sonnet-5-5', { inputTokens: 4000, outputTokens: 150 }) +
      costEstimateUsd('claude-sonnet-5-5', { inputTokens: 500, outputTokens: 800, cacheReadInputTokens: 4000 }) +
      2 * costEstimateUsd('claude-sonnet-5-5', { inputTokens: 100, outputTokens: 20 });
    expect(pred.costUsd).toBeCloseTo(expected, 6);

    // the removal + addition are stated in the seed
    const seed = (drop.requests[0]!.messages[0]!.content as Array<{ text: string }>)[0]!.text;
    expect(seed).toContain('axios 1.6.8 → REMOVED');
    expect(seed).toContain('ky → ADDED at 1.2.0');

    // run records in the cache, never in the clone
    expect(existsSync(runRecordPath(cacheDir, 'agent-test', CASE.id, 'upgrade', '.', false))).toBe(true);
    expect(existsSync(runRecordPath(cacheDir, 'agent-test', CASE.id, 'drop', '.', false))).toBe(true);
    expect(snapshot(cloneDir)).toEqual(before);
  }, 60_000);

  it('two projectDirs → one run each, paths prefixed, costs summed', async () => {
    const twoDirs = { ...CASE, id: 'wm-two', projectDirs: ['apps/a', 'apps/b'], phases: [CASE.phases[0]!] };
    const cloneDir = await clone(twoDirs.id, ['apps/a', 'apps/b']);
    const pred = await predictV2Agent(
      twoDirs,
      cloneDir,
      opts({
        'upgrade:apps/a': new ScriptedAgentModel([submit(['src/lib/http.ts'])]),
        'upgrade:apps/b': new ScriptedAgentModel([submit(['src/components/Avatar.tsx'])])
      })
    );
    expect(pred.byPhase.get('upgrade')).toEqual([...WM_BASE.map((p) => `apps/a/${p}`), ...WM_BASE.map((p) => `apps/b/${p}`)]);
    expect(pred.subsetByPhase!.get('upgrade')).toEqual(['apps/a/src/lib/http.ts', 'apps/b/src/components/Avatar.tsx']);
    expect(pred.agentByPhase!.get('upgrade')!.impact).toMatchObject({ base: 8, confirmed: 2 });
    expect(pred.agentByPhase!.get('upgrade')!.runs).toBe(2);
    expect(existsSync(runRecordPath(cacheDir, 'agent-test', twoDirs.id, 'upgrade', 'apps/a', true))).toBe(true);
  }, 60_000);

  it('scriptedModelFactory: one script for every run, or a per-phase map with "*"', () => {
    const one = scriptedModelFactory({ turns: [submit([])] });
    expect(one('a', 'b', '.')).not.toBe(one('a', 'b', '.'));
    const map = scriptedModelFactory({ 'c1/p1': [submit([])], '*': [prose] });
    expect(map('c1', 'p1', '.')).toBeInstanceOf(ScriptedAgentModel);
    expect(map('zz', 'p9', '.')).toBeInstanceOf(ScriptedAgentModel);
    expect(() => scriptedModelFactory({ 'c1/p1': [] })('x', 'y', '.')).toThrow(/no turns/);
  });
});

describe('v2-agent privacy routing (4a.14, mirrors graph-privacy.test.ts)', () => {
  it('a private case never appears in the public result file', async () => {
    const PRIVATE_ID = 'private-fixture';
    const PRIVATE_PATH = 'src/lib/http.ts';
    const pubClone = await clone('pub-case');
    const privClone = await clone(PRIVATE_ID);
    const mk = (id: string, visibility: 'public' | 'private'): LoadedCase => ({
      id,
      repo: `https://example.invalid/${id}`,
      baseCommit: 'a'.repeat(40),
      projectDirs: ['.'],
      phases: [CASE.phases[0]!],
      tags: [visibility === 'private' ? 'private-only-tag' : 'public-tag'],
      visibility,
      sourceFile: 'x.json'
    });
    const resultsDir = await sandbox.scratch('results');
    const outcome = await runEval({
      cases: [mk('pub-case', 'public'), mk(PRIVATE_ID, 'private')],
      label: 'agent-privacy',
      predictor: 'v2-agent',
      tool: { commit: 'x', dirty: false },
      resultsDir,
      now: new Date(2026, 10, 10, 12, 0, 0),
      deps: {
        prepare: async (c) => (c.id === PRIVATE_ID ? privClone : pubClone),
        truth: async () => [{ phaseId: 'upgrade', truth: { kept: [{ path: 'src/features/users.ts', kind: 'source', status: 'M' }], dropped: [], addedCount: 0, outOfScope: [] } }],
        predict: (c, dir) =>
          predictV2Agent(c, dir, opts({ upgrade: new ScriptedAgentModel([submit(c.id === PRIVATE_ID ? [PRIVATE_PATH] : ['src/features/users.ts'])]) })),
        log: () => undefined
      }
    });
    const pub = outcome.written.find((w) => !w.includes(`${path.sep}private${path.sep}`))!;
    const priv = outcome.written.find((w) => w.includes(`${path.sep}private${path.sep}`))!;
    const pubText = readFileSync(pub, 'utf8');
    expect(pubText).not.toContain(PRIVATE_ID);
    expect(pubText).not.toContain('private-only-tag');
    const pubFile = JSON.parse(pubText) as ResultFile;
    expect(pubFile.predictor).toBe('v2-agent');
    expect(pubFile.cases[0]!.costUsd).toBeGreaterThan(0);
    expect(pubFile.cases[0]!.phases[0]!.agent).toMatchObject({ status: 'submitted', runs: 1 });
    expect(readFileSync(priv, 'utf8')).toContain(PRIVATE_ID);
    // run records live in the cache dir (outside the repo)
    expect(existsSync(path.join(cacheDir, '_runs', 'agent-test', `${PRIVATE_ID}-upgrade.json`))).toBe(true);
  }, 60_000);
});

describe('predictV2Agent — full set vs subset (5a.7)', () => {
  it('full = base ∪ added − valid excluded; rejected exclusions keep the file; clone unchanged', async () => {
    const one = { ...CASE, id: 'wm-excl', phases: [CASE.phases[0]!] };
    const cloneDir = await clone(one.id);
    const before = snapshot(cloneDir);
    const pred = await predictV2Agent(one, cloneDir, opts({ upgrade: excludeScript() }));
    expect(pred.byPhase.get('upgrade')).toEqual(['src/components/Avatar.tsx', 'src/features/__tests__/users.test.ts', 'src/features/users.ts', 'src/lib/http.ts']);
    expect(pred.subsetByPhase!.get('upgrade')).toEqual(['src/features/__tests__/users.test.ts', 'src/lib/http.ts']);
    expect(pred.excludedByPhase!.get('upgrade')).toEqual(['src/features/posts.ts']);
    expect(pred.agentByPhase!.get('upgrade')!.impact).toEqual({ base: 4, confirmed: 1, added: 1, excluded: 1, rejectedExclusions: 1, excludedTruePositives: 0 });
    expect(snapshot(cloneDir)).toEqual(before);
  }, 60_000);

  it('runEval: subset scored per phase, excludedTruePositives counted against truth, aggregateSubset in the file', async () => {
    const cloneDir = await clone('wm-score');
    const resultsDir = await sandbox.scratch('results-subset');
    const c: LoadedCase = {
      id: 'wm-score',
      repo: 'https://example.invalid/wm-score',
      baseCommit: 'a'.repeat(40),
      projectDirs: ['.'],
      phases: [CASE.phases[0]!],
      tags: ['complex'],
      visibility: 'public',
      sourceFile: 'x.json'
    };
    const truth = { kept: [
      { path: 'src/features/posts.ts', kind: 'source' as const, status: 'M' },
      { path: 'src/lib/http.ts', kind: 'source' as const, status: 'M' },
      { path: 'src/features/users.ts', kind: 'source' as const, status: 'M' }
    ], dropped: [], addedCount: 0, outOfScope: [] };
    const outcome = await runEval({
      cases: [c],
      label: 'agent-subset',
      predictor: 'v2-agent',
      tool: { commit: 'x', dirty: false },
      resultsDir,
      now: new Date(2026, 10, 10, 12, 0, 0),
      deps: {
        prepare: async () => cloneDir,
        truth: async () => [{ phaseId: 'upgrade', truth }],
        predict: (cc, dir) => predictV2Agent(cc, dir, opts({ upgrade: excludeScript() })),
        log: () => undefined
      }
    });
    const file = outcome.results[0]!;
    const phase = file.cases[0]!.phases[0]!;
    // full: Avatar, users.test, users, http → tp 2 (users, http) of 3 truth
    expect(phase).toMatchObject({ predictedCount: 4, tp: 2 });
    expect(phase.recall).toBeCloseTo(2 / 3, 6);
    expect(phase.agent!.subset).toEqual({ predictedCount: 2, tp: 1, precision: 0.5, recall: 1 / 3 });
    expect(phase.agent!.impact!.excludedTruePositives).toBe(1);
    expect(file.aggregateSubset!.micro).toEqual({ precision: 0.5, recall: 1 / 3 });
    expect(file.aggregateSubset!.byTag.complex!.micro).toEqual({ precision: 0.5, recall: 1 / 3 });
    expect(file.aggregate.micro.recall).toBeCloseTo(2 / 3, 6);
  }, 60_000);
});
