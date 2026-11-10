/**
 * POST /api/projects/:slug/reports/:name/:from/:to/refresh — view [D] regenerate.
 *
 * Steps (spec §11 + §10.7):
 *  1. Validate slug / name / from / to.
 *  2. Read project.json, locate the dep.
 *  3. Read `_config.json` (fresh; spec §5.4 — kill-switch may have flipped).
 *  4. Compute co-upgrade candidates (deterministic).
 *  5. Decide resolver-check policy:
 *      - kill-switch off  → disabled banner (kill-switch)
 *      - yarn project     → disabled banner (yarn)
 *      - otherwise        → run `runResolverCheck` in TempSandbox
 *  6. Optionally load the cached usage payload for affectedFiles input (lazy:
 *     missing cache means the prompt sees an empty list, not a regen).
 *  7. `llm.reportEngine` = `agent` (default, v2 Stage 4a.12): refresh the code
 *     graph and run the bounded agent loop (`runAgentUpdateReportJob`); `v1`:
 *     call `runUpdateReport` (both mocked when MOCK_LLM=true).
 *  8. Persist envelope to `library/<slug>/reports/<name>/<from>__<to>.json`
 *     (agent: plus the run record under `library/<slug>/runs/`).
 *
 * Returns `JobEnqueueResponse` with a 202 (or 200 when dedupe hits).
 */
import { addJevCoUpgrades, applyReportEvidenceCheck, markJevCoUpgrades, reportEvidenceAllowedFiles } from '@/lib/judge/apply';
import { judgeContextFor } from '@/lib/judge/factory';
import { NextResponse } from 'next/server';
import { withCsrf, type RouteCtx } from '@/lib/http/guards';
import { badRequest, notFound, internalError } from '@/lib/http/errors';
import { isValidParam, isValidVersionParam } from '@/lib/http/validate';
import { decodeAndValidatePackageName } from '@/lib/http/packageName';
import { findBySlug } from '@/lib/storage/projects';
import { projectJsonPath, reportFilePath, usageFilePath } from '@/lib/paths';
import { readJson, pathExists } from '@/lib/storage/atomic';
import { readEnvelope, writeEnvelope } from '@/lib/storage/envelope';
import { atomicWriteJson } from '@/lib/storage/atomic';
import { withProjectLock } from '@/lib/storage/projectLock';
import { getJobQueue } from '@/lib/jobs/queue';
import { runResolverCheck } from '@/lib/scanners/resolver';
import { computeCoUpgradeCandidates } from '@/lib/llm/coUpgrade';
import { runUpdateReport } from '@/lib/llm/reportService';
import { getLlmClient, withLlmLimit } from '@/lib/llm/factory';
import { readConfig, reportEngineOf } from '@/lib/storage/config';
import { estimateRouting, persistRunRecord, runAgentUpdateReportJob } from '@/lib/agent/reportJobs';
import type { AgentRunRecord } from '@/lib/agent/runStore';
import { loadEnv } from '@/lib/config';
import { findProjectDep } from '@/lib/projects/lookup';
import type {
  ResolverCheckBlock,
  UpdateReportDetail,
  UsageDetail,
  JobEnqueueResponse,
  WritableDataSource
} from '@/lib/api-types';
import type {
  AffectedFile,
  CoUpgradeCandidate,
  ResolverCheckInput
} from '@/lib/llm/prompts/update-report';
import type { ProjectJson } from '@/lib/projects/add';

