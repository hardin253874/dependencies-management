'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, getApiClient } from '@/lib/client/api-client';
import type {
  CoUpgradeDep,
  FileEnvelope,
  FileToModify,
  RelatedUpgradeDetail,
  ResolverCheckBlock,
  UpdateReportDetail,
  UsageDetail
} from '@/lib/api-types';
import { useDetailFetch } from '@/lib/client/useDetailFetch';
import { triggerDownload } from '@/lib/client/download';
import { useAppContext } from '../AppContext';
import { CacheFreshnessLine, isStale } from './CacheFreshnessLine';
import { CollapsibleSection } from './CollapsibleSection';
import { EmptyStateCTA } from './EmptyStateCTA';
import { RegenerateButton } from './RegenerateButton';
import { Button } from '../modals/Button';
import { DeepAnalyzeConfirmModal } from '../modals/DeepAnalyzeConfirmModal';
import {
  RelatedUpgradeTable,
  type RelatedUpgradeTableClassNames
} from './RelatedUpgradeTable';
import styles from './UpdateReportView.module.css';

/**
 * Tracks which sub-step of the "Generate report" cascade is currently
 * running. Surfaces as a step indicator under the generating message so the
 * user knows the cascade is progressing (otherwise three sequential LLM
 * calls look like one hung request).
 */
type CascadeStep = 'idle' | 'update-report' | 'related-upgrade' | 'related-usage' | 'finalizing';

/** Class-name bundle for the shared RelatedUpgradeTable component. */
const RELATED_UPGRADE_TABLE_CLASSES: RelatedUpgradeTableClassNames = {
  emptyHint: styles.relatedEmpty ?? '',
  globalNotes: styles.globalNotes ?? '',
  table: styles.relatedTable ?? '',
  actionPill: styles.actionPill ?? '',
  actionKeep: styles.actionKeep ?? '',
  actionUpgrade: styles.actionUpgrade ?? '',
  actionInvestigate: styles.actionInvestigate ?? '',
  confidence: styles.confidence ?? ''
};

interface Props {
  slug: string;
  depName: string;
  fromVersion: string;
  toVersion: string;
}

/**
 * View [D] — Update Report (spec §7.6, Appendix A.3, WIREFRAMES.md #11–12).
 *
 * Cache-first; user must click "Generate report" (or Regenerate) to trigger
 * the AI call. While the job is running, the status bar shows status text
 * only — never partial JSON (§11.8).
 *
 * AI-down fallback (§11.9): when the payload's source is
 * `'deterministic-partial'`, the resolver-check + co-upgrade + files-to-modify
 * sections still render, and an amber `AiUnavailableBanner` invites Retry.
 */
