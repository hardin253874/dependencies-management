/**
 * Agent [D-Deep] service (V2_STAGE4_SPEC 4a.10): submitted / budget-exhausted /
 * error paths with ScriptedAgentModel over the wrapper-module graph.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSandbox, type Sandbox } from '../helpers/sandbox';
import { buildAgentFixture, type BuiltFixture } from '../helpers/agentFixture';
import { ScriptedAgentModel, type ScriptedTurn } from '@/core/agent/model';
import { runAgentDeepReport, type RunAgentDeepReportInput } from '@/lib/llm/agentDeepReportService';
import { DEFAULT_AGENT_BUDGETS, resolveBudgets } from '@/core/agent/budgets';
import { costEstimateUsd } from '@/lib/llm/cost';

const MODEL = 'claude-sonnet-5-5';
let sandbox: Sandbox;
let fx: BuiltFixture;
const budgets = resolveBudgets(DEFAULT_AGENT_BUDGETS.deepReport, MODEL, costEstimateUsd);

const lockfileSummary = { totalPackages: 10, packagesByDirectDep: { axios: 3 }, peerDepsOnTarget: [{ package: 'x', version: '1.0.0', peerRange: '^0.27.0', satisfiedByCandidate: false }] };
const transitiveDelta = { packagesAdded: [], packagesRemoved: [], packagesUpgraded: [] };
const cveDelta = { newCves: [], resolvedCves: [] };

function input(model: ScriptedAgentModel, over: Partial<RunAgentDeepReportInput> = {}): RunAgentDeepReportInput {
  return {
    agent: model,
    modelId: MODEL,
    budgets,
    graph: fx.graph,
    workspaceRoot: fx.projectRoot,
    intel: {},
    promptInput: { dep: { name: 'axios', fromVersion: '0.27.2', toVersion: '1.6.8' }, lockfileSummary, transitiveDelta, cveDelta, resolverCheckSummary: null, coUpgradeNames: [] },
    fromVersion: '0.27.2',
    toVersion: '1.6.8',
    lockfileStateHashShort: 'abc123',
    resolverBlock: { kind: 'disabled', reason: 'kill-switch' },
    coUpgradeDeps: [],
    lockfileSummary,
    transitiveDelta,
    cveDelta,
    ...over
  };
}

const deepOutput = {
  summary: 'Deep summary.',
  riskLevel: 'high',
  narrative: 'Narrative.',
  estimatedEffort: 'medium',
  criticalBlockers: [{ title: 'Peer x', description: 'x needs ^0.27', package: 'x' }],
  suggestedUpgradeOrder: [{ step: 1, action: 'Upgrade x', rationale: 'peer' }]
};
const submit: ScriptedTurn = { content: [{ type: 'tool_use', name: 'submit_deep_update_report', input: deepOutput }] };

beforeAll(async () => {
  sandbox = await createSandbox('agent-deep-service');
  fx = await buildAgentFixture(sandbox, 'wrapper-module');
}, 60_000);

afterAll(async () => {
  fx.graph.close();
  await sandbox.dispose();
});

describe('runAgentDeepReport (4a.10)', () => {
  it('submitted → v1 deep detail with agentRun, deterministic blocks kept, effort high', async () => {
    const model = new ScriptedAgentModel([{ content: [{ type: 'tool_use', name: 'wrappers', input: { pkg: 'axios' } }] }, submit]);
    const run = await runAgentDeepReport(input(model));
    expect(run.source).toBe(`anthropic:${MODEL}`);
    expect(run.detail).toMatchObject({ summary: 'Deep summary.', riskLevel: 'high', lockfileStateHashShort: 'abc123', lockfileSummary });
    expect(run.detail.criticalBlockers).toEqual(deepOutput.criticalBlockers);
    expect(run.detail.agentRun).toMatchObject({ status: 'submitted', toolCalls: 1 });
    expect(run.record.view).toBe('deep-report');
    expect(model.requests[0]!.effort).toBe('high');
    expect(model.requests[0]!.tools.at(-1)!.name).toBe('submit_deep_update_report');
    expect(run.seedPrompt).toContain('LOCKFILE SUMMARY');
    expect(run.seedPrompt).toContain('CODE GRAPH');
  });

  it('budget-exhausted → deterministic-partial deep skeleton', async () => {
    const t: ScriptedTurn = { content: [{ type: 'tool_use', name: 'graph_summary', input: {} }] };
    const run = await runAgentDeepReport(input(new ScriptedAgentModel([t, t, t, t]), { budgets: { ...budgets, maxToolCalls: 1 } }));
    expect(run.source).toBe('deterministic-partial');
    expect(run.detail.riskLevel).toBe('high');
    expect(run.detail.agentRun?.status).toBe('budget-exhausted');
  });

  it('error → deterministic-partial with the LLM code', async () => {
    const run = await runAgentDeepReport(input(new ScriptedAgentModel([{ error: { code: 'LLM_TIMEOUT', message: 't' } }])));
    expect(run.source).toBe('deterministic-partial');
    expect(run.llmError?.code).toBe('LLM_TIMEOUT');
  });
});
