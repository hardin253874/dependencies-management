/**
 * Typed API client for the local backend. Spec §9.
 *
 * Responsibilities:
 *   - Single place that prepends `/api`.
 *   - Single place that attaches `X-Local-Token` (CSRF) on mutating requests (spec §9.4).
 *   - Unwraps the spec §9.5 error envelope into a typed exception.
 *
 * Stage 1 contract: the only state the client owns is the CSRF token cache. Routing,
 * cache-first reads, etc. live in the React Query / state layer above.
 */

import type {
  ApiErrorEnvelope,
  AddProjectRequest,
  AddProjectResponse,
  ApiKeySetRequest,
  ApiKeyTestResponse,
  CachePruneResponse,
  ConfigPatch,
  ConfigResponse,
  CostSummaryResponse,
  CsrfResponse,
  DeepReportEstimateResponse,
  DeepUpdateReportDetail,
  DepDetail,
  FileEnvelope,
  FileReviewDetail,
  FsListResponse,
  FsValidationResponse,
  JobEnqueueResponse,
  JobRecord,
  JobsListWithOrphansResponse,
  LibrarySizeResponse,
  LogsClearResponse,
  OpenInExplorerResponse,
  CveImpactDetail,
  CveImpactEnqueueResponse,
  CveImpactEstimateResponse,
  ProjectDetail,
  ProjectSummary,
  RefreshResponse,
  RelatedUpgradeDetail,
  RelatedUpgradeEnqueueResponse,
  RelatedUsageEnqueueResponse,
  RelocateRequest,
  UpdateReportDetail,
  UsageDetail,
  VersionDetail
} from '@/lib/api-types';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CSRF_HEADER = 'X-Local-Token';

/**
 * Poll cadence for `awaitJob`. 2 seconds is a comfortable balance for a
 * local-only tool: barely visible end-of-job latency, negligible request
 * cost (in-memory GET on localhost).
 */
const AWAIT_JOB_POLL_INTERVAL_MS = 2000;
/**
 * Hard cap on how long `awaitJob` will wait before giving up. The Deep
 * Update Report is the longest stage (L2 transitive + L3 narrative); spec
 * §15 A.2 #11 sets a 5-minute soft target for first-time deep on a typical
 * legacy project. 15 minutes is a generous ceiling that surfaces a clear
 * timeout error rather than spinning forever.
 */
const AWAIT_JOB_MAX_DURATION_MS = 15 * 60 * 1000;

