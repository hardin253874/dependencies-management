/**
 * 5b.8 / 5b.9 app wiring: router behind the [D] job and the cost estimate,
 * switches in `_config.json`, per-project privacy (PATCH /api/projects/:slug),
 * GET routes never take a judge context, key presence only. Scripted agent
 * model + mock judge; no network, no API.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createSandbox, disposeAllSandboxes, type Sandbox } from '../helpers/sandbox';
import { createSmallNpmProject, routeCtx } from '../helpers/fixtures';
import { writeProjectFile } from '../helpers/graphFixture';
import { addProjectPipeline } from '@/lib/projects/add';
import { CSRF_HEADER, getCsrfToken } from '@/lib/csrf';
import { getJobQueue } from '@/lib/jobs/queue';
import { readEnvelope } from '@/lib/storage/envelope';
import { writeConfig, DEFAULT_CONFIG, readConfig, migrateConfig } from '@/lib/storage/config';
import { reportFilePath } from '@/lib/paths';
import { closeGraphReaders } from '@/lib/graph/readerCache';
import { setAgentModelOverride } from '@/lib/agent/factory';
import { setAgentIntelOverride } from '@/lib/agent/intel';
import { readRunRecord } from '@/lib/agent/runStore';
import { resetLlmClient } from '@/lib/llm/factory';
import { resetEnvCache } from '@/lib/config';
import { costEstimateUsd } from '@/lib/llm/cost';
import { DEFAULT_AGENT_BUDGETS, derivedMaxUsd } from '@/core/agent/budgets';
import { getJudgeContext, judgeContextCount, judgeSubjectFor, setJudgeClientOverride } from '@/lib/judge/factory';
import { JEV_USE_DEADLINE_MS } from '@/core/judge/constants';
import { resetCanonicalWriter } from '@/lib/storage/canonicalWriter';
import { MockJudgeClient } from '@/core/judge/mock';
import { ScriptedAgentModel } from '@/core/agent/model';
import type { ConfigResponse, DeepReportEstimateResponse, ProjectSummary, UpdateReportDetail } from '@/lib/api-types';
import { POST as refreshReport } from '@/app/api/projects/[slug]/reports/[name]/[from]/[to]/refresh/route';
import { GET as reportEstimate } from '@/app/api/projects/[slug]/reports/[name]/[from]/[to]/cost-estimate/route';
import { GET as deepEstimate } from '@/app/api/projects/[slug]/deep-reports/[name]/[from]/[to]/cost-estimate/route';
import { GET as getConfig, PATCH as patchConfigRoute } from '@/app/api/config/route';
import { PATCH as patchProject } from '@/app/api/projects/[slug]/route';

let sandbox: Sandbox | undefined;
let slug = '';

afterEach(async () => {
  setAgentModelOverride(null);
  setAgentIntelOverride(null);
  setJudgeClientOverride(null);
  delete process.env.TYPESAFE_API_KEY;
  resetEnvCache();
  resetLlmClient();
  if (slug !== '') {
    closeGraphReaders(slug);
    resetCanonicalWriter(slug);
  }
  slug = '';
  if (sandbox !== undefined) await sandbox.dispose();
  sandbox = undefined;
  await disposeAllSandboxes();
});

const ALL_FLAGS = { J1: true, J2: true, J3: true, J4: true, J5: true, J6: true, J7: true, J8: true };

async function setup(name: string, judge: Partial<typeof DEFAULT_CONFIG.judge> = {}): Promise<string> {
  sandbox = await createSandbox(name);
  const dir = await sandbox.scratch('app');
  await createSmallNpmProject(dir);
  await writeProjectFile(dir, 'src/index.tsx', "import React from 'react';\nexport const App = () => React.createElement('div');\n");
  const add = await addProjectPipeline({ absolutePath: dir });
  if (!add.ok) throw new Error(`add failed: ${add.error.code}`);
  slug = add.slug;
  await writeConfig({ ...DEFAULT_CONFIG, features: { resolverCheckEnabled: false }, judge: { ...DEFAULT_CONFIG.judge, ...judge } });
  setAgentIntelOverride({});
  return add.slug;
}

function req(method: string, body?: unknown, csrf = true): Request {
  return new Request('http://127.0.0.1/x', {
    method,
    headers: { 'Content-Type': 'application/json', ...(csrf ? { [CSRF_HEADER]: getCsrfToken() } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
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
        summary: 'ok',
        riskLevel: 'low',
        breakingChanges: [],
        coUpgradeDeps: [],
        filesToModify: [{ path: 'src/index.tsx', brief: 'Uses React.', estimatedChangeSize: 'small' }],
        recommendations: [],
        excludeFiles: []
      }
    }
  ]
};

async function runD(s: string, from: string, to: string): Promise<{ model: ScriptedAgentModel; detail: UpdateReportDetail }> {
  const model = new ScriptedAgentModel([submit]);
  setAgentModelOverride(model);
  const res = await refreshReport(req('POST'), routeCtx({ slug: s, name: 'react', from, to }));
  const { jobId } = (await res.json()) as { jobId: string };
  expect(await waitJob(jobId)).toBe('done');
  return { model, detail: (await readEnvelope<UpdateReportDetail>(reportFilePath(s, 'react', from, to))).data };
}

describe('5b.8 router behind the [D] job', () => {
  it('router off → the same request as with Jev fully off; no routing field', async () => {
    const s = await setup('route-off');
    const a = await runD(s, '18.3.1', '19.0.0');
    await writeConfig({ ...(await readConfig()), judge: { enabled: true, router: false, flags: { ...DEFAULT_CONFIG.judge.flags } } });
    const mock = new MockJudgeClient();
    setJudgeClientOverride(mock);
    const b = await runD(s, '18.3.1', '19.0.0');
    // The graph is rebuilt between the runs; only its timestamp line in the seed may differ.
    const norm = (x: unknown) => JSON.stringify(x).replace(/graph built at: [0-9T:.Z-]+/g,'graph built at: <t>');
    expect(norm(b.model.requests)).toBe(norm(a.model.requests));
    expect(a.model.requests[0]!.model).toBe('claude-opus-5-5');
    expect(a.detail.routing).toBeUndefined();
    expect(mock.requests).toHaveLength(0);
  });

  it('router on + easy rule (patch, few files, no CVEs) → Haiku; estimate uses Haiku prices; record carries routing', async () => {
    const s = await setup('route-haiku', { router: true });
    const est = (await (await reportEstimate(req('GET'), routeCtx({ slug: s, name: 'react', from: '18.3.1', to: '18.3.2' }))).json()) as DeepReportEstimateResponse;
    expect(est.model).toBe('claude-haiku-5-5');
    expect(est.routing).toMatchObject({ model: 'claude-haiku-5-5', via: 'rule' });
    expect(est.budgets!.maxUsd).toBeCloseTo(derivedMaxUsd('claude-haiku-5-5', DEFAULT_AGENT_BUDGETS.updateReport, costEstimateUsd), 6);
    expect(est.budgets!.maxUsd).toBeLessThan(derivedMaxUsd('claude-opus-5-5', DEFAULT_AGENT_BUDGETS.updateReport, costEstimateUsd));
    const { model, detail } = await runD(s, '18.3.1', '18.3.2');
    expect(model.requests[0]!.model).toBe('claude-haiku-5-5');
    expect(detail.routing).toMatchObject({ model: 'claude-haiku-5-5', via: 'rule' });
    const record = await readRunRecord(s, detail.agentRun!.runId);
    expect(record.data.routing?.model).toBe('claude-haiku-5-5');
  });

  it('router on + unclear + public project + Jev answer → Jev decides; unknown privacy → rules only, 0 judge requests', async () => {
    const s = await setup('route-jev', { enabled: true, router: true });
    const mock = new MockJudgeClient({ responder: () => ({ difficulty: { choice: 'moderate', confidence: 0.9 } }) });
    setJudgeClientOverride(mock);
    const priv = await runD(s, '18.3.1', '18.4.0');
    expect(priv.detail.routing).toMatchObject({ model: 'claude-opus-5-5', via: 'default', reason: 'private project: rules only' });
    expect(mock.requests).toHaveLength(0);
    expect((await patchProject(req('PATCH', { privacy: 'public' }), routeCtx({ slug: s }))).status).toBe(200);
    const pub = await runD(s, '18.3.1', '18.4.0');
    expect(pub.detail.routing).toMatchObject({ model: 'claude-sonnet-5-5', via: 'jev' });
    expect(pub.model.requests[0]!.model).toBe('claude-sonnet-5-5');
    expect(mock.requests.map((r) => r.use)).toEqual(['router']);
  });

  it('GET routes never take a judge context (spy), even with every switch on', async () => {
    const s = await setup('route-get-spy', { enabled: true, router: true, flags: ALL_FLAGS });
    await patchProject(req('PATCH', { privacy: 'public' }), routeCtx({ slug: s }));
    const mock = new MockJudgeClient();
    setJudgeClientOverride(mock);
    const before = judgeContextCount();
    await reportEstimate(req('GET'), routeCtx({ slug: s, name: 'react', from: '18.3.1', to: '18.4.0' }));
    await deepEstimate(req('GET'), routeCtx({ slug: s, name: 'react', from: '18.3.1', to: '18.4.0' }));
    await getConfig(req('GET'), undefined as never);
    expect(judgeContextCount()).toBe(before);
    expect(mock.requests).toHaveLength(0);
  });
});

describe('5b.9 switches and project privacy', () => {
  it('migration fills judge defaults (all off) silently', () => {
    const { config, notices } = migrateConfig({ schemaVersion: 1, llm: { provider: 'anthropic', model: 'claude-opus-5-5' }, ui: DEFAULT_CONFIG.ui, features: DEFAULT_CONFIG.features });
    expect(config.judge).toEqual({ enabled: false, router: false, flags: { J1: false, J2: false, J3: false, J4: false, J5: false, J6: false, J7: false, J8: false } });
    expect(notices).toEqual([]);
  });

  it('PATCH /api/config sets switches; unknown flag / non-boolean → 400; GET shows hasTypesafeKey, never the key', async () => {
    await setup('judge-config');
    const ok = (await (await patchConfigRoute(req('PATCH', { judge: { enabled: true, flags: { J5: true } } }), undefined as never)).json()) as ConfigResponse;
    expect(ok.judge).toMatchObject({ enabled: true, router: false, flags: { J5: true, J1: false } });
    expect((await patchConfigRoute(req('PATCH', { judge: { flags: { J9: true } } }), undefined as never)).status).toBe(400);
    expect((await patchConfigRoute(req('PATCH', { judge: { enabled: 'yes' } }), undefined as never)).status).toBe(400);
    const secret = 'ts-supersecret-DO-NOT-LEAK-0123456789';
    process.env.TYPESAFE_API_KEY = secret;
    resetEnvCache();
    const body = await (await getConfig(req('GET'), undefined as never)).text();
    expect(body).not.toContain(secret);
    expect((JSON.parse(body) as ConfigResponse).apiKeys.hasTypesafeKey).toBe(true);
  });

  it('PATCH /api/projects/:slug: CSRF required, round trip, null clears, invalid → 400', async () => {
    const s = await setup('project-privacy');
    expect((await patchProject(req('PATCH', { privacy: 'public' }, false), routeCtx({ slug: s }))).status).toBe(403);
    expect(await judgeSubjectFor(s)).toEqual({ privacy: undefined, judge: 'on', sourceOptIn: false });
    const set = (await (await patchProject(req('PATCH', { privacy: 'private', judge: 'off', judgeSourceOptIn: true }), routeCtx({ slug: s }))).json()) as ProjectSummary;
    expect(set).toMatchObject({ privacy: 'private', judge: 'off', judgeSourceOptIn: true });
    expect(await judgeSubjectFor(s)).toEqual({ privacy: 'private', judge: 'off', sourceOptIn: true });
    const cleared = (await (await patchProject(req('PATCH', { privacy: null, judgeSourceOptIn: false }), routeCtx({ slug: s }))).json()) as ProjectSummary;
    expect(cleared.privacy).toBeUndefined();
    expect(cleared.judgeSourceOptIn).toBeUndefined();
    expect((await patchProject(req('PATCH', { privacy: 'secret' }), routeCtx({ slug: s }))).status).toBe(400);
    expect((await patchProject(req('PATCH', { judge: true }), routeCtx({ slug: s }))).status).toBe(400);
  });

  it('per-project off overrides global on (router Jev not asked)', async () => {
    const s = await setup('project-off', { enabled: true, router: true });
    await patchProject(req('PATCH', { privacy: 'public', judge: 'off' }), routeCtx({ slug: s }));
    const mock = new MockJudgeClient();
    setJudgeClientOverride(mock);
    const { detail } = await runD(s, '18.3.1', '18.4.0');
    expect(detail.routing?.reason).toMatch(/off for this project/);
    expect(mock.requests).toHaveLength(0);
  });
});

describe('5b review M2: one breaker per judge context', () => {
  it('each user-triggered context gets its own closed breaker', async () => {
    const s = await setup('judge-breaker', { enabled: true, flags: ALL_FLAGS });
    const a = await getJudgeContext(s);
    const b = await getJudgeContext(s);
    expect(a.breaker).toMatchObject({ tripped: null, startedAt: null, deadlineMs: JEV_USE_DEADLINE_MS });
    expect(b.breaker).not.toBe(a.breaker);
  });
});
