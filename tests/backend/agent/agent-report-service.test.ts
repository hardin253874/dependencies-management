/**
 * Agent [D] Update Report service (V2_STAGE4_SPEC 4a.9): ScriptedAgentModel
 * over the wrapper-module graph fixture. No network.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSandbox, type Sandbox } from '../helpers/sandbox';
import { buildAgentFixture, type BuiltFixture } from '../helpers/agentFixture';
import { ScriptedAgentModel, type ScriptedTurn } from '@/core/agent/model';
import { runAgentUpdateReport, type RunAgentUpdateReportInput } from '@/lib/llm/agentReportService';
import { AGENT_SYSTEM_PROMPT } from '@/lib/llm/prompts/agent-update-report';
import { DEFAULT_AGENT_BUDGETS, resolveBudgets } from '@/core/agent/budgets';
import { costEstimateUsd } from '@/lib/llm/cost';
import { buildAgentFixture as rebuild } from '../helpers/agentFixture';
import { writeProjectFile } from '../helpers/graphFixture';

const MODEL = 'claude-sonnet-5-5';
let sandbox: Sandbox;
let fx: BuiltFixture;

const budgets = resolveBudgets(DEFAULT_AGENT_BUDGETS.updateReport, MODEL, costEstimateUsd);

const submitted = {
  summary: 'axios 1.x changes the default export typing.',
  riskLevel: 'medium',
  breakingChanges: [{ title: 'Default export', description: 'Types changed.', affectsFilesInProject: true }],
  coUpgradeDeps: [],
  filesToModify: [
    { path: 'src/lib/http.ts', brief: 'Wrapper calls axios.get/post.', estimatedChangeSize: 'small' },
    { path: './src/lib/http.ts', brief: 'duplicate', estimatedChangeSize: 'small' },
    { path: 'src/does/not/exist.ts', brief: 'hallucinated', estimatedChangeSize: 'large' }
  ],
  recommendations: ['Run the tests.']
};

function input(model: ScriptedAgentModel, over: Partial<RunAgentUpdateReportInput> = {}): RunAgentUpdateReportInput {
  return {
    agent: model,
    modelId: MODEL,
    budgets,
    graph: fx.graph,
    workspaceRoot: fx.projectRoot,
    intel: {},
    promptInput: {
      dep: { name: 'axios', fromVersion: '0.27.2', toVersion: '1.6.8', releaseNotesBetween: null },
      resolverCheck: null,
      candidateCoUpgrades: [],
      affectedFiles: []
    },
    resolverBlock: { kind: 'disabled', reason: 'kill-switch' },
    fromVersion: '0.27.2',
    toVersion: '1.6.8',
    ...over
  };
}

const explore: ScriptedTurn = { content: [{ type: 'tool_use', name: 'files_using_package', input: { pkg: 'axios' } }], usage: { inputTokens: 3000, outputTokens: 200 } };
const submit: ScriptedTurn = { content: [{ type: 'tool_use', name: 'submit_update_report', input: submitted }], usage: { inputTokens: 500, outputTokens: 700, cacheReadInputTokens: 3000 } };

beforeAll(async () => {
  sandbox = await createSandbox('agent-report-service');
  fx = await buildAgentFixture(sandbox, 'wrapper-module');
}, 60_000);

afterAll(async () => {
  fx.graph.close();
  await sandbox.dispose();
});

describe('runAgentUpdateReport (4a.9)', () => {
  it('submitted → merged detail, anthropic source, run linked, hallucinated path dropped and counted', async () => {
    const model = new ScriptedAgentModel([explore, submit]);
    const run = await runAgentUpdateReport(input(model));
    expect(run.source).toBe(`anthropic:${MODEL}`);
    expect(run.llmError).toBeUndefined();
    expect(run.detail.summary).toBe(submitted.summary);
    expect(run.detail.resolverCheck).toEqual({ kind: 'disabled', reason: 'kill-switch' });
    expect(run.detail.filesToModify.map((f) => f.path)).toEqual(['src/lib/http.ts']);
    expect(run.droppedPaths).toEqual(['src/does/not/exist.ts']);
    expect(run.record.droppedPaths).toBe(1);
    expect(run.detail.agentRun).toMatchObject({ runId: run.record.runId, status: 'submitted', toolCalls: 1, droppedPaths: 1 });
    expect(run.detail.agentRun!.calls!.map((c) => c.tool)).toEqual(['files_using_package']);
    expect(run.detail.cost!.costEstimateUsd).toBeCloseTo(run.record.costUsd, 6);
    expect(run.record).toMatchObject({ trigger: 'user', view: 'update-report', dep: 'axios', from: '0.27.2', to: '1.6.8', status: 'submitted' });
    expect(run.record.graphBuiltAt).not.toBeNull();
    // seed + system are what the model saw
    const req = model.requests[0]!;
    expect(req.system).toBe(AGENT_SYSTEM_PROMPT);
    const seedText = (req.messages[0]!.content as Array<{ text: string }>)[0]!.text;
    expect(seedText).toBe(run.seedPrompt);
    expect(seedText).toContain('axios 0.27.2 → 1.6.8');
    expect(seedText).toContain('axios: 4 files (direct 1, wrapper 3; prod 4)');
    expect(req.tools.map((t) => t.name).at(-1)).toBe('submit_update_report');
  });

  it('budget-exhausted → deterministic-partial skeleton with graph users and the trace', async () => {
    const loop: ScriptedTurn = { content: [{ type: 'tool_use', name: 'graph_summary', input: {} }] };
    const model = new ScriptedAgentModel([loop, loop, loop, loop]);
    const run = await runAgentUpdateReport(input(model, { budgets: { ...budgets, maxToolCalls: 2 } }));
    expect(run.source).toBe('deterministic-partial');
    expect(run.record.status).toBe('budget-exhausted');
    expect(run.llmError?.code).toBe('LLM_TOOL_USE_MISSING');
    expect(run.detail.filesToModify.map((f) => f.path)).toEqual(['src/lib/http.ts']);
    expect(run.detail.agentRun).toMatchObject({ status: 'budget-exhausted', toolCalls: 2 });
    expect(run.detail.cost).toBeUndefined();
  });

  it('LLMError → deterministic-partial with that code', async () => {
    const model = new ScriptedAgentModel([{ error: { code: 'LLM_REFUSAL', message: 'declined' } }]);
    const run = await runAgentUpdateReport(input(model));
    expect(run.source).toBe('deterministic-partial');
    expect(run.llmError?.code).toBe('LLM_REFUSAL');
    expect(run.record.status).toBe('error');
  });

  it('cache key changes with the graph builtAt', async () => {
    const a = await runAgentUpdateReport(input(new ScriptedAgentModel([submit])));
    const b = await runAgentUpdateReport(input(new ScriptedAgentModel([submit])));
    expect(a.cacheKey).toBe(b.cacheKey);
    const other = await rebuild(sandbox, 'wrapper-module', { as: 'wrapper-module-2', prepare: (root) => writeProjectFile(root, 'src/extra.ts', 'export const x = 1;\n') });
    try {
      const c = await runAgentUpdateReport(input(new ScriptedAgentModel([submit]), { graph: other.graph, workspaceRoot: other.projectRoot }));
      expect(c.cacheKey).not.toBe(a.cacheKey);
    } finally {
      other.graph.close();
    }
  });

  it('playbooks: off leaves the seed message identical to no playbook; on appends a block for a match', async () => {
    const playbooks = [{ id: 'axios-test', packages: ['axios'], fromMajor: 0 as const, toMajor: 1 as const, sources: ['https://axios-http.com/docs/intro'], body: 'Axios notes.' }];
    const none = new ScriptedAgentModel([submit]);
    await runAgentUpdateReport(input(none));
    const off = new ScriptedAgentModel([submit]);
    await runAgentUpdateReport(input(off, { playbooks, playbookMode: 'off' }));
    expect(JSON.stringify(off.requests[0]!.messages)).toBe(JSON.stringify(none.requests[0]!.messages));
    const on = new ScriptedAgentModel([submit]);
    await runAgentUpdateReport(input(on, { playbooks, playbookMode: 'on' }));
    const blocks = on.requests[0]!.messages[0]!.content as Array<{ text: string }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.text).toBe((none.requests[0]!.messages[0]!.content as Array<{ text: string }>)[0]!.text);
    expect(blocks[1]!.text).toContain('Axios notes.');
  });
});
