/**
 * POST /api/projects/:slug/deep-reports/:name/:from/:to/refresh
 *
 * Runs the deep scan pipeline (L2 transitive + CVE delta), pre-computes the
 * peer-dep satisfaction array, then calls the LLM (or mock) for the L3 narrative.
 * On LLM failure, persists a deterministic-partial envelope per spec §11.9.
 * v2 Stage 4a.12: with `llm.reportEngine: 'agent'` (default) the narrative
 * comes from the bounded agent loop over the code graph and a run record is
 * written next to the envelope; `'v1'` keeps the single-shot call.
 *
 * Spec §7.6 + §11.6 + §11.9 + §11.11.
 */
import { addJevCoUpgrades, markJevCoUpgrades } from '@/lib/judge/apply';
import { judgeContextFor } from '@/lib/judge/factory';
import { NextResponse } from 'next/server';
import { withCsrf, type RouteCtx } from '@/lib/http/guards';
import { badRequest, notFound, internalError } from '@/lib/http/errors';
import { isValidParam, isValidVersionParam } from '@/lib/http/validate';
import { decodeAndValidatePackageName } from '@/lib/http/packageName';
import { findBySlug } from '@/lib/storage/projects';
import { deepReportFilePath, projectJsonPath } from '@/lib/paths';
import { readJson } from '@/lib/storage/atomic';
import { writeEnvelope } from '@/lib/storage/envelope';
import { getJobQueue } from '@/lib/jobs/queue';
import { runDeepScan } from '@/lib/scanners/deepScan';
import { runDeepUpdateReport } from '@/lib/llm/deepReportService';
import { computeCoUpgradeCandidates } from '@/lib/llm/coUpgrade';
import { getLlmClient, withLlmLimit } from '@/lib/llm/factory';
import { readConfig, reportEngineOf } from '@/lib/storage/config';
import { persistRunRecord, runAgentDeepReportJob } from '@/lib/agent/reportJobs';
import type { AgentRunRecord } from '@/lib/agent/runStore';
import { loadEnv } from '@/lib/config';
import { parseLockfile, detectLockfile } from '@/lib/scanners/lockfile';
import { findProjectDep } from '@/lib/projects/lookup';
import type { ProjectJson } from '@/lib/projects/add';
import type {
  CoUpgradeDep,
  DeepUpdateReportDetail,
  JobEnqueueResponse,
  ResolverCheckBlock,
  WritableDataSource
} from '@/lib/api-types';

