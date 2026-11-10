/**
 * Agent [D] terminal schema + seed prompt (v2 Stage 5a.4). No network.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSandbox, type Sandbox } from '../helpers/sandbox';
import { buildAgentFixture, type BuiltFixture } from '../helpers/agentFixture';
import { UPDATE_REPORT_TOOL_SCHEMA } from '@/lib/llm/prompts/update-report';
import { AGENT_PROMPT_VERSION, AGENT_UPDATE_REPORT_TOOL_SCHEMA, AGENT_SYSTEM_PROMPT } from '@/lib/llm/prompts/agent-update-report';
import { UPDATE_REPORT_TERMINAL, agentCacheKey } from '@/lib/llm/agentReportService';
import { impactBaseLines } from '@/core/agent/seedFacts';
import { impactBaseSet } from '@/core/agent/impactBase';
import { validateInput } from '@/core/agent/schema';
import { runAgentUpdateReport } from '@/lib/llm/agentReportService';
import { ScriptedAgentModel } from '@/core/agent/model';
import { DEFAULT_AGENT_BUDGETS, resolveBudgets } from '@/core/agent/budgets';
import { costEstimateUsd } from '@/lib/llm/cost';

const MODEL = 'claude-sonnet-5-5';
let sandbox: Sandbox;
let fx: BuiltFixture;
let barrel: BuiltFixture;

beforeAll(async () => {
  sandbox = await createSandbox('agent-update-prompt');
  fx = await buildAgentFixture(sandbox, 'wrapper-module');
  barrel = await buildAgentFixture(sandbox, 'barrel-reexport');
}, 60_000);

afterAll(async () => {
  fx.graph.close();
  barrel.graph.close();
  await sandbox.dispose();
});

describe('AGENT_UPDATE_REPORT_TOOL_SCHEMA (5a.4)', () => {
  it('is the v1 schema plus one required excludeFiles property, nothing else', () => {
    const a = AGENT_UPDATE_REPORT_TOOL_SCHEMA;
    const v1 = UPDATE_REPORT_TOOL_SCHEMA;
    expect(a.name).toBe('submit_update_report');
    expect(a.name).toBe(v1.name);
    expect(a.description).toBe(v1.description);
    const { excludeFiles, ...rest } = a.inputSchema.properties as Record<string, unknown>;
    expect(rest).toEqual(v1.inputSchema.properties);
    expect(a.inputSchema.required).toEqual([...(v1.inputSchema.required ?? []), 'excludeFiles']);
    expect(excludeFiles).toEqual({
      type: 'array',
      description: expect.any(String),
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'evidence'],
        properties: { path: { type: 'string' }, evidence: { type: 'string', description: expect.any(String) } }
      }
    });
    expect(a.inputSchema.additionalProperties).toBe(false);
  });

  it('the [D] terminal tool uses it, and the v1 schema object is untouched', () => {
    expect(UPDATE_REPORT_TERMINAL.inputSchema).toBe(AGENT_UPDATE_REPORT_TOOL_SCHEMA.inputSchema);
    expect('excludeFiles' in (UPDATE_REPORT_TOOL_SCHEMA.inputSchema.properties as object)).toBe(false);
  });

  it('a submit without excludeFiles is invalid; with an empty array it is valid', () => {
    const base = { summary: 's', riskLevel: 'low', breakingChanges: [], coUpgradeDeps: [], filesToModify: [], recommendations: [] };
    expect(validateInput(UPDATE_REPORT_TERMINAL.inputSchema, base)).not.toBeNull();
    expect(validateInput(UPDATE_REPORT_TERMINAL.inputSchema, { ...base, excludeFiles: [] })).toBeNull();
    expect(validateInput(UPDATE_REPORT_TERMINAL.inputSchema, { ...base, excludeFiles: [{ path: 'a.ts', evidence: 'type-only import' }] })).toBeNull();
  });
});

describe('agent [D] seed (5a.4)', () => {
  it('impactBaseLines: totals by via and kind, then one line per package; no file paths', () => {
    const base = impactBaseSet(barrel.graph, ['antd', 'lodash', 'react']);
    const lines = impactBaseLines(base, ['antd', 'lodash', 'react']);
    expect(lines[0]).toMatch(new RegExp(`^${base.length} files \\(direct \\d+(, reexport \\d+)?(, wrapper \\d+)?; js ${base.length}\\)$`));
    expect(lines.slice(1).map((l) => l.split(':')[0])).toEqual(['antd', 'lodash', 'react']);
    for (const b of base) expect(lines.join('\n')).not.toContain(b.path);
  });

  it('the seed states the base-set counts, says it is already in the report, and asks for rank / add / exclude-after-read', async () => {
    const budgets = resolveBudgets(DEFAULT_AGENT_BUDGETS.updateReport, MODEL, costEstimateUsd);
    const submit = {
      content: [{ type: 'tool_use' as const, name: 'submit_update_report', input: { summary: 's', riskLevel: 'low', breakingChanges: [], coUpgradeDeps: [], filesToModify: [], recommendations: [], excludeFiles: [] } }]
    };
    const run = await runAgentUpdateReport({
      agent: new ScriptedAgentModel([submit]),
      modelId: MODEL,
      budgets,
      graph: fx.graph,
      workspaceRoot: fx.projectRoot,
      intel: {},
      promptInput: { dep: { name: 'axios', fromVersion: '0.27.2', toVersion: '1.6.8', releaseNotesBetween: null }, resolverCheck: null, candidateCoUpgrades: [], affectedFiles: [] },
      resolverBlock: { kind: 'disabled', reason: 'kill-switch' },
      fromVersion: '0.27.2',
      toVersion: '1.6.8'
    });
    const seed = run.seedPrompt;
    expect(seed).toContain('BASE IMPACTED SET');
    expect(seed).toContain('- 4 files (direct 1, wrapper 3; js 4)');
    expect(seed).toContain('- axios: 4 files');
    expect(seed).toMatch(/already in the report/);
    expect(seed).toMatch(/excludeFiles/);
    expect(seed).toMatch(/read_file/);
    expect(seed).toMatch(/ranked/);
    // counts only: no base-set file list in the seed
    for (const p of ['src/features/posts.ts', 'src/features/users.ts', 'src/components/Avatar.tsx']) expect(seed).not.toContain(p);
  });

  it('AGENT_PROMPT_VERSION is 2 and is part of the cache key', () => {
    expect(AGENT_PROMPT_VERSION).toBe(2);
    const budgets = resolveBudgets(DEFAULT_AGENT_BUDGETS.updateReport, MODEL, costEstimateUsd);
    const opts = { system: AGENT_SYSTEM_PROMPT, seed: 'seed', playbookText: null, tool: AGENT_UPDATE_REPORT_TOOL_SCHEMA, model: MODEL, graph: fx.graph, budgets };
    const a = agentCacheKey(opts);
    expect(agentCacheKey({ ...opts, promptVersion: AGENT_PROMPT_VERSION - 1 })).not.toBe(a);
    expect(agentCacheKey({ ...opts, promptVersion: AGENT_PROMPT_VERSION })).toBe(a);
  });
});
