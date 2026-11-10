/**
 * D32 (confirmed 2026-11-10): defaults after Stage 5c.
 * - the agent engine for [D] / [D-Deep] runs on `llm.agentModel` (default
 *   Sonnet 5.5); every other view keeps `llm.model`;
 * - Jev J1 is on by default (global switch + J1), router and J2–J8 stay off;
 *   a one-time config migration turns them on once for configs 5b persisted
 *   all-off, recorded so it never re-applies after the user turns them off.
 * Scripted agent model + mock judge; no network, no API.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { createSandbox, disposeAllSandboxes, type Sandbox } from '../helpers/sandbox';
import { createSmallNpmProject, routeCtx } from '../helpers/fixtures';
import { writeProjectFile } from '../helpers/graphFixture';
import { addProjectPipeline } from '@/lib/projects/add';
import { CSRF_HEADER, getCsrfToken } from '@/lib/csrf';
import { getJobQueue } from '@/lib/jobs/queue';
import { readEnvelope } from '@/lib/storage/envelope';
import { writeConfig, DEFAULT_CONFIG, readConfig, migrateConfig, CONFIG_MIGRATION_D32 } from '@/lib/storage/config';
import { configFilePath, reportFilePath } from '@/lib/paths';
import { closeGraphReaders } from '@/lib/graph/readerCache';
import { setAgentModelOverride } from '@/lib/agent/factory';
import { setAgentIntelOverride } from '@/lib/agent/intel';
import { resetLlmClient, setLlmClient } from '@/lib/llm/factory';
import { resetEnvCache } from '@/lib/config';
import { costEstimateUsd } from '@/lib/llm/cost';
import { DEFAULT_AGENT_MODEL, defaultModel } from '@/lib/llm/models';
import { DEFAULT_AGENT_BUDGETS, derivedMaxUsd } from '@/core/agent/budgets';
import { DEFAULT_JUDGE_SWITCHES, normalizeJudgeSwitches } from '@/core/judge/types';
import { judgeContextCount, setJudgeClientOverride, usableJudgeContextFor } from '@/lib/judge/factory';
import { resetCanonicalWriter } from '@/lib/storage/canonicalWriter';
import { MockJudgeClient } from '@/core/judge/mock';
import { ScriptedAgentModel } from '@/core/agent/model';
import type { LLMClient } from '@/lib/llm/client';
import type { ConfigResponse, DeepReportEstimateResponse, UpdateReportDetail } from '@/lib/api-types';
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
  setLlmClient(null);
  vi.unstubAllEnvs();
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

const ALL_OFF = { J1: false, J2: false, J3: false, J4: false, J5: false, J6: false, J7: false, J8: false };

/** A config exactly as 5b persisted it: all judge switches false, no D32 marker, no agentModel. */
function stage5bConfig(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    llm: { provider: 'anthropic', model: 'claude-opus-5-5', reportEngine: 'agent' },
    ui: DEFAULT_CONFIG.ui,
    features: DEFAULT_CONFIG.features,
    agentBudgets: DEFAULT_CONFIG.agentBudgets,
    judge: { enabled: false, router: false, flags: { ...ALL_OFF } }
  };
}

async function setup(name: string, opts: { rawConfig?: unknown } = {}): Promise<string> {
  sandbox = await createSandbox(name);
  const dir = await sandbox.scratch('app');
  await createSmallNpmProject(dir);
  await writeProjectFile(dir, 'src/index.tsx', "import React from 'react';\nexport const App = () => React.createElement('div');\n");
  const add = await addProjectPipeline({ absolutePath: dir });
  if (!add.ok) throw new Error(`add failed: ${add.error.code}`);
  slug = add.slug;
  if (opts.rawConfig !== undefined) {
    await fs.writeFile(configFilePath(), JSON.stringify(opts.rawConfig, null, 2), 'utf8');
  } else {
    await writeConfig({ ...DEFAULT_CONFIG, features: { resolverCheckEnabled: false } });
  }
  setAgentIntelOverride({});
  return add.slug;
}

