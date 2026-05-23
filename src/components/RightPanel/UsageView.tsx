'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, getApiClient } from '@/lib/client/api-client';
import type {
  DepDetail,
  FileEnvelope,
  RelatedDep,
  UsageCategory,
  UsageDetail,
  UsageFile
} from '@/lib/api-types';
import { useDetailFetch } from '@/lib/client/useDetailFetch';
import { useAppContext } from '../AppContext';
import { CacheFreshnessLine, isStale } from './CacheFreshnessLine';
import { CollapsibleSection } from './CollapsibleSection';
import { EmptyStateCTA } from './EmptyStateCTA';
import { RegenerateButton } from './RegenerateButton';
import { Button } from '../modals/Button';
import { PersistenceKeys, readLocal, writeLocal } from '@/lib/client/persistence';
import { formatRelativeTime } from '@/lib/client/format';
import styles from './UsageView.module.css';

interface Props {
  slug: string;
  depName: string;
}

const CATEGORY_LABEL: Record<UsageCategory, string> = {
  prod: 'Prod',
  test: 'Test',
  story: 'Story',
  config: 'Config'
};

const CATEGORY_ORDER: UsageCategory[] = ['prod', 'test', 'story', 'config'];

/**
 * One row's summary after the batch scan completes — enough for the
 * collapsed row header to show "12 files used" or "unused" without the user
 * having to expand.
 */
interface RelatedUsageSummary {
  totalFiles: number;
  declaredButUnused: boolean;
}

function groupFilesByCategory(files: UsageFile[]): Record<UsageCategory, UsageFile[]> {
  const result: Record<UsageCategory, UsageFile[]> = {
    prod: [],
    test: [],
    story: [],
    config: []
  };
  for (const f of files) result[f.category].push(f);
  return result;
}

