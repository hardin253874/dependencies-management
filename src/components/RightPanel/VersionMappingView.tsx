'use client';

import { useEffect, useRef, useState } from 'react';
import { getApiClient } from '@/lib/client/api-client';
import type {
  CveRecord,
  FileEnvelope,
  RelatedUpgradeDetail,
  VersionDetail
} from '@/lib/api-types';
import { useDetailFetch } from '@/lib/client/useDetailFetch';
import { findInstalledVersion } from '@/lib/client/findInstalledVersion';
import { useAppContext } from '../AppContext';
import { CacheFreshnessLine, isStale } from './CacheFreshnessLine';
import { CollapsibleSection } from './CollapsibleSection';
import { EmptyStateCTA } from './EmptyStateCTA';
import { RegenerateButton } from './RegenerateButton';
import { Button } from '../modals/Button';
import {
  RelatedUpgradeTable,
  type RelatedUpgradeTableClassNames
} from './RelatedUpgradeTable';
import styles from './VersionMappingView.module.css';

const VERSION_MAPPING_TABLE_CLASSES: RelatedUpgradeTableClassNames = {
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
  version: string;
}

function severityClass(severity: CveRecord['severity']): string {
  switch (severity) {
    case 'critical':
    case 'high':
      return styles.sevHigh ?? '';
    case 'medium':
    case 'moderate':
      return styles.sevMid ?? '';
    default:
      return styles.sevLow ?? '';
  }
}

