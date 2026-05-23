import { render, type RenderOptions } from '@testing-library/react';
import { vi } from 'vitest';
import { ApiClient, setApiClient } from '@/lib/client/api-client';
import { AppProvider } from '@/components/AppContext';
import type {
  CachePruneResponse,
  ConfigResponse,
  CostSummaryResponse,
  DeepReportEstimateResponse,
  DeepUpdateReportDetail,
  DepDetail,
  FileEnvelope,
  FileReviewDetail,
  JobsListWithOrphansResponse,
  LibrarySizeResponse,
  LogsClearResponse,
  OpenInExplorerResponse,
  ProjectDetail,
  ProjectSummary,
  UpdateReportDetail,
  UsageDetail,
  VersionDetail
} from '@/lib/api-types';

export interface FakeBackend {
  config: ConfigResponse;
  projects: ProjectSummary[];
  projectDetails?: Record<string, ProjectDetail>;
  jobs?: Partial<JobsListWithOrphansResponse>;
  /** Keyed by `<slug>::<name>`. */
  deps?: Record<string, FileEnvelope<DepDetail>>;
  /** Keyed by `<slug>::<name>::<version>`. */
  versions?: Record<string, FileEnvelope<VersionDetail>>;
  /** Keyed by `<slug>::<name>`. */
  usage?: Record<string, FileEnvelope<UsageDetail>>;
  /** Keyed by `<slug>::<name>::<from>::<to>` (Stage 3 View [D]). */
  reports?: Record<string, FileEnvelope<UpdateReportDetail>>;
  /** Keyed by `<slug>::<name>::<pathHash>` (Stage 3 View [E]). */
  fileReviews?: Record<string, FileEnvelope<FileReviewDetail>>;
  /** Keyed by `<slug>::<name>::<from>::<to>` (Stage 4 View [D-Deep]). */
  deepReports?: Record<string, FileEnvelope<DeepUpdateReportDetail>>;
  /** Keyed by `<slug>::<name>::<from>::<to>` (Stage 4 first-Deep cost prompt). */
  deepEstimates?: Record<string, DeepReportEstimateResponse>;
  /** Per-slug cost summary (Stage 4 Settings → Cost). */
  costSummaries?: Record<string, CostSummaryResponse>;
  /** Library size response for `GET /api/library/size`. */
  librarySize?: LibrarySizeResponse;
  /** `POST /api/library/open` response. Falsy → 404 (BE not yet implemented). */
  openInExplorer?: OpenInExplorerResponse;
  /** `POST /api/logs/clear` response. */
  logsClear?: LogsClearResponse;
  /** `POST /api/cache/prune` dry-run + non-dry-run responses. */
  prune?: { dryRun: CachePruneResponse; commit: CachePruneResponse };
  /**
   * Downloads ([D]/[D-Deep] MD/HTML). Map key: `<kind>::<slug>::<name>::<from>::<to>::<format>`.
   * Missing key returns 404 NOT_CACHED, matching spec.
   */
  downloads?: Record<string, string>;
  /** Optional custom handlers for specific URLs (full URL string). */
  custom?: Record<string, (init: RequestInit) => Promise<Response> | Response>;
  /** Hooks invoked when refresh POSTs land (lets a test assert it was called). */
  onRefreshReport?: (slug: string, name: string, from: string, to: string) => void;
  onRefreshFileReview?: (slug: string, name: string, pathHash: string) => void;
  onRefreshDeepReport?: (slug: string, name: string, from: string, to: string) => void;
  onPrune?: (olderThanDays: number, dryRun: boolean) => void;
  onClearLogs?: () => void;
}

const DEFAULT_CONFIG: ConfigResponse = {
  schemaVersion: 1,
  llm: { provider: 'anthropic', model: 'claude-opus-4-7' },
  ui: { sidebarCollapsed: false, theme: 'light', showDeepAnalyzeWarning: true },
  features: { resolverCheckEnabled: true },
  apiKeys: { hasAnthropicKey: true, hasOpenAIKey: false }
};