export function UsageView({ slug, depName }: Props): JSX.Element {
  const { navigate, pushToast } = useAppContext();
  const fetch = useDetailFetch<FileEnvelope<UsageDetail>>({
    fetcher: (signal) => getApiClient().getUsageDetail(slug, depName, { signal }),
    deps: [slug, depName]
  });
  // Dep detail carries `relatedDeps`. We fetch it alongside the usage detail
  // so the new "Usage of related deps" section can list rows. A 404 here just
  // means view [A] hasn't been generated yet — the section degrades to an
  // empty state with a hint, the rest of the usage view still works.
  const relatedFetch = useDetailFetch<FileEnvelope<DepDetail>>({
    fetcher: (signal) => getApiClient().getDepDetail(slug, depName, { signal }),
    deps: [slug, depName]
  });

  const [showTestFiles, setShowTestFiles] = useState<boolean>(() =>
    readLocal<boolean>(PersistenceKeys.showTestFiles, true)
  );
  useEffect(() => {
    writeLocal(PersistenceKeys.showTestFiles, showTestFiles);
  }, [showTestFiles]);

  // Abort controller for the SSE job-wait. See DependencyDetailView for rationale.
  const jobWaitAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      jobWaitAbortRef.current?.abort();
      jobWaitAbortRef.current = null;
    };
  }, [slug, depName]);

  // Related-deps batch refresh state. Distinct from `fetch.regenerating` so
  // the button shows its own label while the batch scan runs.
  const [scanningRelated, setScanningRelated] = useState(false);
  // Bumped after a successful batch scan to invalidate the child accordion
  // rows' caches (so an already-expanded row re-fetches its usage envelope).
  const [relatedReloadKey, setRelatedReloadKey] = useState(0);
  // Per-related-dep usage summary (set after a scan finishes). Lets each
  // row header show `— N files used` or `— unused` even while collapsed, so
  // clicking the scan button has a clear visible before/after — without the
  // user needing to expand every row to confirm "did anything happen?".
  // `null` => not yet scanned; map entry means: row's usage cache was read.
  const [relatedSummaries, setRelatedSummaries] = useState<Record<string, RelatedUsageSummary> | null>(null);
  // ISO timestamp of the last successful batch scan — drives the "Last
  // scanned: …" indicator next to the section title.
  const [relatedLastScannedAt, setRelatedLastScannedAt] = useState<string | null>(null);

  const onRegenerate = async () => {
    jobWaitAbortRef.current?.abort();
    const controller = new AbortController();
    jobWaitAbortRef.current = controller;

    fetch.setRegenerating(true);
    try {
      const { jobId } = await getApiClient().refreshUsageDetail(slug, depName);
      await getApiClient().awaitJob(jobId, { signal: controller.signal });
      if (controller.signal.aborted) return;
      fetch.reload();
    } catch (err) {
      if (controller.signal.aborted || (err as Error).name === 'AbortError') return;
    } finally {
      if (jobWaitAbortRef.current === controller) jobWaitAbortRef.current = null;
      fetch.setRegenerating(false);
    }
  };

  /**
   * Trigger the server's batch-usage endpoint: one `scanCode` of the project,
   * one usage envelope written per related dep. After the job completes, bump
   * `relatedReloadKey` so any already-expanded accordion row re-fetches its
   * cache and shows fresh data.
   */
  const onScanRelatedUsage = async () => {
    jobWaitAbortRef.current?.abort();
    const controller = new AbortController();
    jobWaitAbortRef.current = controller;

    setScanningRelated(true);
    try {
      const { jobId, names } = await getApiClient().refreshRelatedDepsUsage(slug, depName);
      await getApiClient().awaitJob(jobId, { signal: controller.signal });
      if (controller.signal.aborted) return;

      // Fetch each related dep's freshly-written usage cache in parallel so
      // we can populate the row headers with concrete numbers. 46 localhost
      // GETs of small JSON files complete in ~100 ms — cheap enough to do
      // unconditionally for the "before/after" visible feedback. Without
      // this the rows stay visually identical and the user can't tell the
      // scan ran (which is exactly the symptom we just diagnosed).
      const summaries: Record<string, RelatedUsageSummary> = {};
      await Promise.all(
        names.map(async (name) => {
          try {
            const env = await getApiClient().getUsageDetail(slug, name, {
              signal: controller.signal
            });
            summaries[name] = {
              totalFiles: env.data.totalFiles,
              declaredButUnused: env.data.declaredButUnused
            };
          } catch {
            // A miss here means the worker wrote the envelope but our GET
            // raced ahead of disk flush (unlikely) or hit an ApiError. The
            // row will fall back to showing no summary — not fatal.
          }
        })
      );
      if (controller.signal.aborted) return;

      setRelatedSummaries(summaries);
      setRelatedLastScannedAt(new Date().toISOString());
      setRelatedReloadKey((k) => k + 1);

      const scannedCount = Object.keys(summaries).length;
      const usedCount = Object.values(summaries).filter((s) => !s.declaredButUnused).length;
      pushToast({
        severity: 'success',
        title: 'Related-deps usage scanned',
        body: `${scannedCount} dep${scannedCount === 1 ? '' : 's'} scanned — ${usedCount} used, ${scannedCount - usedCount} unused.`
      });
    } catch (err) {
      if (controller.signal.aborted || (err as Error).name === 'AbortError') return;
      const message =
        err instanceof Error ? err.message : 'Related-deps usage scan failed; please try again.';
      pushToast({
        severity: 'error',
        title: `Couldn't scan related deps`,
        body: message
      });
    } finally {
      if (jobWaitAbortRef.current === controller) jobWaitAbortRef.current = null;
      setScanningRelated(false);
    }
  };

  const grouped = useMemo(
    () => (fetch.data ? groupFilesByCategory(fetch.data.data.files) : null),
    [fetch.data]
  );

  if (fetch.status === 'loading' && !fetch.data) {
    return (
      <div className={styles.loading} role="status">
        Loading usage…
      </div>
    );
  }

  if (fetch.status === 'missing') {
    if (fetch.regenerating) {
      return (
        <div className={styles.loading} role="status" aria-live="polite">
          <p>
            Scanning <strong>{depName}</strong>'s usage across the project…
          </p>
          <p>Progress shown in the status bar below.</p>
        </div>
      );
    }
    return (
      <EmptyStateCTA
        title="No usage scan yet."
        description={`Scan ${depName}'s usage across this project.`}
        actionLabel="Scan usage"
        onAction={onRegenerate}
        busy={fetch.regenerating}
      />
    );
  }

  if (fetch.status === 'error' || !fetch.data || !grouped) {
    return (
      <div className={styles.errorBanner} role="alert">
        <p className={styles.errorTitle}>Failed to load usage data.</p>
        {fetch.error && (
          <details className={styles.errorDetails}>
            <summary>Details</summary>
            <p className={styles.errorBody}>{fetch.error}</p>
          </details>
        )}
        <RegenerateButton onClick={onRegenerate} busy={fetch.regenerating} />
      </div>
    );
  }

  const envelope = fetch.data;
  const detail = envelope.data;
  const stale = isStale(envelope.generatedAt, envelope.ttlHours);

  const onFileClick = (file: UsageFile) => {
    navigate({
      kind: 'E',
      depName,
      pathHash: file.pathHash,
      filePath: file.path
    });
  };

  return (
    <div className={styles.body}>
      <div className={styles.viewHeader}>
        <CacheFreshnessLine
          status={stale ? 'stale' : 'fresh'}
          generatedAtIso={envelope.generatedAt}
          onRegenerate={onRegenerate}
        />
        <RegenerateButton onClick={onRegenerate} busy={fetch.regenerating} />
      </div>

      <header className={styles.header}>
        <span className={styles.lastScanned} data-testid="last-scanned">
          Last scanned: {formatRelativeTime(envelope.generatedAt)}
        </span>
        <label className={styles.toggleLabel}>
          <input
            type="checkbox"
            checked={showTestFiles}
            onChange={(e) => setShowTestFiles(e.target.checked)}
            data-testid="show-test-files-toggle"
          />
          Show test files
        </label>
      </header>

      {detail.declaredButUnused && (
        <div className={styles.amberBanner} role="status" data-testid="declared-but-unused">
          Declared but unused — no imports found anywhere in the project.
        </div>
      )}

      <div className={styles.groups}>
        {CATEGORY_ORDER.map((category) => {
          const files = grouped[category];
          if (category === 'test' && !showTestFiles) return null;
          if (files.length === 0) return null;
          return (
            <FileGroup
              key={category}
              category={category}
              files={files}
              onFileClick={onFileClick}
            />
          );
        })}
      </div>

      {detail.dynamicImports.length > 0 && (
        <section
          className={styles.section}
          aria-label="Dynamic imports"
          data-testid="dynamic-imports-section"
        >
          <h3 className={styles.sectionTitle}>
            Dynamic imports
            <span className={styles.sectionCount}> ({detail.dynamicImports.length})</span>
          </h3>
          <ul role="list" className={styles.dynamicList}>
            {detail.dynamicImports.map((d, i) => (
              <li role="listitem" key={`${d.file}:${d.line}:${i}`} className={styles.dynamicRow}>
                <span className={styles.dynamicTag}>dynamic</span>
                <span className={styles.dynamicLocation}>
                  {d.file}:{d.line}
                </span>
                <code className={styles.dynamicSnippet}>{d.snippet}</code>
              </li>
            ))}
          </ul>
        </section>
      )}

      {detail.oversizedSkipped.length > 0 && (
        <section className={styles.section} aria-label="Oversized files skipped">
          <h3 className={styles.sectionTitle}>
            Oversized files skipped
            <span className={styles.sectionCount}> ({detail.oversizedSkipped.length})</span>
          </h3>
          <ul role="list" className={styles.oversizedList}>
            {detail.oversizedSkipped.map((o) => (
              <li role="listitem" key={o.path} className={styles.dynamicRow}>
                <span className={styles.dynamicLocation}>{o.path}</span>
                <span className={styles.muted}>
                  {Math.round(o.sizeBytes / 1024)} KB — {o.reason}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <RelatedDepsUsageSection
        slug={slug}
        viewedDep={depName}
        relatedFetch={relatedFetch}
        scanning={scanningRelated}
        onScan={onScanRelatedUsage}
        reloadKey={relatedReloadKey}
        summaries={relatedSummaries}
        lastScannedAt={relatedLastScannedAt}
        showTestFiles={showTestFiles}
        onNavigate={navigate}
      />
    </div>
  );
}

interface FileGroupProps {
  category: UsageCategory;
  files: UsageFile[];
  onFileClick: (file: UsageFile) => void;
}

/* -------------------------------------------------------------------------- */
/* Related deps usage section                                                 */
/* -------------------------------------------------------------------------- */

type RelatedFetchState = ReturnType<typeof useDetailFetch<FileEnvelope<DepDetail>>>;
type NavigateFn = (route: { kind: 'E'; depName: string; pathHash: string; filePath: string }) => void;

interface RelatedDepsUsageSectionProps {
  slug: string;
  /** The dep currently being viewed in [C] — its relatedDeps drive the rows. */
  viewedDep: string;
  relatedFetch: RelatedFetchState;
  scanning: boolean;
  onScan: () => void;
  /** Bumped by the parent after a batch scan completes; child rows re-fetch. */
  reloadKey: number;
  /** Per-row summary populated by the parent after a scan finishes. */
  summaries: Record<string, RelatedUsageSummary> | null;
  /** ISO timestamp of the last successful scan, or null when never scanned. */
  lastScannedAt: string | null;
  showTestFiles: boolean;
  onNavigate: NavigateFn;
}

function RelatedDepsUsageSection({
  slug,
  viewedDep,
  relatedFetch,
  scanning,
  onScan,
  reloadKey,
  summaries,
  lastScannedAt,
  showTestFiles,
  onNavigate
}: RelatedDepsUsageSectionProps): JSX.Element {
  // The viewed dep's own related list is taken from its DepDetail envelope.
  // Three states: still loading (idle/loading), missing (404 NOT_CACHED —
  // view [A] never generated for this dep), or available.
  const relatedDeps: RelatedDep[] = relatedFetch.data?.data.relatedDeps ?? [];

  // Render the section even when the list is empty so the title + button
  // remain discoverable — but the button is disabled and the body shows a
  // hint.
  const headerCount =
    relatedFetch.status === 'cached' || relatedFetch.status === 'error'
      ? ` (${relatedDeps.length})`
      : '';

  let body: JSX.Element;
  if (relatedFetch.status === 'loading' || relatedFetch.status === 'idle') {
    body = (
      <p className={styles.relatedEmpty} role="status">
        Loading related deps…
      </p>
    );
  } else if (relatedFetch.status === 'missing') {
    body = (
      <p className={styles.relatedEmpty} data-testid="related-usage-no-detail">
        Open view [A] for <code>{viewedDep}</code> first — its related-deps list
        is read from there.
      </p>
    );
  } else if (relatedDeps.length === 0) {
    body = (
      <p className={styles.relatedEmpty} data-testid="related-usage-empty">
        No related deps detected for <code>{viewedDep}</code>.
      </p>
    );
  } else {
    body = (
      <ul role="list" className={styles.relatedList} data-testid="related-usage-list">
        {relatedDeps.map((rel) => (
          <RelatedDepUsageRow
            key={rel.name}
            slug={slug}
            rel={rel}
            reloadKey={reloadKey}
            summary={summaries?.[rel.name] ?? null}
            showTestFiles={showTestFiles}
            onNavigate={onNavigate}
          />
        ))}
      </ul>
    );
  }

  // Numeric count when available, else null (e.g. while DepDetail loads).
  const numericCount =
    relatedFetch.status === 'cached' || relatedFetch.status === 'error'
      ? relatedDeps.length
      : null;
  void headerCount;

  return (
    <CollapsibleSection
      ariaLabel="Usage of related dependencies"
      title="Usage of related deps"
      count={numericCount}
      sectionClassName={styles.section}
      headerClassName={styles.sectionHeader}
      titleClassName={styles.sectionTitle}
      countClassName={styles.sectionCount}
      testId="related-usage-collapse"
      headerAction={
        <Button
          onClick={onScan}
          disabled={scanning || relatedDeps.length === 0}
          title={
            relatedDeps.length === 0
              ? 'No related deps to scan.'
              : 'Run one project-wide code scan and cache usage for every related dep.'
          }
          data-testid="scan-related-usage-button"
        >
          {scanning ? 'Scanning…' : `Scan related deps' usage`}
        </Button>
      }
    >
      {lastScannedAt !== null && (
        <p
          className={styles.relatedEmpty}
          data-testid="related-usage-last-scanned"
        >
          Last scanned: {formatRelativeTime(lastScannedAt)}
        </p>
      )}
      {body}
    </CollapsibleSection>
  );
}

interface RelatedDepUsageRowProps {
  slug: string;
  rel: RelatedDep;
  /** Triggers re-fetch when the parent batch scan completes. */
  reloadKey: number;
  /**
   * Compact summary (totalFiles + declaredButUnused) from the parent's
   * post-scan fan-out. When null, the row header simply doesn't show a
   * usage chip — falls back to showing only `installed <version>`.
   */
  summary: RelatedUsageSummary | null;
  showTestFiles: boolean;
  onNavigate: NavigateFn;
}

/**
 * Accordion row for one related dep. Collapsed by default; on first expand
 * we lazily fetch that dep's `UsageDetail`. If the cache is missing
 * (404 NOT_CACHED) we render a hint pointing the user at the parent section's
 * batch button — we deliberately do NOT auto-trigger a single-dep scan from
 * the row, because the row is meant to be cheap; the heavy work goes through
 * the parent's batch button to amortise one `scanCode` across all rows.
 */
function RelatedDepUsageRow({
  slug,
  rel,
  reloadKey,
  summary,
  showTestFiles,
  onNavigate
}: RelatedDepUsageRowProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<UsageDetail | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'missing' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadOnce = useCallback(
    async (signal: AbortSignal) => {
      setState('loading');
      setErrorMessage(null);
      try {
        const env = await getApiClient().getUsageDetail(slug, rel.name, { signal });
        if (signal.aborted) return;
        setDetail(env.data);
        setState('idle');
      } catch (err) {
        if (signal.aborted || (err as Error).name === 'AbortError') return;
        if (err instanceof ApiError && err.code === 'NOT_CACHED') {
          setDetail(null);
          setState('missing');
          return;
        }
        setDetail(null);
        setErrorMessage(err instanceof Error ? err.message : 'Failed to load usage.');
        setState('error');
      }
    },
    [slug, rel.name]
  );

  // Fetch on expand, and re-fetch whenever the parent bumps reloadKey
  // (i.e. after a successful batch scan). Aborts cleanly on collapse/unmount.
  useEffect(() => {
    if (!expanded) return;
    const ctrl = new AbortController();
    void loadOnce(ctrl.signal);
    return () => ctrl.abort();
  }, [expanded, reloadKey, loadOnce]);

  const grouped = useMemo(
    () => (detail ? groupFilesByCategory(detail.files) : null),
    [detail]
  );

  const onFileClick = (file: UsageFile): void => {
    onNavigate({
      kind: 'E',
      depName: rel.name,
      pathHash: file.pathHash,
      filePath: file.path
    });
  };

  return (
    <li role="listitem" className={styles.relatedRow} data-testid={`related-usage-row-${rel.name}`}>
      <button
        type="button"
        className={styles.relatedHeader}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        data-testid={`related-usage-toggle-${rel.name}`}
      >
        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <span className={styles.relatedName}>{rel.name}</span>
        {rel.installedVersion !== null && (
          <span className={styles.relatedMeta}>installed {rel.installedVersion}</span>
        )}
        {summary !== null && (
          <span
            className={styles.relatedMeta}
            data-testid={`related-usage-summary-${rel.name}`}
          >
            {summary.declaredButUnused
              ? '— unused'
              : `— ${summary.totalFiles} file${summary.totalFiles === 1 ? '' : 's'} used`}
          </span>
        )}
      </button>
      {expanded && (
        <div className={styles.relatedBody}>
          {state === 'loading' && (
            <p className={styles.relatedEmpty} role="status">
              Loading usage for <code>{rel.name}</code>…
            </p>
          )}
          {state === 'missing' && (
            <p
              className={styles.relatedEmpty}
              data-testid={`related-usage-row-${rel.name}-missing`}
            >
              No usage scan cached yet. Click the <strong>Scan related deps' usage</strong>{' '}
              button above to populate it.
            </p>
          )}
          {state === 'error' && (
            <p className={styles.relatedEmpty} role="alert">
              Failed to load usage: {errorMessage ?? 'unknown error'}
            </p>
          )}
          {state === 'idle' && detail !== null && grouped !== null && (
            <RelatedRowUsageContent
              category={null}
              detail={detail}
              grouped={grouped}
              showTestFiles={showTestFiles}
              onFileClick={onFileClick}
            />
          )}
        </div>
      )}
    </li>
  );
}

interface RelatedRowUsageContentProps {
  category: UsageCategory | null;
  detail: UsageDetail;
  grouped: Record<UsageCategory, UsageFile[]>;
  showTestFiles: boolean;
  onFileClick: (file: UsageFile) => void;
}

function RelatedRowUsageContent({
  detail,
  grouped,
  showTestFiles,
  onFileClick
}: RelatedRowUsageContentProps): JSX.Element {
  if (detail.declaredButUnused) {
    return (
      <p className={styles.relatedEmpty}>
        Declared but unused — no imports found anywhere in the project.
      </p>
    );
  }
  return (
    <div className={styles.groups}>
      {CATEGORY_ORDER.map((cat) => {
        const files = grouped[cat];
        if (cat === 'test' && !showTestFiles) return null;
        if (files.length === 0) return null;
        return <FileGroup key={cat} category={cat} files={files} onFileClick={onFileClick} />;
      })}
    </div>
  );
}

function FileGroup({ category, files, onFileClick }: FileGroupProps): JSX.Element {
  const [expanded, setExpanded] = useState(true);
  return (
    <section className={styles.section} aria-label={`${CATEGORY_LABEL[category]} files`}>
      <button
        type="button"
        className={styles.groupHeader}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        data-testid={`usage-group-${category}`}
      >
        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <span className={styles.groupName}>{CATEGORY_LABEL[category]}</span>
        <span className={styles.sectionCount}>({files.length})</span>
      </button>
      {expanded && (
        <ul role="list" className={styles.fileList}>
          {files.map((f) => (
            <li role="listitem" key={f.path} className={styles.fileRow}>
              <button
                type="button"
                className={styles.fileLink}
                onClick={() => onFileClick(f)}
                data-testid={`usage-file-${f.pathHash}`}
              >
                <span className={styles.filePath}>{f.path}</span>
                <span
                  className={[
                    styles.categoryPill,
                    styles[`pill_${category}`]
                  ].join(' ')}
                >
                  {f.category}
                </span>
                <span className={styles.importCount}>
                  {f.importCount} {f.importCount === 1 ? 'import' : 'imports'}
                </span>
              </button>
              <ul role="list" className={styles.importLines}>
                {f.importStatements.map((stmt, i) => (
                  <li role="listitem" key={i} className={styles.importLine}>
                    <code>{stmt}</code>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