function req(method: string, body?: unknown): Request {
  return new Request('http://127.0.0.1/x', {
    method,
    headers: { 'Content-Type': 'application/json', [CSRF_HEADER]: getCsrfToken() },
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

async function runD(s: string): Promise<{ model: ScriptedAgentModel; detail: UpdateReportDetail }> {
  const model = new ScriptedAgentModel([submit]);
  setAgentModelOverride(model);
  const res = await refreshReport(req('POST'), routeCtx({ slug: s, name: 'react', from: '18.3.1', to: '19.0.0' }));
  const { jobId } = (await res.json()) as { jobId: string };
  expect(await waitJob(jobId)).toBe('done');
  return { model, detail: (await readEnvelope<UpdateReportDetail>(reportFilePath(s, 'react', '18.3.1', '19.0.0'))).data };
}

describe('D32 agent report model (llm.agentModel)', () => {
  it('defaults: agent model Sonnet 5.5, every other view keeps llm.model (Opus 5.5)', () => {
    expect(DEFAULT_AGENT_MODEL).toBe('claude-sonnet-5-5');
    expect(DEFAULT_CONFIG.llm.agentModel).toBe('claude-sonnet-5-5');
    expect(DEFAULT_CONFIG.llm.model).toBe('claude-opus-5-5');
  });

  it('migration fills a missing agentModel with Sonnet 5.5 silently; a stored one is kept', () => {
    const filled = migrateConfig(stage5bConfig());
    expect(filled.config.llm).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5', reportEngine: 'agent', agentModel: 'claude-sonnet-5-5' });
    expect(filled.notices).toEqual([]);
    const kept = migrateConfig({ ...stage5bConfig(), llm: { provider: 'anthropic', model: 'claude-opus-5-5', agentModel: 'claude-haiku-5-5' } });
    expect(kept.config.llm.agentModel).toBe('claude-haiku-5-5');
    expect(kept.notices).toEqual([]);
  });

  it('an agentModel the picker no longer offers → default + one MODEL_MIGRATED notice', () => {
    const { config, notices } = migrateConfig({ ...stage5bConfig(), llm: { provider: 'anthropic', model: 'claude-opus-5-5', agentModel: 'claude-sonnet-4-6' } });
    expect(config.llm.agentModel).toBe(DEFAULT_AGENT_MODEL);
    expect(config.llm.model).toBe('claude-opus-5-5');
    expect(notices.map((n) => n.code)).toEqual(['MODEL_MIGRATED']);
    expect(notices[0]!.message).toContain('claude-sonnet-4-6');
  });

  it('legacy / missing llm sections also get the default agent model', () => {
    expect(migrateConfig({ ...stage5bConfig(), llm: { provider: 'openai', model: 'gpt-4o' } }).config.llm.agentModel).toBe(DEFAULT_AGENT_MODEL);
    expect(migrateConfig({ schemaVersion: 1, ui: DEFAULT_CONFIG.ui, features: DEFAULT_CONFIG.features }).config.llm.agentModel).toBe(DEFAULT_AGENT_MODEL);
    expect(defaultModel()).toBe('claude-opus-5-5');
  });

  it('GET /api/config returns it; PATCH validates and persists it without touching llm.model', async () => {
    await setup('d32-agent-model-patch');
    const got = (await (await getConfig(req('GET'), undefined as never)).json()) as ConfigResponse;
    expect(got.llm.agentModel).toBe('claude-sonnet-5-5');
    const ok = await patchConfigRoute(req('PATCH', { llm: { agentModel: 'claude-haiku-5-5' } }), undefined as never);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as ConfigResponse;
    expect(body.llm).toMatchObject({ model: 'claude-opus-5-5', agentModel: 'claude-haiku-5-5' });
    expect((await readConfig()).llm.agentModel).toBe('claude-haiku-5-5');
    const bad = await patchConfigRoute(req('PATCH', { llm: { agentModel: 'claude-opus-4-7' } }), undefined as never);
    expect(bad.status).toBe(400);
    expect((await readConfig()).llm.agentModel).toBe('claude-haiku-5-5');
  });

  it('[D] agent job and both cost estimates use the agent model (Sonnet by default)', async () => {
    const s = await setup('d32-agent-model-run');
    const est = (await (await reportEstimate(req('GET'), routeCtx({ slug: s, name: 'react', from: '18.3.1', to: '19.0.0' }))).json()) as DeepReportEstimateResponse;
    expect(est.model).toBe('claude-sonnet-5-5');
    expect(est.maxUsd).toBeCloseTo(derivedMaxUsd('claude-sonnet-5-5', DEFAULT_AGENT_BUDGETS.updateReport, costEstimateUsd), 6);
    const deep = (await (await deepEstimate(req('GET'), routeCtx({ slug: s, name: 'react', from: '18.3.1', to: '19.0.0' }))).json()) as DeepReportEstimateResponse;
    expect(deep.model).toBe('claude-sonnet-5-5');
    expect(deep.maxUsd).toBeCloseTo(derivedMaxUsd('claude-sonnet-5-5', DEFAULT_AGENT_BUDGETS.deepReport, costEstimateUsd), 6);
    const { model, detail } = await runD(s);
    expect(model.requests[0]!.model).toBe('claude-sonnet-5-5');
    expect(detail.routing).toBeUndefined();
  });

  it('a user-chosen agent model is what the estimate prices and the job runs', async () => {
    const s = await setup('d32-agent-model-opus');
    await writeConfig({ ...(await readConfig()), llm: { ...(await readConfig()).llm, agentModel: 'claude-opus-5-5' } });
    const est = (await (await reportEstimate(req('GET'), routeCtx({ slug: s, name: 'react', from: '18.3.1', to: '19.0.0' }))).json()) as DeepReportEstimateResponse;
    expect(est.model).toBe('claude-opus-5-5');
    const { model } = await runD(s);
    expect(model.requests[0]!.model).toBe('claude-opus-5-5');
  });

  it('v1 report engine keeps llm.model in the estimate', async () => {
    const s = await setup('d32-v1-engine');
    await writeConfig({ ...(await readConfig()), llm: { ...(await readConfig()).llm, reportEngine: 'v1' } });
    const est = (await (await reportEstimate(req('GET'), routeCtx({ slug: s, name: 'react', from: '18.3.1', to: '19.0.0' }))).json()) as DeepReportEstimateResponse;
    expect(est.engine).toBe('v1');
    expect(est.model).toBe('claude-opus-5-5');
    const deep = (await (await deepEstimate(req('GET'), routeCtx({ slug: s, name: 'react', from: '18.3.1', to: '19.0.0' }))).json()) as DeepReportEstimateResponse;
    expect(deep.model).toBe('claude-opus-5-5');
  });

  it('router on still overrides the agent model (easy rule → Haiku)', async () => {
    const s = await setup('d32-router-on');
    const cur = await readConfig();
    await writeConfig({ ...cur, judge: { ...cur.judge, router: true } });
    const est = (await (await reportEstimate(req('GET'), routeCtx({ slug: s, name: 'react', from: '18.3.1', to: '18.3.2' }))).json()) as DeepReportEstimateResponse;
    expect(est.model).toBe('claude-haiku-5-5');
  });
});

describe('D32 J1 on by default', () => {
  it('DEFAULT_JUDGE_SWITCHES: enabled + J1 on; router and J2–J8 off', () => {
    expect(DEFAULT_JUDGE_SWITCHES).toEqual({ enabled: true, router: false, flags: { ...ALL_OFF, J1: true } });
    expect(DEFAULT_CONFIG.judge).toEqual({ enabled: true, router: false, flags: { ...ALL_OFF, J1: true } });
  });

  it('normalizeJudgeSwitches: a missing field takes its default, an explicit false stays false', () => {
    expect(normalizeJudgeSwitches(undefined)).toEqual(DEFAULT_JUDGE_SWITCHES);
    expect(normalizeJudgeSwitches({})).toEqual(DEFAULT_JUDGE_SWITCHES);
    expect(normalizeJudgeSwitches({ flags: { J2: true } })).toEqual({ enabled: true, router: false, flags: { ...ALL_OFF, J1: true, J2: true } });
    expect(normalizeJudgeSwitches({ enabled: false, flags: { J1: false } })).toEqual({ enabled: false, router: false, flags: { ...ALL_OFF } });
    // Not a boolean → the default, like a missing field.
    expect(normalizeJudgeSwitches({ enabled: 'yes', router: 1, flags: { J1: 'no' } })).toEqual(DEFAULT_JUDGE_SWITCHES);
  });

  it('one-time migration: a 5b all-off judge block gets enabled + J1 once, recorded in `migrations`', () => {
    const { config, notices } = migrateConfig(stage5bConfig());
    expect(config.judge).toEqual({ enabled: true, router: false, flags: { ...ALL_OFF, J1: true } });
    expect(config.migrations).toContain(CONFIG_MIGRATION_D32);
    expect(notices).toEqual([]);
    // Recorded + the user turned them off → stays off.
    const off = migrateConfig({ ...stage5bConfig(), migrations: [CONFIG_MIGRATION_D32] });
    expect(off.config.judge).toEqual({ enabled: false, router: false, flags: { ...ALL_OFF } });
    // The migration never touches the router or J2–J8.
    const mixed = migrateConfig({ ...stage5bConfig(), judge: { enabled: false, router: true, flags: { ...ALL_OFF, J7: true } } });
    expect(mixed.config.judge).toEqual({ enabled: true, router: true, flags: { ...ALL_OFF, J1: true, J7: true } });
  });

  it('fresh configs are already at D32 (marker present); unknown migration ids are kept', () => {
    expect(DEFAULT_CONFIG.migrations).toEqual([CONFIG_MIGRATION_D32]);
    expect(migrateConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG))).config).toEqual(DEFAULT_CONFIG);
    expect(migrateConfig({ ...stage5bConfig(), migrations: ['future-x', 7] }).config.migrations).toEqual(['future-x', CONFIG_MIGRATION_D32]);
  });

  it('round trip: a 5b config reads as J1 on; the user turns J1 off by PATCH; it never re-applies', async () => {
    await setup('d32-migration-roundtrip', { rawConfig: stage5bConfig() });
    expect((await readConfig()).judge.flags.J1).toBe(true);
    const got = (await (await getConfig(req('GET'), undefined as never)).json()) as ConfigResponse;
    expect(got.judge).toMatchObject({ enabled: true, flags: { J1: true } });
    const off = await patchConfigRoute(req('PATCH', { judge: { enabled: false, flags: { J1: false } } }), undefined as never);
    expect(off.status).toBe(200);
    const raw = JSON.parse(await fs.readFile(configFilePath(), 'utf8')) as { judge: { enabled: boolean; flags: { J1: boolean } }; migrations: string[] };
    expect(raw.judge.enabled).toBe(false);
    expect(raw.judge.flags.J1).toBe(false);
    expect(raw.migrations).toContain(CONFIG_MIGRATION_D32);
    expect((await readConfig()).judge).toMatchObject({ enabled: false, flags: { J1: false } });
    // An unrelated PATCH later keeps the user's choice.
    await patchConfigRoute(req('PATCH', { ui: { theme: 'dark' } }), undefined as never);
    expect((await readConfig()).judge).toMatchObject({ enabled: false, flags: { J1: false } });
  });

  it('J1 context only when Jev can answer: private / unknown project → null; public without a key → null; public + client → context', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', '');
    vi.stubEnv('MOCK_LLM', 'false');
    resetEnvCache();
    const s = await setup('d32-j1-usable');
    const config = await readConfig();
    expect(await usableJudgeContextFor(s, config, 'J1')).toBeNull();
    await patchProject(req('PATCH', { privacy: 'public' }), routeCtx({ slug: s }));
    expect(await usableJudgeContextFor(s, config, 'J1')).toBeNull();
    setJudgeClientOverride(new MockJudgeClient());
    expect(await usableJudgeContextFor(s, config, 'J1')).not.toBeNull();
    expect(await usableJudgeContextFor(s, { ...config, judge: { ...config.judge, flags: { ...config.judge.flags, J1: false } } }, 'J1')).toBeNull();
    // Private with the explicit source opt-in is allowed (D30).
    await patchProject(req('PATCH', { privacy: 'private', judgeSourceOptIn: true }), routeCtx({ slug: s }));
    expect(await usableJudgeContextFor(s, config, 'J1')).not.toBeNull();
  });

  it('cache-first: GET routes with the D32 defaults call neither Jev nor an LLM', async () => {
    const s = await setup('d32-get-spy');
    await patchProject(req('PATCH', { privacy: 'public' }), routeCtx({ slug: s }));
    const judge = new MockJudgeClient();
    setJudgeClientOverride(judge);
    const llmCall = vi.fn(async () => {
      throw new Error('a GET must not call the LLM');
    });
    setLlmClient({ provider: 'anthropic', call: llmCall } as unknown as LLMClient);
    const agent = new ScriptedAgentModel([]);
    setAgentModelOverride(agent);
    const before = judgeContextCount();
    await reportEstimate(req('GET'), routeCtx({ slug: s, name: 'react', from: '18.3.1', to: '19.0.0' }));
    await deepEstimate(req('GET'), routeCtx({ slug: s, name: 'react', from: '18.3.1', to: '19.0.0' }));
    await getConfig(req('GET'), undefined as never);
    expect(judgeContextCount()).toBe(before);
    expect(judge.requests).toHaveLength(0);
    expect(llmCall).not.toHaveBeenCalled();
    expect(agent.requests).toHaveLength(0);
  });
});