export function VersionMappingView({ slug, depName, version }: Props): JSX.Element {
  const { pushToast, navigate, activeProject } = useAppContext();
  const fetch = useDetailFetch<FileEnvelope<VersionDetail>>({
    fetcher: (signal) => getApiClient().getVersionDetail(slug, depName, version, { signal }),
    deps: [slug, depName, version]
  });

  // Related-deps upgrade analysis — cache-first GET, separate from the
  // primary VersionDetail fetch so a missing related-upgrade cache (the
  // common case before the user clicks Analyze) doesn't degrade the rest of
  // the view.
  const relatedFetch = useDetailFetch<FileEnvelope<RelatedUpgradeDetail>>({
    fetcher: (signal) => getApiClient().getRelatedUpgrade(slug, depName, version, { signal }),
    deps: [slug, depName, version]
  });
  const [analyzingRelated, setAnalyzingRelated] = useState(false);

  // Abort controller for the SSE job-wait. See DependencyDetailView for rationale.
  const jobWaitAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      jobWaitAbortRef.current?.abort();
      jobWaitAbortRef.current = null;
    };
  }, [slug, depName, version]);

  const onRegenerate = async () => {
    jobWaitAbortRef.current?.abort();
    const controller = new AbortController();
    jobWaitAbortRef.current = controller;

    fetch.setRegenerating(true);
    try {
      const { jobId } = await getApiClient().refreshVersionDetail(slug, depName, version);
      // Wait for the background job's `done` event before reloading; otherwise
      // GET would still 404 NOT_CACHED and we'd flicker back to the empty CTA.
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
   * Trigger the related-deps upgrade analysis job. Runs the deterministic
   * compatibility check + one batched LLM call server-side; we poll the job,
   * then reload the related-upgrade envelope to render the table.
   *
   * Distinct from `onRegenerate` (which refreshes the VersionDetail). Errors
   * surface via toast — silent failure here would repeat the "nothing
   * happened" bug we just fixed in the Usage view.
   */
  const onAnalyzeRelated = async () => {
    jobWaitAbortRef.current?.abort();
    const controller = new AbortController();
    jobWaitAbortRef.current = controller;

    setAnalyzingRelated(true);
    relatedFetch.setRegenerating(true);
    try {
      const { jobId } = await getApiClient().refreshRelatedUpgrade(slug, depName, version);
      await getApiClient().awaitJob(jobId, { signal: controller.signal });
      if (controller.signal.aborted) return;
      relatedFetch.reload();
      pushToast({
        severity: 'success',
        title: 'Related-deps upgrade analysis ready',
        body: `Analyzed upgrade impact for ${depName} → v${version}.`
      });
    } catch (err) {
      if (controller.signal.aborted || (err as Error).name === 'AbortError') return;
      const message =
        err instanceof Error ? err.message : 'Related-deps analysis failed; please try again.';
      pushToast({
        severity: 'error',
        title: `Couldn't analyze related deps`,
        body: message
      });
    } finally {
      if (jobWaitAbortRef.current === controller) jobWaitAbortRef.current = null;
      setAnalyzingRelated(false);
      relatedFetch.setRegenerating(false);
    }
  };

  if (fetch.status === 'loading' && !fetch.data) {
    return (
      <div className={styles.loading} role="status">
        Loading version mapping…
      </div>
    );
  }

  if (fetch.status === 'missing') {
    if (fetch.regenerating) {
      return (
        <div className={styles.loading} role="status" aria-live="polite">
          <p>
            Running version mapping for <strong>{depName} v{version}</strong>…
          </p>
          <p>Progress shown in the status bar below.</p>
        </div>
      );
    }
    return (
      <EmptyStateCTA
        title="No version mapping yet."
        description={`Run the version mapping for ${depName} v${version}.`}
        actionLabel="Run version mapping"
        onAction={onRegenerate}
        busy={fetch.regenerating}
      />
    );
  }

  if (fetch.status === 'error' || !fetch.data) {
    return (
      <div className={styles.errorBanner} role="alert">
        <p className={styles.errorTitle}>Failed to load version mapping.</p>
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

  // Pull the installed (from) version so the update-report route is
  // `{ from: installedVersion, to: version }` per spec §7.6. Uses the shared
  // helper that also resolves Volta toolchain entries (`node`/`npm`/`yarn`)
  // from `project.volta` — those entries are NOT in `project.dependencies`,
  // so a naive `.dependencies.find()` would return undefined and disable
  // both the "Analyze report" and "Analyze related deps" buttons for any
  // toolchain pin.
  const fromVersion = findInstalledVersion(activeProject, depName);

  const onAnalyze = () => {
    if (!fromVersion) {
      pushToast({
        severity: 'info',
        title: 'Installed version unknown',
        body: 'Refresh the project first to capture the installed version.'
      });
      return;
    }
    navigate({ kind: 'D', depName, fromVersion, toVersion: version });
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
        <h2 className={styles.versionTitle}>v{version}</h2>
        {detail.publishedAt && (
          <span className={styles.publishDate}>
            Published {detail.publishedAt.slice(0, 10)}
          </span>
        )}
      </header>

      <section className={styles.section} aria-label={`Vulnerabilities in v${version}`}>
        <h3 className={styles.sectionTitle} data-testid="cve-section-title">
          Vulnerabilities in v{version}
        </h3>
        {detail.cves === null ? (
          <p className={styles.muted}>Data unavailable.</p>
        ) : detail.cves.length === 0 ? (
          <p className={styles.cleanLine}>No known CVEs in this version.</p>
        ) : (
          <ul role="list" className={styles.cveList}>
            {detail.cves.map((cve) => (
              <li role="listitem" key={cve.id} className={styles.cveCard}>
                <span className={`${styles.severity} ${severityClass(cve.severity)}`}>
                  {cve.severity}
                </span>
                <span className={styles.cveId}>{cve.id}</span>
                <p className={styles.cveSummary}>{cve.summary}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {detail.changelogUrl && (
        <section className={styles.section} aria-label="Changelog">
          <h3 className={styles.sectionTitle}>Changelog</h3>
          <a
            href={detail.changelogUrl}
            target="_blank"
            rel="noreferrer noopener"
            className={styles.changelogLink}
          >
            {detail.changelogUrl}
          </a>
        </section>
      )}

      {detail.notes && (
        <section className={styles.section} aria-label="Release notes">
          <h3 className={styles.sectionTitle}>Release notes</h3>
          <pre className={styles.notes}>{detail.notes}</pre>
        </section>
      )}

      <RelatedUpgradeSection
        viewedDep={depName}
        version={version}
        fromVersion={fromVersion}
        relatedFetch={relatedFetch}
        analyzing={analyzingRelated}
        onAnalyze={onAnalyzeRelated}
      />

      <div className={styles.actions}>
        <Button
          tone="primary"
          onClick={onAnalyze}
          disabled={!fromVersion}
          data-testid="analyze-report-button"
        >
          Analyze report
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Related-deps upgrade analysis section                                       */
/* -------------------------------------------------------------------------- */

type RelatedFetchState = ReturnType<typeof useDetailFetch<FileEnvelope<RelatedUpgradeDetail>>>;

interface RelatedUpgradeSectionProps {
  viewedDep: string;
  version: string;
  /** Active project's installed version of the viewed dep (the "from"). */
  fromVersion: string | null;
  relatedFetch: RelatedFetchState;
  analyzing: boolean;
  onAnalyze: () => void;
}

function RelatedUpgradeSection({
  viewedDep,
  version,
  fromVersion,
  relatedFetch,
  analyzing,
  onAnalyze
}: RelatedUpgradeSectionProps): JSX.Element {
  const envelope = relatedFetch.data;
  const detail = envelope?.data ?? null;
  const hasData = detail !== null && relatedFetch.status === 'cached';

  return (
    <CollapsibleSection
      ariaLabel="Related deps upgrade analysis"
      title="Related deps upgrade analysis"
      count={detail?.recommendations.length ?? null}
      sectionClassName={styles.section}
      headerClassName={styles.sectionHeader}
      titleClassName={styles.sectionTitle}
      countClassName={styles.sectionCount}
      testId="related-upgrade-collapse"
      headerAction={
        <Button
          onClick={onAnalyze}
          disabled={analyzing || fromVersion === null}
          title={
            fromVersion === null
              ? 'Installed version unknown — refresh the project first.'
              : `Analyze how upgrading ${viewedDep} from ${fromVersion} → ${version} affects each related dep. Runs a deterministic compatibility check + one batched LLM call.`
          }
          data-testid="analyze-related-deps-button"
        >
          {analyzing
            ? 'Analyzing…'
            : hasData
              ? 'Re-analyze'
              : 'Analyze related deps'}
        </Button>
      }
    >
      {relatedFetch.status === 'loading' && !hasData && (
        <p className={styles.relatedEmpty} role="status">
          Loading cached analysis…
        </p>
      )}

      {analyzing && (
        <p className={styles.relatedEmpty} role="status" aria-live="polite">
          Analyzing impact on related deps — deterministic check + LLM analysis.
          This usually takes 10–30 seconds.
        </p>
      )}

      {!analyzing && relatedFetch.status === 'missing' && (
        <p className={styles.relatedEmpty} data-testid="related-upgrade-cta">
          {fromVersion === null
            ? `Refresh the project first so the installed version of ${viewedDep} is known.`
            : `Click Analyze to see how upgrading ${viewedDep} from v${fromVersion} → v${version} affects each related dep.`}
        </p>
      )}

      {!analyzing && relatedFetch.status === 'error' && (
        <p className={styles.relatedEmpty} role="alert">
          Failed to load cached analysis. Click Analyze to retry.
        </p>
      )}

      {hasData && detail !== null && envelope !== null && (
        <RelatedUpgradeTable
          detail={detail}
          generatedAt={envelope.generatedAt}
          source={envelope.source}
          classNames={VERSION_MAPPING_TABLE_CLASSES}
        />
      )}
    </CollapsibleSection>
  );
}