function makeAbortError(): Error {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Sleep for `ms` milliseconds, but bail out early if `signal` aborts.
 * Resolves cleanly when the signal aborts so the caller's own abort check
 * runs at the top of the next iteration (rather than throwing from sleep).
 */
function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(status: number, code: string, message: string, retryable = false) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

/** Optional per-request settings; AbortController support per Stage 2 carry-over. */
export interface ApiRequestOptions {
  signal?: AbortSignal;
}

export interface ApiClientOptions {
  /** Override base URL — defaults to '' (same origin). Used in tests. */
  baseUrl?: string;
  /** Override fetch — used in tests. */
  fetcher?: typeof fetch;
  /** Pre-seeded CSRF token (useful in tests). */
  csrfToken?: string;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private csrfTokenPromise: Promise<string> | null = null;
  private csrfTokenCache: string | null;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? '';
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.csrfTokenCache = options.csrfToken ?? null;
  }

  /** Fetch (and cache) the CSRF token from the backend at boot. (spec §9.4) */
  async getCsrfToken(): Promise<string> {
    if (this.csrfTokenCache) return this.csrfTokenCache;
    if (!this.csrfTokenPromise) {
      this.csrfTokenPromise = this.requestRaw<CsrfResponse>('GET', '/api/csrf').then(
        (res) => {
          this.csrfTokenCache = res.token;
          return res.token;
        }
      );
    }
    return this.csrfTokenPromise;
  }

  /** Force-refresh the cached token (e.g., after a server restart). */
  resetCsrfToken(): void {
    this.csrfTokenCache = null;
    this.csrfTokenPromise = null;
  }

  // ===== Projects =====

  listProjects(): Promise<{ projects: ProjectSummary[] }> {
    return this.request('GET', '/api/projects');
  }

  addProject(body: AddProjectRequest): Promise<AddProjectResponse> {
    return this.request('POST', '/api/projects', body);
  }

  async deleteProject(slug: string, alsoDeleteData = false): Promise<void> {
    const qs = alsoDeleteData ? '?deleteData=true' : '';
    await this.request<void>('DELETE', `/api/projects/${encodeURIComponent(slug)}${qs}`);
  }

  /**
   * Phase-1 sync refresh (re-read package.json + lockfile). Returns RefreshResponse;
   * `jobId` is typically null because Phase-1 is synchronous (<1s) per spec §9.3.
   */
  refreshProject(slug: string): Promise<RefreshResponse> {
    return this.request('POST', `/api/projects/${encodeURIComponent(slug)}/refresh`);
  }

  /**
   * Trigger a full Phase 2 scan: re-fetch every direct dep's npm-registry
   * packument + OSV CVE record + write each `deps/<name>.json` cache. Returns
   * a `JobEnqueueResponse`; the caller `awaitJob`s for completion. Used by
   * view [A]'s "Re-scan all deps" button to refresh sibling caches so the
   * "Related deps in this project" computation sees fresh `latestEngines` /
   * `latestPeerDeps` on every dep.
   */
  scanProject(slug: string, options?: ApiRequestOptions): Promise<JobEnqueueResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(slug)}/scan`,
      undefined,
      options
    );
  }

  relocateProject(slug: string, body: RelocateRequest): Promise<ProjectSummary> {
    return this.request('PATCH', `/api/projects/${encodeURIComponent(slug)}/relocate`, body);
  }

  getProjectDetail(slug: string): Promise<ProjectDetail> {
    return this.request('GET', `/api/projects/${encodeURIComponent(slug)}/dependencies`);
  }

  // ===== Per-view reads + refreshes (Stage 2 deterministic views) =====
  //
  // Spec §9.3: GETs may 404 NOT_CACHED if the view hasn't been generated yet;
  // POSTs enqueue background jobs. Per-view envelopes wrap §8.7 payloads.

  getDepDetail(slug: string, name: string, options?: ApiRequestOptions): Promise<FileEnvelope<DepDetail>> {
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(slug)}/deps/${encodeURIComponent(name)}`,
      undefined,
      options
    );
  }

  refreshDepDetail(
    slug: string,
    name: string,
    options?: ApiRequestOptions
  ): Promise<JobEnqueueResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(slug)}/deps/${encodeURIComponent(name)}/refresh`,
      undefined,
      options
    );
  }

  /**
   * Cache-first read for view [A]'s "CVE impact analysis" section. Returns
   * the most-recently-persisted envelope for `(name, installedVersion)` or
   * 404 NOT_CACHED so the FE renders the "Analyze Usage" CTA.
   */
  getCveImpact(
    slug: string,
    name: string,
    options?: ApiRequestOptions
  ): Promise<FileEnvelope<CveImpactDetail>> {
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(slug)}/deps/${encodeURIComponent(name)}/cve-impact`,
      undefined,
      options
    );
  }

  /**
   * Pre-flight cost estimate for the "Analyze Usage" confirmation modal.
   * Returns cveCount + filesInUsage + estimated tokens + USD cost using the
   * active LLM model. When `usageCacheExists === false`, the FE warns the
   * user that the cascade will run a usage scan first.
   */
  getCveImpactCostEstimate(
    slug: string,
    name: string,
    options?: ApiRequestOptions
  ): Promise<CveImpactEstimateResponse> {
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(slug)}/deps/${encodeURIComponent(name)}/cve-impact/cost-estimate`,
      undefined,
      options
    );
  }

  /**
   * Trigger the CVE impact analysis job. Cascades through:
   *   1. Usage scan if the usage cache is missing.
   *   2. Import + use-site context extraction.
   *   3. One batched LLM call.
   * Persists `library/<slug>/cve-impact/<name>/<version>.json`. Caller
   * `awaitJob`s for completion, then GETs to render.
   */
  refreshCveImpact(
    slug: string,
    name: string,
    options?: ApiRequestOptions
  ): Promise<CveImpactEnqueueResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(slug)}/deps/${encodeURIComponent(name)}/cve-impact/refresh`,
      undefined,
      options
    );
  }

  getVersionDetail(
    slug: string,
    name: string,
    version: string,
    options?: ApiRequestOptions
  ): Promise<FileEnvelope<VersionDetail>> {
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(slug)}/versions/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
      undefined,
      options
    );
  }

  refreshVersionDetail(
    slug: string,
    name: string,
    version: string,
    options?: ApiRequestOptions
  ): Promise<JobEnqueueResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(slug)}/versions/${encodeURIComponent(name)}/${encodeURIComponent(version)}/refresh`,
      undefined,
      options
    );
  }

  /**
   * Cache-first read for view [B]'s "Related deps upgrade analysis" section.
   * Returns the most recently persisted envelope for this `(name, version)`
   * target, or 404 NOT_CACHED so the FE can render the "Analyze related
   * deps" CTA.
   */
  getRelatedUpgrade(
    slug: string,
    name: string,
    version: string,
    options?: ApiRequestOptions
  ): Promise<FileEnvelope<RelatedUpgradeDetail>> {
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(slug)}/versions/${encodeURIComponent(name)}/${encodeURIComponent(version)}/related-upgrade`,
      undefined,
      options
    );
  }

  /**
   * Enqueue a related-deps upgrade analysis job. The job runs the
   * deterministic compatibility check + one batched LLM call and writes the
   * envelope at `library/<slug>/related-upgrade/<name>/<from>__<to>.json`.
   * Caller `awaitJob`s for completion, then GETs to render.
   */
  refreshRelatedUpgrade(
    slug: string,
    name: string,
    version: string,
    options?: ApiRequestOptions
  ): Promise<RelatedUpgradeEnqueueResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(slug)}/versions/${encodeURIComponent(name)}/${encodeURIComponent(version)}/related-upgrade/refresh`,
      undefined,
      options
    );
  }

  getUsageDetail(
    slug: string,
    name: string,
    options?: ApiRequestOptions
  ): Promise<FileEnvelope<UsageDetail>> {
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(slug)}/usage/${encodeURIComponent(name)}`,
      undefined,
      options
    );
  }

  refreshUsageDetail(
    slug: string,
    name: string,
    options?: ApiRequestOptions
  ): Promise<JobEnqueueResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(slug)}/usage/${encodeURIComponent(name)}/refresh`,
      undefined,
      options
    );
  }

  /**
   * Batch usage refresh for every related dep of `:name`. Enqueues a single
   * `scanCode` job that writes a usage envelope for each related dep —
   * the cheap way to fan out usage detection for view [C]'s related-deps
   * section. Returns the list of dep names being scanned so the caller can
   * `getUsageDetail(...)` each in parallel after the job completes.
   */
  refreshRelatedDepsUsage(
    slug: string,
    name: string,
    options?: ApiRequestOptions
  ): Promise<RelatedUsageEnqueueResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(slug)}/usage/related/${encodeURIComponent(name)}/refresh`,
      undefined,
      options
    );
  }

  // ===== Per-view AI reads + refreshes (Stage 3 views [D] + [E]) =====
  //
  // Spec §9.3: same cache-first contract — GET may 404 NOT_CACHED, POST
  // enqueues a background job that streams via SSE. UI shows status text only,
  // never partial JSON (§11.8).

  getUpdateReport(
    slug: string,
    name: string,
    from: string,
    to: string,
    options?: ApiRequestOptions
  ): Promise<FileEnvelope<UpdateReportDetail>> {
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(slug)}/reports/${encodeURIComponent(name)}/${encodeURIComponent(from)}/${encodeURIComponent(to)}`,
      undefined,
      options
    );
  }

  refreshUpdateReport(
    slug: string,
    name: string,
    from: string,
    to: string,
    options?: ApiRequestOptions
  ): Promise<JobEnqueueResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(slug)}/reports/${encodeURIComponent(name)}/${encodeURIComponent(from)}/${encodeURIComponent(to)}/refresh`,
      undefined,
      options
    );
  }

  getFileReview(
    slug: string,
    name: string,
    pathHash: string,
    options?: ApiRequestOptions
  ): Promise<FileEnvelope<FileReviewDetail>> {
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(slug)}/file-reviews/${encodeURIComponent(name)}/${encodeURIComponent(pathHash)}`,
      undefined,
      options
    );
  }

  refreshFileReview(
    slug: string,
    name: string,
    pathHash: string,
    options?: ApiRequestOptions
  ): Promise<JobEnqueueResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(slug)}/file-reviews/${encodeURIComponent(name)}/${encodeURIComponent(pathHash)}/refresh`,
      undefined,
      options
    );
  }

  // ===== Stage 4 — View [D-Deep] Deep Update Report =====
  //
  // Spec §11.6 + Appendix A.4. L2 transitive fetch + L3 AI narrative.
  // GET is cache-first (may 404 NOT_CACHED); POST runs L2 + L3.

  getDeepUpdateReport(
    slug: string,
    name: string,
    from: string,
    to: string,
    options?: ApiRequestOptions
  ): Promise<FileEnvelope<DeepUpdateReportDetail>> {
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(slug)}/deep-reports/${encodeURIComponent(name)}/${encodeURIComponent(from)}/${encodeURIComponent(to)}`,
      undefined,
      options
    );
  }

  refreshDeepUpdateReport(
    slug: string,
    name: string,
    from: string,
    to: string,
    options?: ApiRequestOptions
  ): Promise<JobEnqueueResponse> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(slug)}/deep-reports/${encodeURIComponent(name)}/${encodeURIComponent(from)}/${encodeURIComponent(to)}/refresh`,
      undefined,
      options
    );
  }

  /**
   * Pre-flight cost estimate for the first-Deep-Analyze confirmation prompt
   * (Wireframe 29). Returns total packages + estimated input/output tokens +
   * estimated USD cost (BE owns the shape — see `DeepReportEstimateResponse`).
   */
  getDeepReportCostEstimate(
    slug: string,
    name: string,
    from: string,
    to: string,
    options?: ApiRequestOptions
  ): Promise<DeepReportEstimateResponse> {
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(slug)}/deep-reports/${encodeURIComponent(name)}/${encodeURIComponent(from)}/${encodeURIComponent(to)}/cost-estimate`,
      undefined,
      options
    );
  }

  /**
   * Per-project cost summary (Settings → Cost panel). BE rolls up cached AI
   * envelopes for the given slug.
   */
  getCostSummaryForProject(
    slug: string,
    options?: ApiRequestOptions
  ): Promise<CostSummaryResponse> {
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(slug)}/cost`,
      undefined,
      options
    );
  }

  // ===== Stage 4 — Downloads (MD / HTML export for [D] and [D-Deep]) =====
  //
  // Returns the raw response so the caller can read .text() or build a Blob
  // URL. Throws `ApiError` with code `NOT_CACHED` on 404 so the UI can render
  // the "Generate the report first" message.

  async downloadUpdateReport(
    slug: string,
    name: string,
    from: string,
    to: string,
    format: 'md' | 'html',
    options?: ApiRequestOptions
  ): Promise<{ filename: string; mimeType: string; body: string }> {
    return this.downloadInternal(
      `/api/projects/${encodeURIComponent(slug)}/reports/${encodeURIComponent(name)}/${encodeURIComponent(from)}/${encodeURIComponent(to)}/download?format=${format}`,
      `${name}-${from}-${to}.${format}`,
      format,
      options
    );
  }

  async downloadDeepUpdateReport(
    slug: string,
    name: string,
    from: string,
    to: string,
    format: 'md' | 'html',
    options?: ApiRequestOptions
  ): Promise<{ filename: string; mimeType: string; body: string }> {
    return this.downloadInternal(
      `/api/projects/${encodeURIComponent(slug)}/deep-reports/${encodeURIComponent(name)}/${encodeURIComponent(from)}/${encodeURIComponent(to)}/download?format=${format}`,
      `${name}-${from}-${to}-deep.${format}`,
      format,
      options
    );
  }

  private async downloadInternal(
    path: string,
    fallbackFilename: string,
    format: 'md' | 'html',
    options?: ApiRequestOptions
  ): Promise<{ filename: string; mimeType: string; body: string }> {
    const res = await this.fetcher(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: { Accept: format === 'md' ? 'text/markdown' : 'text/html' },
      signal: options?.signal
    });
    if (!res.ok) {
      // Try to surface a typed error code for 404 NOT_CACHED.
      let code = 'UNKNOWN';
      let message = res.statusText || 'Download failed';
      const ct = res.headers.get('content-type') ?? '';
      if (ct.includes('application/json')) {
        const parsed = (await res.json().catch(() => null)) as ApiErrorEnvelope | null;
        if (parsed?.error) {
          code = parsed.error.code;
          message = parsed.error.message;
        }
      }
      throw new ApiError(res.status, code, message, false);
    }
    const body = await res.text();
    const cd = res.headers.get('content-disposition') ?? '';
    const m = cd.match(/filename="?([^";]+)"?/i);
    const filename = m?.[1] ?? fallbackFilename;
    const mimeType =
      res.headers.get('content-type') ??
      (format === 'md' ? 'text/markdown' : 'text/html');
    return { filename, mimeType, body };
  }

  // ===== Stage 4 — Settings → Library / Cache / Cost =====

  getLibrarySize(options?: ApiRequestOptions): Promise<LibrarySizeResponse> {
    return this.request('GET', '/api/library/size', undefined, options);
  }

  /** Best-effort "Open in file explorer" — BE returns ok or a friendly message. */
  openInExplorer(
    pathToOpen: string,
    options?: ApiRequestOptions
  ): Promise<OpenInExplorerResponse> {
    return this.request('POST', '/api/library/open', { path: pathToOpen }, options);
  }

  pruneCache(
    olderThanDays: number,
    dryRun: boolean,
    options?: ApiRequestOptions
  ): Promise<CachePruneResponse> {
    const qs = `?olderThanDays=${olderThanDays}&dryRun=${dryRun ? 'true' : 'false'}`;
    return this.request('POST', `/api/cache/prune${qs}`, undefined, options);
  }

  clearLogs(options?: ApiRequestOptions): Promise<LogsClearResponse> {
    return this.request('POST', '/api/logs/clear', undefined, options);
  }

  // ===== Filesystem picker =====

  listFs(path: string, options?: ApiRequestOptions): Promise<FsListResponse> {
    return this.request(
      'GET',
      `/api/fs/list?path=${encodeURIComponent(path)}`,
      undefined,
      options
    );
  }

  validateFs(path: string, options?: ApiRequestOptions): Promise<FsValidationResponse> {
    return this.request(
      'GET',
      `/api/fs/validate?path=${encodeURIComponent(path)}`,
      undefined,
      options
    );
  }

  // ===== Config =====

  getConfig(): Promise<ConfigResponse> {
    return this.request('GET', '/api/config');
  }

  patchConfig(patch: ConfigPatch): Promise<ConfigResponse> {
    return this.request('PATCH', '/api/config', patch);
  }

  setApiKey(body: ApiKeySetRequest): Promise<{ ok: true }> {
    return this.request('POST', '/api/config/api-key', body);
  }

  testApiKey(body: ApiKeySetRequest): Promise<ApiKeyTestResponse> {
    return this.request('POST', '/api/config/api-key/test', body);
  }

  // ===== Jobs =====

  /**
   * Returns both live jobs and orphan-journal entries from prior crashes.
   * Stage 2 carry-over M3: the orphan banner consumes the `orphans` array
   * to render the "Previous job interrupted — Re-run / Discard" UI.
   */
  listJobs(): Promise<JobsListWithOrphansResponse> {
    return this.request('GET', '/api/jobs');
  }

  /**
   * Single-job state snapshot. Source of truth for "is the job done yet?" —
   * polled by `awaitJob` because SSE stream lifecycle (closure on terminal
   * state, transient reconnects on long-lived connections) makes the live
   * tail unreliable as a `done`-signal carrier.
   */
  getJob(jobId: string, options?: ApiRequestOptions): Promise<JobRecord> {
    return this.request('GET', `/api/jobs/${encodeURIComponent(jobId)}`, undefined, options);
  }

  async cancelJob(jobId: string): Promise<void> {
    await this.request<void>('DELETE', `/api/jobs/${encodeURIComponent(jobId)}`);
  }

  /** Discard a stale orphan journal entry (left-panel "Discard" button). */
  async discardOrphan(slug: string, jobId: string): Promise<void> {
    await this.request<void>(
      'DELETE',
      `/api/jobs/orphans/${encodeURIComponent(slug)}/${encodeURIComponent(jobId)}`
    );
  }

  /** Build the SSE URL for `EventSource` consumption (spec §9.3 jobs). */
  jobEventsUrl(jobId: string): string {
    return `${this.baseUrl}/api/jobs/${encodeURIComponent(jobId)}/events`;
  }

  /**
   * Await a background job to completion by **polling** `GET /api/jobs/:jobId`
   * every {@link AWAIT_JOB_POLL_INTERVAL_MS} milliseconds until the job
   * record reaches a terminal state.
   *
   * Why polling instead of the SSE stream:
   *   1. The SSE handler closes the stream when the job reaches a terminal
   *      state (`done` / `error` / `cancelled`). Browsers surface that
   *      close as an `error` event on the `EventSource`, racing with the
   *      `done` event delivery — for long-running jobs the race often
   *      lands on `error` first, even though the job succeeded.
   *   2. Long-lived SSE connections can be interrupted by dev-server
   *      idle timeouts, OS-level connection limits, or proxies, all of
   *      which surface as transient `error` events (with
   *      `readyState === CONNECTING`). The browser auto-reconnects, but
   *      a handler that rejects on any `error` would teardown prematurely.
   *   3. The GET endpoint is in-memory + cheap; one request every 2s is
   *      free for a localhost tool.
   *
   * SSE continues to power the StatusBar's live progress display — that
   * use-case tolerates transient errors via auto-reconnect. This method is
   * specifically for the right-panel "wait for done" gate.
   *
   * Caller can pass an AbortSignal to cancel waiting (e.g. on unmount or
   * when the user switches projects/deps mid-job). The poll loop checks the
   * signal between iterations and rejects with `AbortError`.
   */
  async awaitJob(jobId: string, options?: ApiRequestOptions): Promise<void> {
    const startedAt = Date.now();
    while (true) {
      if (options?.signal?.aborted) {
        throw makeAbortError();
      }
      let record: JobRecord;
      try {
        record = await this.getJob(jobId, options);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'JOB_NOT_FOUND') {
          // Job records persist in memory for the lifetime of the server, so
          // a 404 here typically means the server restarted mid-wait. Treat
          // as a soft failure — caller can decide to retry.
          throw new Error('Job no longer tracked by the server (server may have restarted).');
        }
        throw err;
      }
      if (record.state === 'done') return;
      if (record.state === 'error') {
        throw new Error(record.error?.message ?? 'Job failed');
      }
      if (record.state === 'cancelled') {
        throw new Error('Job cancelled');
      }
      if (Date.now() - startedAt > AWAIT_JOB_MAX_DURATION_MS) {
        throw new Error('Job timeout — still running after 15 minutes.');
      }
      await sleepWithAbort(AWAIT_JOB_POLL_INTERVAL_MS, options?.signal);
    }
  }

  // ===== Core request plumbing =====

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: ApiRequestOptions
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json'
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    if (MUTATING_METHODS.has(method)) {
      headers[CSRF_HEADER] = await this.getCsrfToken();
    }

    return this.requestRaw<T>(method, path, headers, body, options);
  }

  private async requestRaw<T>(
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: unknown,
    options?: ApiRequestOptions
  ): Promise<T> {
    const res = await this.fetcher(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: options?.signal
    });

    if (res.status === 204) {
      return undefined as T;
    }

    const contentType = res.headers.get('content-type') ?? '';
    const isJson = contentType.includes('application/json');

    if (!res.ok) {
      let code = 'UNKNOWN';
      let message = res.statusText || 'Request failed';
      let retryable = false;
      if (isJson) {
        const parsed = (await res.json().catch(() => null)) as ApiErrorEnvelope | null;
        if (parsed?.error) {
          code = parsed.error.code;
          message = parsed.error.message;
          retryable = parsed.error.retryable ?? false;
        }
      }
      throw new ApiError(res.status, code, message, retryable);
    }

    if (!isJson) {
      return undefined as T;
    }
    return (await res.json()) as T;
  }
}

let defaultClient: ApiClient | null = null;

/** Singleton for in-app consumption. Tests should create their own ApiClient. */
export function getApiClient(): ApiClient {
  if (!defaultClient) {
    defaultClient = new ApiClient();
  }
  return defaultClient;
}

/** For tests only — replace the singleton. */
export function setApiClient(client: ApiClient | null): void {
  defaultClient = client;
}