export function makeFakeFetcher(backend: Partial<FakeBackend> = {}): typeof fetch {
  const data: FakeBackend = {
    config: backend.config ?? DEFAULT_CONFIG,
    projects: backend.projects ?? [],
    projectDetails: backend.projectDetails ?? {},
    jobs: {
      jobs: backend.jobs?.jobs ?? [],
      orphans: backend.jobs?.orphans ?? []
    },
    deps: backend.deps ?? {},
    versions: backend.versions ?? {},
    usage: backend.usage ?? {},
    reports: backend.reports ?? {},
    fileReviews: backend.fileReviews ?? {},
    deepReports: backend.deepReports ?? {},
    deepEstimates: backend.deepEstimates ?? {},
    costSummaries: backend.costSummaries ?? {},
    librarySize: backend.librarySize,
    openInExplorer: backend.openInExplorer,
    logsClear: backend.logsClear,
    prune: backend.prune,
    downloads: backend.downloads ?? {},
    custom: backend.custom ?? {},
    onRefreshReport: backend.onRefreshReport,
    onRefreshFileReview: backend.onRefreshFileReview,
    onRefreshDeepReport: backend.onRefreshDeepReport,
    onPrune: backend.onPrune,
    onClearLogs: backend.onClearLogs
  };

  return vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init.method ?? 'GET';

    // Custom override has top priority.
    if (data.custom![url]) {
      const result = await data.custom![url]!(init);
      return result;
    }

    const respond = (status: number, body: unknown): Response =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
      });

    if (url === '/api/csrf' && method === 'GET') {
      return respond(200, { token: 'test-csrf' });
    }
    if (url === '/api/config' && method === 'GET') {
      return respond(200, data.config);
    }
    if (url === '/api/config' && method === 'PATCH') {
      return respond(200, data.config);
    }
    if (url === '/api/config/api-key' && method === 'POST') {
      return respond(200, { ok: true });
    }
    if (url === '/api/config/api-key/test' && method === 'POST') {
      return respond(200, { ok: true, message: 'Key works' });
    }
    if (url === '/api/projects' && method === 'GET') {
      return respond(200, { projects: data.projects });
    }
    if (url === '/api/projects' && method === 'POST') {
      const body = JSON.parse(init.body as string) as { path: string };
      const slug = `slug-${data.projects!.length + 1}`;
      data.projects!.push({
        slug,
        name: body.path.split(/[/\\]/).pop() ?? 'new-project',
        path: body.path,
        packageManager: 'npm',
        depCount: 0,
        lastScanAt: null,
        pathExists: true
      });
      return respond(202, { slug, jobId: null });
    }
    const detailMatch = url.match(/^\/api\/projects\/([^/]+)\/dependencies$/);
    if (detailMatch && method === 'GET') {
      const slug = decodeURIComponent(detailMatch[1]!);
      const detail = data.projectDetails![slug];
      if (!detail) {
        return respond(404, {
          error: { code: 'NOT_CACHED', message: 'No detail cached' }
        });
      }
      return respond(200, detail);
    }
    if (url === '/api/jobs' && method === 'GET') {
      return respond(200, data.jobs);
    }
    // Stage 2 per-view endpoints — match before fsList so the deps regex wins.
    const depsMatch = url.match(
      /^\/api\/projects\/([^/]+)\/deps\/(.+?)(\/refresh)?$/
    );
    if (depsMatch && (method === 'GET' || method === 'POST')) {
      const slug = decodeURIComponent(depsMatch[1]!);
      const name = decodeURIComponent(depsMatch[2]!);
      if (method === 'POST') {
        return respond(202, { jobId: `job-deps-${name}`, alreadyRunning: false });
      }
      const env = data.deps![`${slug}::${name}`];
      if (!env) {
        return respond(404, { error: { code: 'NOT_CACHED', message: 'No deps cache' } });
      }
      return respond(200, env);
    }
    const versionsMatch = url.match(
      /^\/api\/projects\/([^/]+)\/versions\/(.+?)\/([^/]+?)(\/refresh)?$/
    );
    if (versionsMatch && (method === 'GET' || method === 'POST')) {
      const slug = decodeURIComponent(versionsMatch[1]!);
      const name = decodeURIComponent(versionsMatch[2]!);
      const version = decodeURIComponent(versionsMatch[3]!);
      if (method === 'POST') {
        return respond(202, { jobId: `job-versions-${name}`, alreadyRunning: false });
      }
      const env = data.versions![`${slug}::${name}::${version}`];
      if (!env) {
        return respond(404, { error: { code: 'NOT_CACHED', message: 'No version cache' } });
      }
      return respond(200, env);
    }
    const usageMatch = url.match(
      /^\/api\/projects\/([^/]+)\/usage\/(.+?)(\/refresh)?$/
    );
    if (usageMatch && (method === 'GET' || method === 'POST')) {
      const slug = decodeURIComponent(usageMatch[1]!);
      const name = decodeURIComponent(usageMatch[2]!);
      if (method === 'POST') {
        return respond(202, { jobId: `job-usage-${name}`, alreadyRunning: false });
      }
      const env = data.usage![`${slug}::${name}`];
      if (!env) {
        return respond(404, { error: { code: 'NOT_CACHED', message: 'No usage cache' } });
      }
      return respond(200, env);
    }
    // Stage 3 — View [D] update report endpoints.
    const reportsMatch = url.match(
      /^\/api\/projects\/([^/]+)\/reports\/(.+?)\/([^/]+?)\/([^/]+?)(\/refresh)?$/
    );
    if (reportsMatch && (method === 'GET' || method === 'POST')) {
      const slug = decodeURIComponent(reportsMatch[1]!);
      const name = decodeURIComponent(reportsMatch[2]!);
      const from = decodeURIComponent(reportsMatch[3]!);
      const to = decodeURIComponent(reportsMatch[4]!);
      if (method === 'POST') {
        data.onRefreshReport?.(slug, name, from, to);
        return respond(202, {
          jobId: `job-report-${name}-${from}-${to}`,
          alreadyRunning: false
        });
      }
      const env = data.reports![`${slug}::${name}::${from}::${to}`];
      if (!env) {
        return respond(404, { error: { code: 'NOT_CACHED', message: 'No report cache' } });
      }
      return respond(200, env);
    }
    // Stage 3 — View [E] file review endpoints.
    const reviewMatch = url.match(
      /^\/api\/projects\/([^/]+)\/file-reviews\/(.+?)\/([^/]+?)(\/refresh)?$/
    );
    if (reviewMatch && (method === 'GET' || method === 'POST')) {
      const slug = decodeURIComponent(reviewMatch[1]!);
      const name = decodeURIComponent(reviewMatch[2]!);
      const pathHash = decodeURIComponent(reviewMatch[3]!);
      if (method === 'POST') {
        data.onRefreshFileReview?.(slug, name, pathHash);
        return respond(202, {
          jobId: `job-review-${name}-${pathHash}`,
          alreadyRunning: false
        });
      }
      const env = data.fileReviews![`${slug}::${name}::${pathHash}`];
      if (!env) {
        return respond(404, { error: { code: 'NOT_CACHED', message: 'No review cache' } });
      }
      return respond(200, env);
    }
    // Stage 4 — View [D-Deep] deep update report endpoints.
    // Match the more-specific download / cost-estimate URLs before the bare
    // GET so they win.
    const deepDownloadMatch = url.match(
      /^\/api\/projects\/([^/]+)\/deep-reports\/(.+?)\/([^/]+?)\/([^/]+?)\/download\?format=(md|html)$/
    );
    if (deepDownloadMatch && method === 'GET') {
      const [, rawSlug, rawName, rawFrom, rawTo, rawFormat] = deepDownloadMatch;
      const slug = decodeURIComponent(rawSlug!);
      const name = decodeURIComponent(rawName!);
      const from = decodeURIComponent(rawFrom!);
      const to = decodeURIComponent(rawTo!);
      const format = rawFormat as 'md' | 'html';
      const key = `deep::${slug}::${name}::${from}::${to}::${format}`;
      const body = data.downloads![key];
      if (body === undefined) {
        return respond(404, {
          error: { code: 'NOT_CACHED', message: 'Generate the report first.' }
        });
      }
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': format === 'md' ? 'text/markdown' : 'text/html',
          'content-disposition': `attachment; filename="${name}-${from}-${to}-deep.${format}"`
        }
      });
    }
    const reportDownloadMatch = url.match(
      /^\/api\/projects\/([^/]+)\/reports\/(.+?)\/([^/]+?)\/([^/]+?)\/download\?format=(md|html)$/
    );
    if (reportDownloadMatch && method === 'GET') {
      const [, rawSlug, rawName, rawFrom, rawTo, rawFormat] = reportDownloadMatch;
      const slug = decodeURIComponent(rawSlug!);
      const name = decodeURIComponent(rawName!);
      const from = decodeURIComponent(rawFrom!);
      const to = decodeURIComponent(rawTo!);
      const format = rawFormat as 'md' | 'html';
      const key = `report::${slug}::${name}::${from}::${to}::${format}`;
      const body = data.downloads![key];
      if (body === undefined) {
        return respond(404, {
          error: { code: 'NOT_CACHED', message: 'Generate the report first.' }
        });
      }
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': format === 'md' ? 'text/markdown' : 'text/html',
          'content-disposition': `attachment; filename="${name}-${from}-${to}.${format}"`
        }
      });
    }
    const deepEstimateMatch = url.match(
      /^\/api\/projects\/([^/]+)\/deep-reports\/(.+?)\/([^/]+?)\/([^/]+?)\/cost-estimate$/
    );
    if (deepEstimateMatch && method === 'GET') {
      const slug = decodeURIComponent(deepEstimateMatch[1]!);
      const name = decodeURIComponent(deepEstimateMatch[2]!);
      const from = decodeURIComponent(deepEstimateMatch[3]!);
      const to = decodeURIComponent(deepEstimateMatch[4]!);
      const est = data.deepEstimates![`${slug}::${name}::${from}::${to}`];
      if (!est) {
        return respond(404, {
          error: { code: 'NOT_CACHED', message: 'No estimate' }
        });
      }
      return respond(200, est);
    }
    const deepReportsMatch = url.match(
      /^\/api\/projects\/([^/]+)\/deep-reports\/(.+?)\/([^/]+?)\/([^/]+?)(\/refresh)?$/
    );
    if (deepReportsMatch && (method === 'GET' || method === 'POST')) {
      const slug = decodeURIComponent(deepReportsMatch[1]!);
      const name = decodeURIComponent(deepReportsMatch[2]!);
      const from = decodeURIComponent(deepReportsMatch[3]!);
      const to = decodeURIComponent(deepReportsMatch[4]!);
      if (method === 'POST') {
        data.onRefreshDeepReport?.(slug, name, from, to);
        return respond(202, {
          jobId: `job-deep-${name}-${from}-${to}`,
          alreadyRunning: false
        });
      }
      const env = data.deepReports![`${slug}::${name}::${from}::${to}`];
      if (!env) {
        return respond(404, {
          error: { code: 'NOT_CACHED', message: 'No deep report cache' }
        });
      }
      return respond(200, env);
    }
    const costMatch = url.match(/^\/api\/projects\/([^/]+)\/cost$/);
    if (costMatch && method === 'GET') {
      const slug = decodeURIComponent(costMatch[1]!);
      const summary = data.costSummaries![slug];
      if (!summary) {
        return respond(404, {
          error: { code: 'NOT_CACHED', message: 'No cost data' }
        });
      }
      return respond(200, summary);
    }
    // Stage 4 — library size / open / logs / prune.
    if (url === '/api/library/size' && method === 'GET') {
      return respond(200, data.librarySize ?? { totalBytes: 0, byKind: {} });
    }
    if (url === '/api/library/open' && method === 'POST') {
      if (!data.openInExplorer) {
        return respond(501, {
          error: { code: 'NOT_IMPLEMENTED', message: 'Best-effort only.' }
        });
      }
      return respond(200, data.openInExplorer);
    }
    if (url === '/api/logs/clear' && method === 'POST') {
      data.onClearLogs?.();
      return respond(200, data.logsClear ?? { filesRemoved: 0, bytesRemoved: 0 });
    }
    const pruneMatch = url.match(
      /^\/api\/cache\/prune\?olderThanDays=(\d+)&dryRun=(true|false)$/
    );
    if (pruneMatch && method === 'POST') {
      const olderThanDays = Number.parseInt(pruneMatch[1]!, 10);
      const dryRun = pruneMatch[2] === 'true';
      data.onPrune?.(olderThanDays, dryRun);
      const result = dryRun ? data.prune?.dryRun : data.prune?.commit;
      return respond(
        200,
        result ?? {
          dryRun,
          olderThanDays,
          pruned: { files: 0, bytes: 0 },
          byKind: {
            deps: { files: 0, bytes: 0 },
            versions: { files: 0, bytes: 0 },
            usage: { files: 0, bytes: 0 },
            reports: { files: 0, bytes: 0 },
            'deep-reports': { files: 0, bytes: 0 },
            'file-reviews': { files: 0, bytes: 0 }
          }
        }
      );
    }
    // Stage 1 — relocate.
    const relocateMatch = url.match(/^\/api\/projects\/([^/]+)\/relocate$/);
    if (relocateMatch && method === 'PATCH') {
      const slug = decodeURIComponent(relocateMatch[1]!);
      const body = JSON.parse(init.body as string) as { newPath: string };
      const existing = data.projects!.find((p) => p.slug === slug);
      if (!existing) {
        return respond(404, {
          error: { code: 'PROJECT_NOT_FOUND', message: 'No such project.' }
        });
      }
      existing.path = body.newPath;
      existing.pathExists = true;
      return respond(200, existing);
    }
    // Stage 1 — delete project.
    const deleteMatch = url.match(/^\/api\/projects\/([^/]+)(\?deleteData=true)?$/);
    if (deleteMatch && method === 'DELETE') {
      const slug = decodeURIComponent(deleteMatch[1]!);
      data.projects = data.projects!.filter((p) => p.slug !== slug);
      return new Response(null, { status: 204 });
    }
    // Stage 3 — orphan discard endpoint.
    const orphanMatch = url.match(/^\/api\/jobs\/orphans\/([^/]+)\/([^/]+)$/);
    if (orphanMatch && method === 'DELETE') {
      const slug = decodeURIComponent(orphanMatch[1]!);
      const jobId = decodeURIComponent(orphanMatch[2]!);
      const jobsBag = data.jobs ?? (data.jobs = { jobs: [], orphans: [] });
      jobsBag.orphans = (jobsBag.orphans ?? []).filter(
        (o) => !(o.slug === slug && o.jobId === jobId)
      );
      return new Response(null, { status: 204 });
    }
    // Stage 3 — cancel job endpoint.
    const cancelMatch = url.match(/^\/api\/jobs\/([^/]+)$/);
    if (cancelMatch && method === 'DELETE') {
      const jobId = decodeURIComponent(cancelMatch[1]!);
      const jobsBag = data.jobs ?? (data.jobs = { jobs: [], orphans: [] });
      jobsBag.jobs = (jobsBag.jobs ?? []).map((j) =>
        j.jobId === jobId ? { ...j, state: 'cancelled' as const } : j
      );
      return new Response(null, { status: 204 });
    }
    const refreshMatch = url.match(/^\/api\/projects\/([^/]+)\/refresh$/);
    if (refreshMatch && method === 'POST') {
      const slug = decodeURIComponent(refreshMatch[1]!);
      return respond(200, { slug, jobId: null });
    }
    const fsListMatch = url.match(/^\/api\/fs\/list\?path=(.*)$/);
    if (fsListMatch && method === 'GET') {
      const raw = fsListMatch[1] ?? '';
      const resolved = raw === '' ? '/fake-home' : decodeURIComponent(raw);
      return respond(200, {
        path: resolved,
        parent: null,
        entries: []
      });
    }
    const fsValidateMatch = url.match(/^\/api\/fs\/validate\?path=(.+)$/);
    if (fsValidateMatch && method === 'GET') {
      return respond(200, { ok: true, code: 'OK', message: 'Valid Next.js project (npm)' });
    }

    return respond(404, { error: { code: 'NOT_FOUND', message: 'No fixture for ' + url } });
  });
}

export function installApiClient(fetcher: typeof fetch): ApiClient {
  const client = new ApiClient({ fetcher, csrfToken: 'test-csrf' });
  setApiClient(client);
  return client;
}

export function renderWithProviders(
  ui: React.ReactElement,
  options?: RenderOptions & { backend?: Partial<FakeBackend> }
) {
  const fetcher = makeFakeFetcher(options?.backend);
  installApiClient(fetcher);
  return {
    ...render(ui, { wrapper: AppProvider, ...options }),
    fetcher
  };
}
