/**
 * [D] / [D-Deep] routes with the agent engine (V2_STAGE4_SPEC 4a.12):
 * scripted model (`setAgentModelOverride`), no registry (`setAgentIntelOverride({})`),
 * resolver kill-switch on, sandbox library. No network, no API.
 * The [D-Deep] L2 deep scan (registry + OSV.dev) is replaced by a canned
 * deterministic payload so the route test stays offline; the scan itself is
 * covered by deep-scan.test.ts.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createSandbox, disposeAllSandboxes, type Sandbox } from '../helpers/sandbox';
import { createSmallNpmProject, routeCtx } from '../helpers/fixtures';
import { writeProjectFile } from '../helpers/graphFixture';
import { addProjectPipeline } from '@/lib/projects/add';
import { CSRF_HEADER, getCsrfToken } from '@/lib/csrf';
import { getJobQueue } from '@/lib/jobs/queue';
import { readEnvelope } from '@/lib/storage/envelope';
import { patchConfig, writeConfig, DEFAULT_CONFIG, readConfig } from '@/lib/storage/config';
import { deepReportsDirForPackage, reportFilePath, runsDir } from '@/lib/paths';
import { closeGraphReaders } from '@/lib/graph/readerCache';
import { setAgentModelOverride } from '@/lib/agent/factory';
import { setAgentIntelOverride } from '@/lib/agent/intel';
import { readRunRecord } from '@/lib/agent/runStore';
import { resetLlmClient } from '@/lib/llm/factory';
import { resetEnvCache } from '@/lib/config';
import { ScriptedAgentModel, type ScriptStep } from '@/core/agent/model';
import type { DeepReportEstimateResponse, DeepUpdateReportDetail, UpdateReportDetail } from '@/lib/api-types';
import { POST as refreshReport } from '@/app/api/projects/[slug]/reports/[name]/[from]/[to]/refresh/route';
import { GET as reportEstimate } from '@/app/api/projects/[slug]/reports/[name]/[from]/[to]/cost-estimate/route';
import { POST as refreshDeepReport } from '@/app/api/projects/[slug]/deep-reports/[name]/[from]/[to]/refresh/route';
import { GET as deepEstimate } from '@/app/api/projects/[slug]/deep-reports/[name]/[from]/[to]/cost-estimate/route';
import { GET as getConfig } from '@/app/api/config/route';

vi.mock('@/lib/scanners/deepScan', () => ({
  runDeepScan: vi.fn(async () => ({
    lockfileSummary: { totalPackages: 3, packagesByDirectDep: { react: 0 }, peerDepsOnTarget: [] },
    transitiveDelta: { packagesAdded: [], packagesRemoved: [], packagesUpgraded: [] },
    cveDelta: { newCves: [], resolvedCves: [] },
    l2CacheHit: false
  }))
}));

let sandbox: Sandbox | undefined;
let slug = '';

afterEach(async () => {
  setAgentModelOverride(null);
  setAgentIntelOverride(null);
  delete process.env.MOCK_LLM;
  resetEnvCache();
  resetLlmClient();
  if (slug !== '') closeGraphReaders(slug);
  slug = '';
  if (sandbox !== undefined) await sandbox.dispose();
  sandbox = undefined;
  await disposeAllSandboxes();
});

async function setup(name: string): Promise<string> {
  sandbox = await createSandbox(name);
  const dir = await sandbox.scratch('app');
  await createSmallNpmProject(dir);
  await writeProjectFile(dir, 'src/index.tsx', "import React from 'react';\nexport const App = () => React.createElement('div');\n");
  const add = await addProjectPipeline({ absolutePath: dir });
  if (!add.ok) throw new Error(`add failed: ${add.error.code}`);
  slug = add.slug;
  await writeConfig({ ...DEFAULT_CONFIG, features: { resolverCheckEnabled: false } });
  setAgentIntelOverride({});
  return add.slug;
}

function post(url: string): Request {
  return new Request(url, { method: 'POST', headers: { [CSRF_HEADER]: getCsrfToken() } });
}

async function waitJob(jobId: string): Promise<string> {
  for (let i = 0; i < 500; i += 1) {
    const rec = getJobQueue().get(jobId);
    if (rec !== null && (rec.state === 'done' || rec.state === 'error' || rec.state === 'cancelled')) return rec.state;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('job did not finish');
}

const submit = {
  content: [
    {
      type: 'tool_use' as const,
      name: 'submit_update_report',
      input: {
        summary: 'React 19 changes the root API.',
        riskLevel: 'high',
        breakingChanges: [],
        coUpgradeDeps: [],
        filesToModify: [{ path: 'src/index.tsx', brief: 'Uses React.createElement.', estimatedChangeSize: 'small' }],
        recommendations: [],
        excludeFiles: []
      }
    }
  ]
};

describe('POST [D] refresh with the agent engine (4a.12)', () => {
  it('job runs the agent over the graph, writes the envelope and a linked run record', async () => {
    const s = await setup('agent-route-d');
    const model = new ScriptedAgentModel([{ content: [{ type: 'tool_use', name: 'files_using_package', input: { pkg: 'react' } }] }, submit]);
    setAgentModelOverride(model);
    const res = await refreshReport(post('http://127.0.0.1/x'), routeCtx({ slug: s, name: 'react', from: '18.3.1', to: '19.0.0' }));
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };
    expect(await waitJob(jobId)).toBe('done');

    const env = await readEnvelope<UpdateReportDetail>(reportFilePath(s, 'react', '18.3.1', '19.0.0'));
    expect(env.source).toBe('anthropic:claude-opus-5-5');
    expect(env.data.filesToModify.map((f) => f.path)).toEqual(['src/index.tsx']);
    expect(env.data.agentRun?.status).toBe('submitted');
    const record = await readRunRecord(s, env.data.agentRun!.runId);
    expect(record.data.resultRef).toBe(`${s}/reports/react/18.3.1__19.0.0.json`);
    expect(record.data.trace.calls.map((c) => c.tool)).toEqual(['files_using_package']);
    // the tool really ran against the freshly built graph
    const firstResult = JSON.stringify(model.requests[1]!.messages.at(-1));
    expect(firstResult).toContain('src/index.tsx');
  });

  it('cancel mid-run → job cancelled, deterministic-partial envelope, run record kept', async () => {
    const s = await setup('agent-route-cancel');
    let jobId = '';
    const hang: ScriptStep = (req) =>
      new Promise((_resolve, reject) => {
        req.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        getJobQueue().cancel(jobId);
      });
    setAgentModelOverride(new ScriptedAgentModel([hang]));
    const res = await refreshReport(post('http://127.0.0.1/x'), routeCtx({ slug: s, name: 'react', from: '18.3.1', to: '19.0.0' }));
    jobId = ((await res.json()) as { jobId: string }).jobId;
    expect(await waitJob(jobId)).toBe('cancelled');
    // the job body finishes writing after the abort
    for (let i = 0; i < 200 && !existsSync(reportFilePath(s, 'react', '18.3.1', '19.0.0')); i += 1) await new Promise((r) => setTimeout(r, 10));
    const env = await readEnvelope<UpdateReportDetail>(reportFilePath(s, 'react', '18.3.1', '19.0.0'));
    expect(env.source).toBe('deterministic-partial');
    expect(env.data.agentRun?.status).toBe('cancelled');
    for (let i = 0; i < 200 && !existsSync(runsDir(s)); i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(readdirSync(runsDir(s))).toHaveLength(1);
  });

  it('reportEngine v1 → the v1 service answers (no agent run, no run record)', async () => {
    const s = await setup('agent-route-v1');
    await patchConfig({ llm: { reportEngine: 'v1' } });
    expect((await readConfig()).llm.reportEngine).toBe('v1');
    setAgentModelOverride(new ScriptedAgentModel([]));
    // v1 path under MOCK_LLM with no fixture → MOCK_LLM_NO_FIXTURE → v1 deterministic-partial.
    process.env.MOCK_LLM = 'true';
    resetEnvCache();
    resetLlmClient();
    const res = await refreshReport(post('http://127.0.0.1/x'), routeCtx({ slug: s, name: 'react', from: '18.3.1', to: '19.0.0' }));
    const { jobId } = (await res.json()) as { jobId: string };
    expect(await waitJob(jobId)).toBe('done');
    const env = await readEnvelope<UpdateReportDetail>(reportFilePath(s, 'react', '18.3.1', '19.0.0'));
    // the empty mock has no fixture → v1 deterministic-partial, without agentRun
    expect(env.source).toBe('deterministic-partial');
    expect(env.data.agentRun).toBeUndefined();
    expect(existsSync(runsDir(s))).toBe(false);
  });
});

const deepSubmit = {
  content: [
    {
      type: 'tool_use' as const,
      name: 'submit_deep_update_report',
      input: {
        summary: 'React 19 deep summary.',
        riskLevel: 'high',
        narrative: 'Narrative.',
        estimatedEffort: 'medium',
        criticalBlockers: [],
        suggestedUpgradeOrder: [{ step: 1, action: 'Upgrade react-dom with react', rationale: 'peer' }]
      }
    }
  ]
};

/** The [D-Deep] envelope name carries the lockfile-state hash suffix; wait for the single file written. */
async function waitDeepReportFile(s: string): Promise<string> {
  const dir = deepReportsDirForPackage(s, 'react');
  for (let i = 0; i < 200; i += 1) {
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
    if (files.length > 0) {
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^18\.3\.1__19\.0\.0__lf-[0-9a-f]{5}\.json$/);
      return path.join(dir, files[0]!);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('deep report envelope not written');
}

describe('POST [D-Deep] refresh with the agent engine (4a.12)', () => {
  it('job runs the agent, writes the hash-suffixed envelope with agentRun and a linked run record', async () => {
    const s = await setup('agent-route-deep');
    const model = new ScriptedAgentModel([{ content: [{ type: 'tool_use', name: 'files_using_package', input: { pkg: 'react' } }] }, deepSubmit]);
    setAgentModelOverride(model);
    const res = await refreshDeepReport(post('http://127.0.0.1/x'), routeCtx({ slug: s, name: 'react', from: '18.3.1', to: '19.0.0' }));
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };
    expect(await waitJob(jobId)).toBe('done');

    const file = await waitDeepReportFile(s);
    const env = await readEnvelope<DeepUpdateReportDetail>(file);
    expect(env.source).toBe('anthropic:claude-opus-5-5');
    expect(env.data.summary).toBe('React 19 deep summary.');
    expect(env.data.agentRun?.status).toBe('submitted');
    const record = await readRunRecord(s, env.data.agentRun!.runId);
    expect(record.data.view).toBe('deep-report');
    expect(record.data.resultRef).toBe(`${s}/deep-reports/react/${path.basename(file)}`);
    expect(record.data.trace.calls.map((c) => c.tool)).toEqual(['files_using_package']);
    // the tool really ran against the freshly built graph
    expect(JSON.stringify(model.requests[1]!.messages.at(-1))).toContain('src/index.tsx');
  });

  it('cancel mid-run → job cancelled, deterministic-partial deep envelope, run record kept', async () => {
    const s = await setup('agent-route-deep-cancel');
    let jobId = '';
    const hang: ScriptStep = (req) =>
      new Promise((_resolve, reject) => {
        req.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        getJobQueue().cancel(jobId);
      });
    setAgentModelOverride(new ScriptedAgentModel([hang]));
    const res = await refreshDeepReport(post('http://127.0.0.1/x'), routeCtx({ slug: s, name: 'react', from: '18.3.1', to: '19.0.0' }));
    jobId = ((await res.json()) as { jobId: string }).jobId;
    expect(await waitJob(jobId)).toBe('cancelled');
    // the job body finishes writing after the abort
    const env = await readEnvelope<DeepUpdateReportDetail>(await waitDeepReportFile(s));
    expect(env.source).toBe('deterministic-partial');
    expect(env.data.agentRun?.status).toBe('cancelled');
    for (let i = 0; i < 200 && !existsSync(runsDir(s)); i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(readdirSync(runsDir(s))).toHaveLength(1);
  });

  it('reportEngine v1 → the v1 deep service answers (no agent run, no run record)', async () => {
    const s = await setup('agent-route-deep-v1');
    await patchConfig({ llm: { reportEngine: 'v1' } });
    setAgentModelOverride(new ScriptedAgentModel([]));
    // v1 path under MOCK_LLM with no fixture → MOCK_LLM_NO_FIXTURE → v1 deterministic-partial.
    process.env.MOCK_LLM = 'true';
    resetEnvCache();
    resetLlmClient();
    const res = await refreshDeepReport(post('http://127.0.0.1/x'), routeCtx({ slug: s, name: 'react', from: '18.3.1', to: '19.0.0' }));
    const { jobId } = (await res.json()) as { jobId: string };
    expect(await waitJob(jobId)).toBe('done');
    const env = await readEnvelope<DeepUpdateReportDetail>(await waitDeepReportFile(s));
    expect(env.source).toBe('deterministic-partial');
    expect(env.data.agentRun).toBeUndefined();
    expect(existsSync(runsDir(s))).toBe(false);
  });
});

describe('cost-estimate routes (4a.12)', () => {
  it('[D] estimate returns maxUsd = budgets.maxUsd and an expected cost below it', async () => {
    const s = await setup('agent-est-d');
    const res = await reportEstimate(new Request('http://127.0.0.1/x'), routeCtx({ slug: s, name: 'react', from: '18.3.1', to: '19.0.0' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as DeepReportEstimateResponse;
    expect(body.engine).toBe('agent');
    expect(body.maxUsd).toBe(body.budgets!.maxUsd);
    expect(body.budgets!.maxToolCalls).toBe(20);
    expect(body.estimatedCostUsd).toBeGreaterThan(0);
    expect(body.estimatedCostUsd).toBeLessThanOrEqual(body.maxUsd!);
    expect(existsSync(runsDir(s))).toBe(false);
  });

  it('[D-Deep] estimate uses the deep budgets; v1 engine keeps the v1 shape', async () => {
    const s = await setup('agent-est-deep');
    const agent = (await (await deepEstimate(new Request('http://127.0.0.1/x'), routeCtx({ slug: s, name: 'react', from: '18.3.1', to: '19.0.0' }))).json()) as DeepReportEstimateResponse;
    expect(agent.budgets!.maxToolCalls).toBe(40);
    expect(agent.maxUsd).toBe(agent.budgets!.maxUsd);
    await patchConfig({ llm: { reportEngine: 'v1' } });
    const v1 = (await (await deepEstimate(new Request('http://127.0.0.1/x'), routeCtx({ slug: s, name: 'react', from: '18.3.1', to: '19.0.0' }))).json()) as DeepReportEstimateResponse;
    expect(v1.maxUsd).toBeUndefined();
    expect(v1.engine).toBeUndefined();
  });

  it('GET /api/config exposes the agent budgets (read-only) and no key value', async () => {
    await setup('agent-config');
    const body = (await (await getConfig(new Request('http://127.0.0.1/api/config'), undefined as never)).json()) as Record<string, unknown>;
    expect(body.agentBudgets).toMatchObject({ updateReport: { maxToolCalls: 20, maxUsd: null }, deepReport: { maxToolCalls: 40 } });
    expect(JSON.stringify(body)).not.toMatch(/sk-ant/);
  });
});