export const POST = withCsrf<RouteCtx<{ slug: string; name: string; from: string; to: string }>>(async (req, ctx) => {
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

  // Parse the body for an optional `forceRefresh` flag (used by the FE when
  // user clicks "Regenerate" — bypasses L2 cache).
  let forceRefresh = false;
  try {
    if (req.headers.get('content-length') !== null && req.headers.get('content-length') !== '0') {
      const body = (await req.json()) as { forceRefresh?: boolean } | null;
      if (body !== null && typeof body === 'object' && body.forceRefresh === true) {
        forceRefresh = true;
      }
    }
  } catch {
    // No body / invalid JSON — proceed with default behavior.
  }

  const queue = getJobQueue();
  const result = await queue.enqueue({
    slug,
    kind: 'refresh:deep-report',
    resourceKey: `deep-reports:${slug}:${name}:${from}:${to}`,
    run: async (report, signal) => {
      report({ current: 0, total: 4, label: `${name} ${from} → ${to}`, phase: 'scan' });

      // ---------------------------------------------------------------------
      // 1. Resolve the lockfile (we need the full resolved set, not just direct
      //    deps). Phase 1 already computed lockfileStateHash; we re-parse to
      //    get the actual `resolvedPackages` array.
      // ---------------------------------------------------------------------
      const detected = await detectLockfile(project.path);
      if (detected === null) {
        throw new Error('Lockfile disappeared from target project.');
      }
      const lockfile = await parseLockfile(detected);

      // ---------------------------------------------------------------------
      // 2. Run the L2 deep scan (cached per lockfileStateHash).
      // ---------------------------------------------------------------------
      report({ current: 1, total: 4, label: 'Deep scan (L2)', phase: 'registry' });
      const deepScan = await runDeepScan({
        slug,
        projectPath: project.path,
        resolvedPackages: lockfile.resolvedPackages,
        lockfileStateHash: lockfile.lockfileStateHash,
        targetName: name,
        fromVersion: from,
        toVersion: to,
        forceRefresh,
        report: (p) => report(p),
        signal
      });

      // ---------------------------------------------------------------------
      // 3. Compute the deterministic [D] inputs we carry forward into the L3
      //    prompt: co-upgrade candidates + resolver summary string + co-upgrade
      //    dep names. Resolver itself is NOT re-run here — it's a [D] concern.
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
      // v2 Stage 5b J5: Jev "usually upgraded together" suggestions on top (flag off → unchanged).
      const j5 = await addJevCoUpgrades(await judgeContextFor(slug, await readConfig(), 'J5', signal), {
        target: name,
        from,
        to,
        directDeps: project.dependencies.map((d) => ({ name: d.name, installedVersion: d.installedVersion })),
        coUpgrade: coUpgradeBase
      });
      const coUpgrade = j5.coUpgrade;
      const coUpgradeDeps: CoUpgradeDep[] = coUpgrade.candidates.map((c) => ({
        name: c.name,
        currentVersion: c.currentVersion ?? 'unknown',
        suggestedVersion: '',
        required:
          (coUpgrade.sources[c.name] ?? []).includes('peer-dep') ||
          (coUpgrade.sources[c.name] ?? []).includes('peer-range-conflict'),
        reason: 'peer-dep',
        explanation: ''
      }));

      // For now we carry resolverBlock as "kill-switch off → disabled banner"
      // unless the project already has the legacy-peer-deps flag (which we
      // don't re-validate here). The full resolver runs on [D]; [D-Deep]
      // can be regenerated independently and links back to the [D] resolver
      // result if the user has run [D] first. v1 keeps these decoupled.
      const config = await readConfig();
      const resolverBlock: ResolverCheckBlock = config.features.resolverCheckEnabled
        ? project.packageManager === 'npm'
          ? { kind: 'disabled', reason: 'failure', failureMessage: 'Run [D] first to see resolver result.' }
          : { kind: 'disabled', reason: 'yarn' }
        : { kind: 'disabled', reason: 'kill-switch' };

      report({ current: 2, total: 4, label: 'Calling LLM', phase: 'ai' });

      // ---------------------------------------------------------------------
      // 4. L3: AI narrative — the agent loop over the code graph (v2 Stage
      //    4a.12, default) or the v1 single-shot call (`llm.reportEngine: v1`).
      // ---------------------------------------------------------------------
      const hashShort = lockfile.lockfileStateHash.slice(0, 5);
      const deepInput = {
        fromVersion: from,
        toVersion: to,
        lockfileStateHashShort: hashShort,
        resolverBlock,
        coUpgradeDeps,
        lockfileSummary: deepScan.lockfileSummary,
        transitiveDelta: deepScan.transitiveDelta,
        cveDelta: deepScan.cveDelta,
        promptInput: {
          dep: { name, fromVersion: from, toVersion: to },
          lockfileSummary: deepScan.lockfileSummary,
          transitiveDelta: deepScan.transitiveDelta,
          cveDelta: deepScan.cveDelta,
          resolverCheckSummary: null,
          coUpgradeNames: coUpgrade.candidates.map((c) => c.name)
        }
      };
      let run: { source: WritableDataSource; detail: DeepUpdateReportDetail };
      let agentRecord: AgentRunRecord | null = null;
      if (reportEngineOf(config.llm.reportEngine) === 'agent') {
        const agentRun = await runAgentDeepReportJob({ slug, projectRoot: project.path, config, report, signal }, deepInput);
        run = agentRun;
        agentRecord = agentRun.record;
      } else {
        const client = await getLlmClient();
        const env = loadEnv();
        run = await withLlmLimit(client.provider, () =>
          runDeepUpdateReport(client, {
            ...deepInput,
            model: config.llm.model,
            maxInputTokens: env.budgets.deepReport.input,
            maxOutputTokens: env.budgets.deepReport.output,
            onPhase: (phaseEvent) => {
              report({
                current: 3,
                total: 4,
                label: phaseEvent.message,
                phase: 'ai',
                attempt: phaseEvent.attempt,
                maxAttempts: phaseEvent.maxAttempts
              });
            },
            signal
          })
        );
      }

      run = { ...run, detail: markJevCoUpgrades(run.detail, j5.suggested) };

      // ---------------------------------------------------------------------
      // 5. Persist envelope with lockfile-state hash suffix (+ agent run record).
      // ---------------------------------------------------------------------
      const reportFile = deepReportFilePath(slug, name, from, to, hashShort);
      await writeEnvelope<DeepUpdateReportDetail>(reportFile, {
        source: run.source,
        ttlHours: null, // Deep reports never auto-expire; only on lockfile change.
        data: run.detail
      });
      if (agentRecord !== null) await persistRunRecord(slug, agentRecord, reportFile);

      report({ current: 4, total: 4, label: 'Done', phase: 'ai' });

      return {
        resultUrl: `/api/projects/${slug}/deep-reports/${encodeURIComponent(name)}/${encodeURIComponent(from)}/${encodeURIComponent(to)}`
      };
    }
  });

  return NextResponse.json<JobEnqueueResponse>(
    { jobId: result.jobId, alreadyRunning: result.alreadyRunning },
    { status: result.alreadyRunning ? 200 : 202 }
  );
});
