/**
 * App wiring of the Jev judge (V2_STAGE5_SPEC 5b.2 / 5b.9): key, cache dir,
 * ledger path, project privacy lookup.
 *
 * - `MOCK_LLM=true` → `MockJudgeClient` over `test-fixtures/judge/<use>.json`.
 * - otherwise → `TypeSafeJudgeClient` with `TYPESAFE_API_KEY` from
 *   `loadEnv()`; no key → `client: null` (callers see "unavailable: no-key",
 *   never an error toast).
 * - The cache (`library/_judge`) and the Jev ledger gate
 *   (`library/_spend/jev-round1.json`, opened per operation) live on
 *   `globalThis` keyed by path (CLAUDE.md invariant #4; tests switch library
 *   roots, so a single instance would leak between sandboxes).
 * - Tests pin a client with `setJudgeClientOverride` and MUST reset it to
 *   `null` in `afterEach`.
 *
 * Only jobs and explicit user actions call `getJudgeContext`; a GET route
 * never does (spec §0.11, guarded by a spy test).
 */
import path from 'path';
import { Judge } from '@/core/judge/judge';
import { JudgeCache } from '@/core/judge/cache';
import { MockJudgeClient } from '@/core/judge/mock';
import { TypeSafeJudgeClient, type JudgeClient } from '@/core/judge/client';
import { jevLedgerPathApp, perOperationGate, type JevSpendGate } from '@/core/judge/ledger';
import { createJudgeBreaker, type JudgeContext } from '@/core/judge/uses';
import type { JudgeSubject, JudgeSwitches, JudgeUse } from '@/core/judge/types';
import { isUseSwitchedOn } from '@/core/judge/privacy';
import { loadEnv } from '../config';
import { getLibraryRoot, projectJsonPath } from '../paths';
import { readJson, pathExists } from '../storage/atomic';
import { readConfig, type AppConfig } from '../storage/config';
import { getLoggerSync } from '../logger';
import type { ProjectJson } from '../projects/add';

declare global {
  // eslint-disable-next-line no-var
  var __DEP_AGENT_JUDGE_CLIENT_OVERRIDE__: JudgeClient | undefined;
  // eslint-disable-next-line no-var
  var __DEP_AGENT_JUDGE_CACHES__: Map<string, JudgeCache> | undefined;
  // eslint-disable-next-line no-var
  var __DEP_AGENT_JEV_GATES__: Map<string, JevSpendGate> | undefined;
  // eslint-disable-next-line no-var
  var __DEP_AGENT_JUDGE_ASKS__: number | undefined;
}

export function setJudgeClientOverride(client: JudgeClient | null): void {
  globalThis.__DEP_AGENT_JUDGE_CLIENT_OVERRIDE__ = client ?? undefined;
}

/** Number of judge contexts handed out (test spy: a GET route must not take one). */
export function judgeContextCount(): number {
  return globalThis.__DEP_AGENT_JUDGE_ASKS__ ?? 0;
}

export function judgeFixtureDir(): string {
  return path.resolve(process.cwd(), 'test-fixtures', 'judge');
}

export function judgeCacheDir(): string {
  return path.join(getLibraryRoot(), '_judge');
}

function cacheFor(dir: string): JudgeCache {
  if (globalThis.__DEP_AGENT_JUDGE_CACHES__ === undefined) globalThis.__DEP_AGENT_JUDGE_CACHES__ = new Map();
  const m = globalThis.__DEP_AGENT_JUDGE_CACHES__;
  let c = m.get(dir);
  if (c === undefined) {
    c = new JudgeCache(dir);
    m.set(dir, c);
  }
  return c;
}

function gateFor(file: string): JevSpendGate {
  if (globalThis.__DEP_AGENT_JEV_GATES__ === undefined) globalThis.__DEP_AGENT_JEV_GATES__ = new Map();
  const m = globalThis.__DEP_AGENT_JEV_GATES__;
  let g = m.get(file);
  if (g === undefined) {
    g = perOperationGate(file, 'app');
    m.set(file, g);
  }
  return g;
}

function buildClient(): JudgeClient | null {
  const override = globalThis.__DEP_AGENT_JUDGE_CLIENT_OVERRIDE__;
  if (override !== undefined) return override;
  const env = loadEnv();
  if (env.mockLlm) return new MockJudgeClient({ fixtureDir: judgeFixtureDir() });
  if (env.typesafeApiKey === null) return null;
  return new TypeSafeJudgeClient({
    apiKey: env.typesafeApiKey,
    gate: gateFor(jevLedgerPathApp(getLibraryRoot())),
    log: { error: (fields, message) => getLoggerSync()?.warn(fields, message) }
  });
}

export function buildAppJudge(switches: JudgeSwitches): Judge {
  // Nothing on: no client is built at all (no key read, no ledger touched).
  if (!switches.enabled) return new Judge({ client: null, cache: null, switches });
  return new Judge({ client: buildClient(), cache: cacheFor(judgeCacheDir()), switches });
}

/** Privacy facts for a project from its `project.json` (missing file / field = unknown = private). */
export async function judgeSubjectFor(slug: string): Promise<JudgeSubject> {
  const fp = projectJsonPath(slug);
  if (!(await pathExists(fp))) return { privacy: undefined };
  const p = await readJson<ProjectJson>(fp);
  return {
    privacy: p.privacy === 'public' || p.privacy === 'private' ? p.privacy : undefined,
    judge: p.judge === 'off' ? 'off' : 'on',
    sourceOptIn: p.judgeSourceOptIn === true
  };
}

/** Judge + project subject for one user-triggered job. */
export async function getJudgeContext(slug: string, signal?: AbortSignal): Promise<JudgeContext> {
  globalThis.__DEP_AGENT_JUDGE_ASKS__ = (globalThis.__DEP_AGENT_JUDGE_ASKS__ ?? 0) + 1;
  const cfg = await readConfig();
  // A fresh breaker per context = per use per job: one Jev outage stops that use's loop (J7 across advisories too).
  return { judge: buildAppJudge(cfg.judge), subject: await judgeSubjectFor(slug), breaker: createJudgeBreaker(), ...(signal !== undefined ? { signal } : {}) };
}

/**
 * A judge context for ONE use inside a user-triggered job, or `null` when the
 * global switch or the use's switch is off (the call site then keeps today's
 * code path exactly; no project read, no client built).
 */
export async function judgeContextFor(slug: string, config: AppConfig, use: JudgeUse, signal?: AbortSignal): Promise<JudgeContext | null> {
  if (!isUseSwitchedOn(use, config.judge)) return null;
  return getJudgeContext(slug, signal);
}