export const POST = withCsrf<RouteCtx<{ slug: string; name: string; from: string; to: string }>>(async (_req, ctx) => {
  const params = await ctx.params;
  const { slug, from, to } = params;
  if (!isValidParam(slug)) return badRequest('INVALID_SLUG', 'Slug failed allowlist validation.');
  if (!isValidVersionParam(from)) return badRequest('INVALID_VERSION', '`from` failed allowlist validation.');
  if (!isValidVersionParam(to)) return badRequest('INVALID_VERSION', '`to` failed allowlist validation.');

  const name = decodeAndValidatePackageName(params.name);
  if (name === null) return badRequest('INVALID_PACKAGE_NAME', 'Package name failed allowlist validation.');

  const entry = await findBySlug(slug);
  if (entry === null) return notFound('PROJECT_NOT_FOUND', `No project with slug ${slug}.`);

  let project: ProjectJson;
  try {
    project = await readJson<ProjectJson>(projectJsonPath(slug));
  } catch (err) {
    return internalError('PROJECT_READ_FAILED', (err as Error).message);
  }

  const dep = findProjectDep(project, name);
  if (dep === null) {
    return notFound('DEP_NOT_FOUND', `${name} is not a direct dependency of ${slug}.`);
  }

  const queue = getJobQueue();
  const result = await queue.enqueue({
    slug,
    kind: 'refresh:report',
    resourceKey: `reports:${slug}:${name}:${from}:${to}`,
    run: async (report, signal) => {
      report({ current: 0, total: 3, label: `${name} ${from} → ${to}`, phase: 'resolver' });

      // ---------------------------------------------------------------------
      // Co-upgrade candidates (deterministic).
      // ---------------------------------------------------------------------
      const coUpgradeBase = computeCoUpgradeCandidates({
        targetName: name,
        toVersion: to,
        directDeps: project.dependencies.map((d) => ({
          name: d.name,
          installedVersion: d.installedVersion
        })),
        targetPeerDependenciesAtTo: undefined
      });

      // ---------------------------------------------------------------------
      // Resolver block (spec §10.7 + §11): kill-switch / yarn / actual run.
      // ---------------------------------------------------------------------
      const config = await readConfig();
      // v2 Stage 5b J5: Jev "usually upgraded together" suggestions on top (flag off → unchanged).
      const j5 = await addJevCoUpgrades(await judgeContextFor(slug, config, 'J5', signal), {
        target: name,
        from,
        to,
        directDeps: project.dependencies.map((d) => ({ name: d.name, installedVersion: d.installedVersion })),
        coUpgrade: coUpgradeBase
      });
      const coUpgrade = j5.coUpgrade;
      const resolverBlock = await buildResolverBlock({
        project,
        depName: name,
        toVersion: to,
        jobIdForSandbox: cryptoRandomJobSuffix(),
        killSwitchOff: !config.features.resolverCheckEnabled,
        legacyPeerDepsAlready: project.legacyPeerDeps
      });

      // If the resolver fired and required --legacy-peer-deps for the FIRST
      // time, persist that flag back to project.json so subsequent scans pick
      // it up. Wrapped in `withProjectLock` (Stage 3 M5): two concurrent
      // refreshes for the same slug must not race on the read-modify-write
      // — we re-read fresh inside the lock so the writer can't clobber an
      // independent concurrent update.
      if (resolverBlock.persistLegacy && !project.legacyPeerDeps) {
        await withProjectLock(slug, async () => {
          const fresh = await readJson<ProjectJson>(projectJsonPath(slug));
          if (fresh.legacyPeerDeps) return; // Another writer beat us; nothing to do.
          await atomicWriteJson(projectJsonPath(slug), { ...fresh, legacyPeerDeps: true });
        });
      }

      report({ current: 1, total: 3, label: 'Loading usage data', phase: 'scan' });

      // ---------------------------------------------------------------------
      // Affected files — best-effort from cached usage payload (if present).
      // ---------------------------------------------------------------------
      const affectedFiles = await loadAffectedFiles(slug, name);

      report({ current: 2, total: 3, label: 'Calling LLM', phase: 'ai' });

      const promptInput = {
        dep: {
          name,
          fromVersion: from,
          toVersion: to,
          releaseNotesBetween: null
        },
        resolverCheck: resolverBlock.llmInput,
        candidateCoUpgrades: coUpgrade.candidates,
        affectedFiles
      };
      const reportFile = reportFilePath(slug, name, from, to);

      // ---------------------------------------------------------------------
      // v2 Stage 4a.12: the agent loop over the code graph (default engine),
      // or the v1 single-shot call when `llm.reportEngine` is `v1`.
      // ---------------------------------------------------------------------
      let run: { source: WritableDataSource; detail: UpdateReportDetail };
      let agentRecord: AgentRunRecord | null = null;
      if (reportEngineOf(config.llm.reportEngine) === 'agent') {
        const agentRun = await runAgentUpdateReportJob(
          { slug, projectRoot: project.path, config, report, signal },
          { promptInput, resolverBlock: resolverBlock.block, fromVersion: from, toVersion: to, candidateSources: coUpgrade.sources }
        );
        run = agentRun;
        agentRecord = agentRun.record;
      } else {
        const client = await getLlmClient();
        const env = loadEnv();
        const routing = await estimateRouting({ view: 'update-report', slug, name, from, to, config, allowJudge: true, signal });
        run = await withLlmLimit(client.provider, () =>
          runUpdateReport(client, {
            model: routing?.model ?? config.llm.model,
            maxOutputTokens: env.budgets.updateReport.output,
            maxInputTokens: env.budgets.updateReport.input,
            resolverBlock: resolverBlock.block,
            fromVersion: from,
            toVersion: to,
            candidateSources: coUpgrade.sources,
            promptInput,
            onPhase: (phaseEvent) => {
              report({
                current: 2,
                total: 3,
                label: phaseEvent.message,
                phase: 'ai',
                attempt: phaseEvent.attempt,
                maxAttempts: phaseEvent.maxAttempts
              });
            },
            signal
          })
        );
        if (routing !== null) run = { ...run, detail: { ...run.detail, routing } };
      }

      // v2 Stage 5b J2 (evidence badges, never removes) + J5 labels. Flags off → detail unchanged.
      const j2 = await judgeContextFor(slug, config, 'J2', signal);
      // Only graph / usage files are read for J2 evidence; v1 `filesToModify` paths are raw LLM output (review 5b M1).
      const j2Allowed = j2 === null ? new Set<string>() : reportEvidenceAllowedFiles(slug, affectedFiles.map((f) => f.path));
      run = { ...run, detail: markJevCoUpgrades(await applyReportEvidenceCheck(j2, run.detail, { projectRoot: project.path, depName: name, allowedFiles: j2Allowed }), j5.suggested) };

      // ---------------------------------------------------------------------
      // Persist.
      // ---------------------------------------------------------------------
      await writeEnvelope<UpdateReportDetail>(reportFile, {
        source: run.source,
        // TTL: AI reports default to no-auto-expire (manual regenerate).
        ttlHours: null,
        data: run.detail
      });
      if (agentRecord !== null) await persistRunRecord(slug, agentRecord, reportFile);

      report({ current: 3, total: 3, label: 'Done', phase: 'ai' });

      return {
        resultUrl: `/api/projects/${slug}/reports/${encodeURIComponent(name)}/${encodeURIComponent(from)}/${encodeURIComponent(to)}`
      };
    }
  });

  return NextResponse.json<JobEnqueueResponse>(
    { jobId: result.jobId, alreadyRunning: result.alreadyRunning },
    { status: result.alreadyRunning ? 200 : 202 }
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ResolverDecision {
  block: ResolverCheckBlock;
  llmInput: ResolverCheckInput | null;
  /** When true and project.legacyPeerDeps was false, persist `true`. */
  persistLegacy: boolean;
}

async function buildResolverBlock(opts: {
  project: ProjectJson;
  depName: string;
  toVersion: string;
  jobIdForSandbox: string;
  killSwitchOff: boolean;
  legacyPeerDepsAlready: boolean;
}): Promise<ResolverDecision> {
  // Kill-switch off → disabled banner, no LLM resolver input.
  if (opts.killSwitchOff) {
    return {
      block: { kind: 'disabled', reason: 'kill-switch' },
      llmInput: null,
      persistLegacy: false
    };
  }
  // Yarn unsupported in v1 (§10.7).
  if (opts.project.packageManager !== 'npm') {
    return {
      block: { kind: 'disabled', reason: 'yarn' },
      llmInput: null,
      persistLegacy: false
    };
  }

  const result = await runResolverCheck({
    projectRoot: opts.project.path,
    depName: opts.depName,
    toVersion: opts.toVersion,
    jobId: opts.jobIdForSandbox,
    legacyPeerDepsAlready: opts.legacyPeerDepsAlready,
    voltaNpmBin: null
  });

  if (result.enabled) {
    const block: ResolverCheckBlock = {
      kind: 'enabled',
      wouldResolve: result.wouldResolve,
      conflicts: result.conflicts,
      legacyPeerDepsUsed: result.legacyPeerDepsUsed
    };
    const llmInput: ResolverCheckInput = {
      wouldResolve: result.wouldResolve,
      conflicts: result.conflicts,
      legacyPeerDepsUsed: result.legacyPeerDepsUsed
    };
    return {
      block,
      llmInput,
      persistLegacy: result.legacyPeerDepsUsed
    };
  }

  return {
    block: {
      kind: 'disabled',
      reason: 'failure',
      failureMessage: result.message
    },
    llmInput: null,
    persistLegacy: false
  };
}

async function loadAffectedFiles(slug: string, name: string): Promise<AffectedFile[]> {
  const fp = usageFilePath(slug, name);
  if (!(await pathExists(fp))) return [];
  try {
    const env = await readEnvelope<UsageDetail>(fp);
    return env.data.files.map((f) => ({
      path: f.path,
      importStatements: f.importStatements,
      importCount: f.importCount
    }));
  } catch {
    return [];
  }
}

function cryptoRandomJobSuffix(): string {
  // Cheap (no async crypto module needed here).
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Reference the type so the import isn't tree-shaken under strict TS.
void (null as unknown as CoUpgradeCandidate | undefined);