export function UpdateReportView({ slug, depName, fromVersion, toVersion }: Props): JSX.Element {
  const { openSettings, navigate, config, pushToast } = useAppContext();
  const fetch = useDetailFetch<FileEnvelope<UpdateReportDetail>>({
    fetcher: (signal) =>
      getApiClient().getUpdateReport(slug, depName, fromVersion, toVersion, { signal }),
    deps: [slug, depName, fromVersion, toVersion]
  });
  // Related-deps upgrade analysis — cache-first GET. 404 NOT_CACHED just
  // means the section CTA is shown; cascade generates it. The cached
  // payload's `recommendations[]` enumerates the related-dep names this
  // view needs to render usage rows for — no separate DepDetail fetch.
  const relatedUpgradeFetch = useDetailFetch<FileEnvelope<RelatedUpgradeDetail>>({
    fetcher: (signal) =>
      getApiClient().getRelatedUpgrade(slug, depName, toVersion, { signal }),
    deps: [slug, depName, toVersion]
  });

  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<'md' | 'html' | null>(null);
  const [deepPrompt, setDeepPrompt] = useState(false);
  // Which sub-step of the cascade is currently running. Drives the
  // step-progress indicator under the "Generating…" message.
  const [cascadeStep, setCascadeStep] = useState<CascadeStep>('idle');
  // Bumped after the related-usage batch refresh so the per-row accordion
  // entries re-fetch their (now-fresh) usage caches.
  const [usageReloadKey, setUsageReloadKey] = useState(0);

  // Abort controller for the SSE job-wait. See DependencyDetailView for rationale.
  const jobWaitAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      jobWaitAbortRef.current?.abort();
      jobWaitAbortRef.current = null;
    };
  }, [slug, depName, fromVersion, toVersion]);

  /**
   * Cascade refresh: generate (or re-generate) all three caches that feed
   * this view, in sequence, with per-step progress.
   *
   *   1. Update report (existing LLM call, the heaviest).
   *   2. Related-deps upgrade analysis (new LLM call).
   *   3. Related-deps usage (deterministic project-wide scan, fast).
   *
   * Sequential rather than parallel because:
   *   - The LLM concurrency limit may be 1 in some configs; parallel calls
   *     would serialize anyway and tangle their phase events in the status
   *     bar.
   *   - Each step's progress events are clearer when the user can see
   *     "Step N/3" advance.
   *
   * On any step's error we abort the cascade and surface a toast; later
   * steps don't run. The earlier steps' caches that DID succeed remain
   * persisted, so the user sees partial progress + can retry.
   */
  const onRegenerate = async () => {
    jobWaitAbortRef.current?.abort();
    const controller = new AbortController();
    jobWaitAbortRef.current = controller;

    fetch.setRegenerating(true);
    relatedUpgradeFetch.setRegenerating(true);
    setCascadeStep('update-report');

    try {
      // ---- Step 1: Update report -------------------------------------
      const r1 = await getApiClient().refreshUpdateReport(
        slug,
        depName,
        fromVersion,
        toVersion
      );
      await getApiClient().awaitJob(r1.jobId, { signal: controller.signal });
      if (controller.signal.aborted) return;
      fetch.reload();

      // ---- Step 2: Related-deps upgrade analysis ---------------------
      setCascadeStep('related-upgrade');
      try {
        const r2 = await getApiClient().refreshRelatedUpgrade(slug, depName, toVersion);
        await getApiClient().awaitJob(r2.jobId, { signal: controller.signal });
        if (controller.signal.aborted) return;
        relatedUpgradeFetch.reload();
      } catch (err) {
        // Most likely: DEP_DETAIL_NOT_CACHED (view [A] never opened).
        // Treat as non-fatal — the rest of the report still renders.
        if (controller.signal.aborted || (err as Error).name === 'AbortError') return;
        const code = err instanceof ApiError ? err.code : 'UNKNOWN';
        pushToast({
          severity: 'warning',
          title: 'Related-deps upgrade analysis skipped',
          body:
            code === 'DEP_DETAIL_NOT_CACHED'
              ? `Open view [A] for ${depName} first so its related deps are known, then Regenerate.`
              : (err as Error).message
        });
      }

      // ---- Step 3: Related-deps usage batch --------------------------
      setCascadeStep('related-usage');
      try {
        const r3 = await getApiClient().refreshRelatedDepsUsage(slug, depName);
        await getApiClient().awaitJob(r3.jobId, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setUsageReloadKey((k) => k + 1);
      } catch (err) {
        if (controller.signal.aborted || (err as Error).name === 'AbortError') return;
        const code = err instanceof ApiError ? err.code : 'UNKNOWN';
        if (code !== 'DEP_DETAIL_NOT_CACHED') {
          pushToast({
            severity: 'warning',
            title: 'Related-deps usage scan skipped',
            body: (err as Error).message
          });
        }
      }

      setCascadeStep('finalizing');
    } catch (err) {
      if (controller.signal.aborted || (err as Error).name === 'AbortError') return;
      pushToast({
        severity: 'error',
        title: `Couldn't generate update report`,
        body: err instanceof Error ? err.message : 'Generation failed; please try again.'
      });
    } finally {
      if (jobWaitAbortRef.current === controller) jobWaitAbortRef.current = null;
      fetch.setRegenerating(false);
      relatedUpgradeFetch.setRegenerating(false);
      setCascadeStep('idle');
    }
  };

  const onDeepAnalyze = () => {
    // Stage 4: show first-Deep-Analyze cost prompt the first time per project
    // (per `_config.json.ui.showDeepAnalyzeWarning`). If the user has previously
    // suppressed the warning, navigate directly to view [D-Deep].
    if (config?.ui.showDeepAnalyzeWarning === false) {
      navigate({ kind: 'D-deep', depName, fromVersion, toVersion });
      return;
    }
    setDeepPrompt(true);
  };

  const onDownload = async (format: 'md' | 'html') => {
    setDownloading(format);
    setDownloadError(null);
    try {
      const payload = await getApiClient().downloadUpdateReport(
        slug,
        depName,
        fromVersion,
        toVersion,
        format
      );
      triggerDownload(payload);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'NOT_CACHED') {
        setDownloadError('Generate the report first, then try again.');
      } else {
        setDownloadError(err instanceof Error ? err.message : 'Download failed.');
      }
    } finally {
      setDownloading(null);
    }
  };

  if (fetch.status === 'loading' && !fetch.data) {
    return (
      <div className={styles.loading} role="status">
        Loading update report…
      </div>
    );
  }

  if (fetch.status === 'missing') {
    if (fetch.regenerating) {
      return (
        <div className={styles.loading} role="status" aria-live="polite">
          <p>
            Generating update report for <strong>{depName}</strong> v{fromVersion} → v
            {toVersion}…
          </p>
          <p>
            Running 3-step cascade (update report → related deps upgrade → related deps
            usage). Progress shown in the status bar below.
          </p>
          <CascadeProgress step={cascadeStep} />
        </div>
      );
    }
    return (
      <EmptyStateCTA
        title="No analysis yet."
        description={`Generate an update report for ${depName} v${fromVersion} → v${toVersion}. Will also analyze related-deps impact and their usage.`}
        actionLabel="Generate report"
        onAction={onRegenerate}
        busy={fetch.regenerating}
      />
    );
  }

  if (fetch.status === 'error' || !fetch.data) {
    return (
      <div className={styles.errorBanner} role="alert">
        <p className={styles.errorTitle}>Failed to load update report.</p>
        <p className={styles.errorBody}>
          {fetch.error ?? 'Please retry, or regenerate to refetch.'}
        </p>
        <RegenerateButton onClick={onRegenerate} busy={fetch.regenerating} />
      </div>
    );
  }

  const envelope = fetch.data;
  const detail = envelope.data;
  const stale = isStale(envelope.generatedAt, envelope.ttlHours);
  const aiUnavailable = envelope.source === 'deterministic-partial';

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

      {aiUnavailable && (
        <div className={styles.amberBanner} role="status" data-testid="ai-unavailable-banner">
          <span>AI narrative unavailable — </span>
          <button
            type="button"
            className={styles.bannerAction}
            onClick={onRegenerate}
            data-testid="ai-unavailable-retry"
          >
            Retry
          </button>
        </div>
      )}

      {fetch.regenerating && cascadeStep !== 'idle' && <CascadeProgress step={cascadeStep} />}

      <section className={styles.section} aria-label="Summary">
        <h3 className={styles.sectionTitle}>Summary</h3>
        {aiUnavailable && !detail.summary ? (
          <p className={styles.muted}>Awaiting AI analysis.</p>
        ) : (
          <p className={styles.summaryBody}>{detail.summary}</p>
        )}
      </section>

      <div className={styles.riskRow}>
        <span className={styles.riskLabel}>Risk:</span>
        <RiskPill level={detail.riskLevel} />
      </div>

      <section className={styles.section} aria-label="Resolver check">
        <h3 className={styles.sectionTitle}>Resolver check</h3>
        <ResolverCheckBlockView block={detail.resolverCheck} onOpenSettings={() => openSettings('behavior')} onRegenerate={onRegenerate} />
      </section>

      <section className={styles.section} aria-label="Co-upgrade dependencies">
        <h3 className={styles.sectionTitle}>
          Co-upgrade deps
          <span className={styles.sectionCount}> ({detail.coUpgradeDeps.length})</span>
        </h3>
        {detail.coUpgradeDeps.length === 0 ? (
          <p className={styles.muted}>None.</p>
        ) : (
          <ul role="list" className={styles.coUpgradeList}>
            {detail.coUpgradeDeps.map((co) => (
              <CoUpgradeRow key={co.name} co={co} />
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section} aria-label="Breaking changes">
        <h3 className={styles.sectionTitle}>
          Breaking changes
          <span className={styles.sectionCount}> ({detail.breakingChanges.length})</span>
        </h3>
        {aiUnavailable && detail.breakingChanges.length === 0 ? (
          <p className={styles.muted}>Awaiting AI analysis.</p>
        ) : detail.breakingChanges.length === 0 ? (
          <p className={styles.muted}>None reported.</p>
        ) : (
          <ul role="list" className={styles.breakingList}>
            {detail.breakingChanges.map((bc, i) => (
              <li
                role="listitem"
                key={`${bc.title}-${i}`}
                className={styles.breakingItem}
                data-testid={`breaking-change-${i}`}
              >
                <div className={styles.breakingHeader}>
                  <strong className={styles.breakingTitle}>{bc.title}</strong>
                  {bc.affectsFilesInProject && (
                    <span className={styles.affectsPill}>Affects this project</span>
                  )}
                </div>
                <p className={styles.breakingBody}>{bc.description}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section} aria-label="Files to modify">
        <h3 className={styles.sectionTitle}>
          Files to modify
          <span className={styles.sectionCount}> ({detail.filesToModify.length})</span>
        </h3>
        {detail.filesToModify.length === 0 ? (
          <p className={styles.muted}>No files identified.</p>
        ) : (
          <ul role="list" className={styles.filesList}>
            {detail.filesToModify.map((f) => (
              <FileToModifyRow key={f.path} file={f} />
            ))}
          </ul>
        )}
      </section>

      {detail.recommendations.length > 0 && (
        <section className={styles.section} aria-label="Recommendations">
          <h3 className={styles.sectionTitle}>Recommendations</h3>
          <ul role="list" className={styles.recList}>
            {detail.recommendations.map((rec, i) => (
              <li role="listitem" key={i} className={styles.recItem}>
                {rec}
              </li>
            ))}
          </ul>
        </section>
      )}

      <RelatedUpgradeImpactSection relatedUpgradeFetch={relatedUpgradeFetch} />

      <RelatedDepsUsageSection
        slug={slug}
        relatedUpgradeFetch={relatedUpgradeFetch}
        reloadKey={usageReloadKey}
      />

      {downloadError && (
        <div
          className={styles.downloadError}
          role="alert"
          data-testid="download-error"
        >
          {downloadError}
        </div>
      )}

      <div className={styles.actions}>
        <Button
          tone="primary"
          onClick={onDeepAnalyze}
          data-testid="deep-analyze"
          aria-label="Deep Analyze"
        >
          Deep Analyze
        </Button>
        <Button
          onClick={() => void onDownload('md')}
          disabled={downloading !== null}
          data-testid="download-md"
          aria-label="Download as Markdown"
        >
          {downloading === 'md' ? 'Downloading…' : 'Download MD'}
        </Button>
        <Button
          onClick={() => void onDownload('html')}
          disabled={downloading !== null}
          data-testid="download-html"
          aria-label="Download as HTML"
        >
          {downloading === 'html' ? 'Downloading…' : 'Download HTML'}
        </Button>
      </div>

      <DeepAnalyzeConfirmModal
        open={deepPrompt}
        slug={slug}
        depName={depName}
        fromVersion={fromVersion}
        toVersion={toVersion}
        onCancel={() => setDeepPrompt(false)}
        onContinue={() => {
          setDeepPrompt(false);
          navigate({ kind: 'D-deep', depName, fromVersion, toVersion });
        }}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function RiskPill({ level }: { level: 'low' | 'medium' | 'high' }): JSX.Element {
  const cls =
    level === 'high' ? styles.riskHigh : level === 'medium' ? styles.riskMid : styles.riskLow;
  return (
    <span
      className={[styles.riskPill, cls].join(' ')}
      data-testid={`risk-pill-${level}`}
    >
      {level}
    </span>
  );
}

interface ResolverProps {
  block: ResolverCheckBlock;
  onOpenSettings: () => void;
  onRegenerate: () => void;
}

function ResolverCheckBlockView({ block, onOpenSettings, onRegenerate }: ResolverProps): JSX.Element {
  if (block.kind === 'disabled') {
    const reasonCopy: Record<typeof block.reason, string> = {
      yarn: 'Resolver check is not available for yarn projects in v1.',
      'kill-switch': 'Resolver check is turned off in Settings → Behavior.',
      failure: `Resolver check failed: ${block.failureMessage ?? 'unknown error'}.`
    };
    return (
      <div
        className={styles.resolverDisabled}
        role="status"
        data-testid={`resolver-disabled-${block.reason}`}
      >
        <p className={styles.resolverDisabledMessage}>
          Resolver check disabled — {reasonCopy[block.reason]}
        </p>
        {block.reason === 'kill-switch' && (
          <button
            type="button"
            className={styles.resolverAction}
            onClick={onOpenSettings}
            data-testid="resolver-open-settings"
          >
            Open Settings
          </button>
        )}
        {block.reason === 'failure' && (
          <button
            type="button"
            className={styles.resolverAction}
            onClick={onRegenerate}
            data-testid="resolver-retry"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  if (block.conflicts.length === 0) {
    return (
      <p className={styles.resolverClean} data-testid="resolver-clean">
        Would resolve cleanly.
      </p>
    );
  }

  return (
    <div className={styles.resolverConflicts} data-testid="resolver-conflicts">
      <p className={styles.resolverConflictsTitle}>Conflicts found:</p>
      <ul role="list">
        {block.conflicts.map((c) => (
          <li role="listitem" key={c.package} className={styles.resolverConflictRow}>
            <code>{c.package}</code> — {c.reason}
          </li>
        ))}
      </ul>
      {block.legacyPeerDepsUsed && (
        <p className={styles.muted}>Resolved with --legacy-peer-deps: yes</p>
      )}
    </div>
  );
}

function CoUpgradeRow({ co }: { co: CoUpgradeDep }): JSX.Element {
  // Stage 3 carry-over M1: the AI-down skeleton sets `suggestedVersion = ''`.
  // Hide the arrow + suggested span so we don't render "1.0.0 →  ".
  const hasSuggestion = co.suggestedVersion.trim().length > 0;
  return (
    <li
      role="listitem"
      className={styles.coUpgradeRow}
      data-testid={`co-upgrade-${co.name}`}
    >
      <div className={styles.coUpgradeHeader}>
        <code className={styles.coUpgradeName}>{co.name}</code>
        <span className={styles.coUpgradeVersions}>
          {co.currentVersion}
          {hasSuggestion && (
            <>
              {' → '}
              {co.suggestedVersion}
            </>
          )}
        </span>
        <span
          className={[styles.coUpgradePill, co.required ? styles.required : styles.optional].join(' ')}
          data-testid={`co-upgrade-${co.name}-pill`}
        >
          {co.required ? 'Required' : 'Optional'}
        </span>
      </div>
      <p className={styles.coUpgradeExplanation}>{co.explanation}</p>
    </li>
  );
}

function FileToModifyRow({ file }: { file: FileToModify }): JSX.Element {
  return (
    <li role="listitem" className={styles.fileRow} data-testid={`file-to-modify-${file.path}`}>
      <code className={styles.filePath}>{file.path}</code>
      <span
        className={[styles.sizePill, styles[`size_${file.estimatedChangeSize}`]].join(' ')}
      >
        {file.estimatedChangeSize}
      </span>
      <span className={styles.fileBrief}>{file.brief}</span>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* Cascade-progress indicator                                                  */
/* -------------------------------------------------------------------------- */

function CascadeProgress({ step }: { step: CascadeStep }): JSX.Element {
  const steps: Array<{ key: Exclude<CascadeStep, 'idle'>; label: string }> = [
    { key: 'update-report', label: 'Update report' },
    { key: 'related-upgrade', label: 'Related deps upgrade analysis' },
    { key: 'related-usage', label: 'Related deps usage scan' },
    { key: 'finalizing', label: 'Finalizing' }
  ];
  const activeIdx = steps.findIndex((s) => s.key === step);
  return (
    <ul role="list" data-testid="cascade-progress" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {steps.map((s, i) => {
        const done = i < activeIdx;
        const active = i === activeIdx;
        return (
          <li
            role="listitem"
            key={s.key}
            className={active ? styles.cascadeStepActive : styles.cascadeStep}
            data-testid={`cascade-step-${s.key}`}
          >
            {done ? '✓' : active ? '⋯' : '·'} Step {i + 1}/4: {s.label}
          </li>
        );
      })}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */
/* Related deps upgrade impact section (renders RelatedUpgradeTable)          */
/* -------------------------------------------------------------------------- */

type RelatedUpgradeFetchState = ReturnType<
  typeof useDetailFetch<FileEnvelope<RelatedUpgradeDetail>>
>;

function RelatedUpgradeImpactSection({
  relatedUpgradeFetch
}: {
  relatedUpgradeFetch: RelatedUpgradeFetchState;
}): JSX.Element {
  const envelope = relatedUpgradeFetch.data;
  const detail = envelope?.data ?? null;
  return (
    <CollapsibleSection
      ariaLabel="Related deps upgrade impact"
      title="Related deps upgrade impact"
      count={detail?.recommendations.length ?? null}
      sectionClassName={styles.section}
      titleClassName={styles.sectionTitle}
      countClassName={styles.sectionCount}
      testId="related-upgrade-impact-collapse"
    >
      {relatedUpgradeFetch.status === 'loading' && detail === null && (
        <p className={styles.relatedEmpty} role="status">
          Loading related-deps analysis…
        </p>
      )}
      {relatedUpgradeFetch.status === 'missing' && (
        <p className={styles.relatedEmpty} data-testid="related-upgrade-cta">
          Not yet generated. Click <strong>Regenerate</strong> above to run the full
          cascade (update report + related-deps upgrade + their usage).
        </p>
      )}
      {relatedUpgradeFetch.status === 'error' && (
        <p className={styles.relatedEmpty} role="alert">
          Failed to load related-deps analysis. Click Regenerate to retry.
        </p>
      )}
      {detail !== null && envelope !== null && (
        <RelatedUpgradeTable
          detail={detail}
          generatedAt={envelope.generatedAt}
          source={envelope.source}
          classNames={RELATED_UPGRADE_TABLE_CLASSES}
        />
      )}
    </CollapsibleSection>
  );
}

/* -------------------------------------------------------------------------- */
/* Related deps usage section (accordion sourced from related-upgrade names)  */
/* -------------------------------------------------------------------------- */

function RelatedDepsUsageSection({
  slug,
  relatedUpgradeFetch,
  reloadKey
}: {
  slug: string;
  relatedUpgradeFetch: RelatedUpgradeFetchState;
  reloadKey: number;
}): JSX.Element {
  const detail = relatedUpgradeFetch.data?.data ?? null;
  // The names to render usage rows for come from the related-upgrade
  // recommendations (in the order the LLM/skeleton produced them).
  const names = useMemo(
    () => detail?.recommendations.map((r) => r.name) ?? [],
    [detail]
  );

  return (
    <CollapsibleSection
      ariaLabel="Related deps usage"
      title="Related deps usage"
      count={names.length > 0 ? names.length : null}
      sectionClassName={styles.section}
      titleClassName={styles.sectionTitle}
      countClassName={styles.sectionCount}
      testId="related-usage-collapse-d"
    >
      {detail === null ? (
        <p className={styles.relatedEmpty}>
          Run the cascade above first — this section lists each related dep&apos;s
          imports in your project.
        </p>
      ) : names.length === 0 ? (
        <p className={styles.relatedEmpty}>No related deps detected.</p>
      ) : (
        <ul role="list" className={styles.usageList}>
          {names.map((name) => (
            <RelatedDepUsageRow
              key={name}
              slug={slug}
              depName={name}
              reloadKey={reloadKey}
            />
          ))}
        </ul>
      )}
    </CollapsibleSection>
  );
}

function RelatedDepUsageRow({
  slug,
  depName,
  reloadKey
}: {
  slug: string;
  depName: string;
  reloadKey: number;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<UsageDetail | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'missing' | 'error'>('idle');

  const loadOnce = useCallback(
    async (signal: AbortSignal) => {
      setState('loading');
      try {
        const env = await getApiClient().getUsageDetail(slug, depName, { signal });
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
        setState('error');
      }
    },
    [slug, depName]
  );

  // Fetch on expand AND on reloadKey bump (after the cascade refresh).
  useEffect(() => {
    if (!expanded) return;
    const ctrl = new AbortController();
    void loadOnce(ctrl.signal);
    return () => ctrl.abort();
  }, [expanded, reloadKey, loadOnce]);

  // Summary chip in the header — populated only after the row is expanded
  // once or after a cascade reload. Quietly absent otherwise.
  const summary: string | null = detail === null
    ? null
    : detail.declaredButUnused
      ? '— unused'
      : `— ${detail.totalFiles} file${detail.totalFiles === 1 ? '' : 's'} used`;

  return (
    <li role="listitem" className={styles.usageRow} data-testid={`related-usage-row-${depName}`}>
      <button
        type="button"
        className={styles.usageHeader}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        data-testid={`related-usage-toggle-${depName}`}
      >
        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <span className={styles.usageName}>{depName}</span>
        {summary !== null && <span className={styles.usageMeta}>{summary}</span>}
      </button>
      {expanded && (
        <div className={styles.usageBody}>
          {state === 'loading' && (
            <p className={styles.relatedEmpty} role="status">
              Loading usage for <code>{depName}</code>…
            </p>
          )}
          {state === 'missing' && (
            <p className={styles.relatedEmpty}>
              No usage cache for <code>{depName}</code>. Click Regenerate above to run
              the cascade — step 3 scans every related dep&apos;s usage in one pass.
            </p>
          )}
          {state === 'error' && (
            <p className={styles.relatedEmpty} role="alert">
              Failed to load usage for <code>{depName}</code>.
            </p>
          )}
          {state === 'idle' && detail !== null && (
            <RelatedDepUsageBody detail={detail} />
          )}
        </div>
      )}
    </li>
  );
}

function RelatedDepUsageBody({ detail }: { detail: UsageDetail }): JSX.Element {
  if (detail.declaredButUnused) {
    return (
      <p className={styles.relatedEmpty}>
        Declared but unused — no imports found anywhere in the project.
      </p>
    );
  }
  if (detail.files.length === 0) {
    return <p className={styles.relatedEmpty}>No source files import this dep.</p>;
  }
  return (
    <ul role="list" className={styles.usageFileList}>
      {detail.files.map((f) => (
        <li role="listitem" key={f.path} className={styles.usageFileItem}>
          <code className={styles.usageFilePath}>{f.path}</code>
          <span className={styles.usageFileMeta}>
            [{f.category}] · {f.importCount} import{f.importCount === 1 ? '' : 's'}
          </span>
        </li>
      ))}
    </ul>
  );
}
