/**
 * `run --predictor v1-ai` (V2_STAGE4_SPEC 4a.15): MockLLMClient fixtures
 * seeded with `setByInput` against the exact v1 prompt, a fake v1 scan, and a
 * sandbox clone for the graph filter. No network, no API.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { createSandbox, type Sandbox } from '../helpers/sandbox';
import { copyGraphFixture } from '../helpers/graphFixture';
import { eligiblePackages, NO_ELIGIBLE_PACKAGE, predictV1Ai, type ScanFn } from '../../../eval/lib/predict-v1-ai';
import { MockLLMClient } from '@/lib/llm/mock';
import { SHARED_SYSTEM_PROMPT } from '@/lib/llm/prompts/shared';
import { renderUpdateReportPrompt, UPDATE_REPORT_TOOL_SCHEMA } from '@/lib/llm/prompts/update-report';
import { costEstimateUsd } from '@/lib/llm/cost';
import { aggregate } from '../../../eval/lib/score';
import type { CodeScanResult } from '@/lib/scanners/code';
import type { CaseResult, CorpusCase, PhaseResult } from '../../../eval/lib/types';

const MODEL = 'claude-sonnet-5-5';
let sandbox: Sandbox;
let cacheDir: string;
let cloneDir: string;

const scan: ScanFn = async () =>
  ({
    imports: new Map([['axios', [{ path: 'src/lib/http.ts', pathHash: 'h', category: 'prod', importStatements: ["import axios from 'axios';"] }]]]),
    dynamicImports: [],
    oversizedSkipped: [],
    totalFilesScanned: 6
  }) as unknown as CodeScanResult;

function seed(client: MockLLMClient, name: string, from: string, to: string, files: string[]): void {
  const affectedFiles = name === 'axios' ? [{ path: 'src/lib/http.ts', importStatements: ["import axios from 'axios';"], importCount: 1 }] : [];
  client.setByInput(
    {
      systemPrompt: SHARED_SYSTEM_PROMPT,
      userPrompt: renderUpdateReportPrompt({ dep: { name, fromVersion: from, toVersion: to, releaseNotesBetween: null }, resolverCheck: null, candidateCoUpgrades: [], affectedFiles }),
      tool: UPDATE_REPORT_TOOL_SCHEMA,
      model: MODEL
    },
    {
      output: {
        summary: 's',
        riskLevel: 'low',
        breakingChanges: [],
        coUpgradeDeps: [],
        filesToModify: files.map((p) => ({ path: p, brief: 'b', estimatedChangeSize: 'small' })),
        recommendations: []
      },
      inputTokens: 2000,
      outputTokens: 500
    }
  );
}

beforeAll(async () => {
  sandbox = await createSandbox('v1-ai-predict');
  cacheDir = await sandbox.scratch('eval-cache');
  const { projectRoot } = await copyGraphFixture(sandbox, 'wrapper-module', 'v1ai-src');
  cloneDir = path.join(cacheDir, 'v1ai-case');
  await fs.cp(projectRoot, cloneDir, { recursive: true });
}, 60_000);

afterAll(async () => {
  await sandbox.dispose();
});

describe('eligiblePackages (4a.15)', () => {
  it.each([
    [[{ name: 'a', from: '1.0.0', to: '2.0.0' }], ['a']],
    [[{ name: 'a', from: null, to: '2.0.0' }], []],
    [[{ name: 'a', from: '1.0.0', to: null }], []],
    [[{ name: 'a', from: '1.0.0', to: '1.0.0' }], []],
    [
      [
        { name: 'a', from: '1', to: '2' },
        { name: 'b', from: null, to: '2' },
        { name: 'c', from: '1', to: '2' },
        { name: 'd', from: '1', to: '2' },
        { name: 'e', from: '1', to: '2' }
      ],
      ['a', 'c', 'd']
    ]
  ] as const)('%j → %j', (packages, names) => {
    expect(eligiblePackages({ packages: packages as never }).map((p) => p.name)).toEqual(names);
  });
});

describe('predictV1Ai (4a.15)', () => {
  const CASE: Pick<CorpusCase, 'id' | 'projectDirs' | 'phases'> = {
    id: 'v1ai-case',
    projectDirs: ['.'],
    phases: [
      { id: 'up', toCommit: 'b'.repeat(40), packages: [{ name: 'axios', from: '0.27.2', to: '1.6.8' }, { name: 'ky', from: null, to: '1.0.0' }] },
      { id: 'addonly', toCommit: 'c'.repeat(40), packages: [{ name: 'ky', from: null, to: '1.0.0' }] }
    ]
  };

  it('predicted set from v1 [D] filesToModify, filtered to graph files; cost summed; no-eligible phase skipped', async () => {
    const client = new MockLLMClient();
    seed(client, 'axios', '0.27.2', '1.6.8', ['src/lib/http.ts', 'src/ghost.ts']);
    const pred = await predictV1Ai(CASE, cloneDir, { cacheDir, client, model: MODEL, scan });
    expect(pred.byPhase.get('up')).toEqual(['src/lib/http.ts']);
    expect(pred.skippedPhases!.get('addonly')).toBe(NO_ELIGIBLE_PACKAGE);
    expect(pred.byPhase.has('addonly')).toBe(false);
    expect(pred.agentByPhase!.get('up')).toMatchObject({ status: 'submitted', runs: 1, hallucinatedPaths: 1, inputTokens: 2000, outputTokens: 500 });
    expect(pred.costUsd).toBeCloseTo(costEstimateUsd(MODEL, { inputTokens: 2000, outputTokens: 500 }), 6);
  });

  it('a missing fixture (deterministic-partial) predicts nothing and marks the phase error', async () => {
    const pred = await predictV1Ai({ ...CASE, phases: [CASE.phases[0]!] }, cloneDir, { cacheDir, client: new MockLLMClient({ fixtureDir: path.join(cacheDir, 'none') }), model: MODEL, scan });
    expect(pred.byPhase.get('up')).toEqual([]);
    expect(pred.agentByPhase!.get('up')!.status).toBe('error');
    expect(pred.costUsd).toBe(0);
  });

  it('skipped phases are excluded from aggregates', () => {
    const phase = (id: string, tp: number, status?: 'skipped'): PhaseResult =>
      ({
        id,
        packages: [],
        tags: [],
        truthCount: 4,
        predictedCount: tp,
        tp,
        precision: tp === 0 ? null : 1,
        recall: tp / 4,
        recallByKind: { source: null, config: null, style: null },
        falseNegatives: [],
        falsePositivesCount: 0,
        falsePositivesSample: [],
        addedCount: 0,
        droppedCounts: {},
        outOfScope: [],
        ...(status !== undefined ? { status, reason: NO_ELIGIBLE_PACKAGE } : {})
      }) as PhaseResult;
    const c: CaseResult = { id: 'x', tags: [], status: 'ok', filesScanned: 0, durationMs: 0, costUsd: 0, phases: [phase('a', 4), phase('b', 0, 'skipped')], findings: null };
    expect(aggregate([c]).micro.recall).toBe(1);
  });
});
