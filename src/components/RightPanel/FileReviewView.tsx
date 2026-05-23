'use client';

import { useEffect, useRef, useState } from 'react';
import { getApiClient } from '@/lib/client/api-client';
import type {
  FileEnvelope,
  FileReviewDetail,
  FindingSeverity,
  ReviewFinding
} from '@/lib/api-types';
import { useDetailFetch } from '@/lib/client/useDetailFetch';
import { formatRelativeTime } from '@/lib/client/format';
import { CacheFreshnessLine, isStale } from './CacheFreshnessLine';
import { EmptyStateCTA } from './EmptyStateCTA';
import { RegenerateButton } from './RegenerateButton';
import styles from './FileReviewView.module.css';

interface Props {
  slug: string;
  depName: string;
  pathHash: string;
  /** Display path for the file header (also passed via the route). */
  filePath: string;
}

/**
 * View [E] — File-Level AI Review (spec §7.6, Appendix A.2, WIREFRAMES.md #14).
 *
 * Renders an AI review of how a specific file uses a dependency. If the BE
 * reports `data.stale === true` (target file changed since the review was
 * generated), an amber StaleCacheBanner appears at the top of the body with a
 * Regenerate link (spec §7.6).
 */
export function FileReviewView({ slug, depName, pathHash, filePath }: Props): JSX.Element {
  const fetch = useDetailFetch<FileEnvelope<FileReviewDetail>>({
    fetcher: (signal) => getApiClient().getFileReview(slug, depName, pathHash, { signal }),
    deps: [slug, depName, pathHash]
  });

  // Abort controller for the SSE job-wait. See DependencyDetailView for rationale.
  const jobWaitAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      jobWaitAbortRef.current?.abort();
      jobWaitAbortRef.current = null;
    };
  }, [slug, depName, pathHash]);

  const onRegenerate = async () => {
    jobWaitAbortRef.current?.abort();
    const controller = new AbortController();
    jobWaitAbortRef.current = controller;

    fetch.setRegenerating(true);
    try {
      const { jobId } = await getApiClient().refreshFileReview(slug, depName, pathHash);
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

  if (fetch.status === 'loading' && !fetch.data) {
    return (
      <div className={styles.loading} role="status">
        Loading file review…
      </div>
    );
  }

  if (fetch.status === 'missing') {
    if (fetch.regenerating) {
      return (
        <div className={styles.loading} role="status" aria-live="polite">
          <p>
            Running AI review for <strong>{filePath}</strong>…
          </p>
          <p>Progress shown in the status bar below.</p>
        </div>
      );
    }
    return (
      <EmptyStateCTA
        title="No review yet."
        description={`Run an AI review for ${filePath}.`}
        actionLabel="Run review"
        onAction={onRegenerate}
        busy={fetch.regenerating}
      />
    );
  }

  if (fetch.status === 'error' || !fetch.data) {
    return (
      <div className={styles.errorBanner} role="alert">
        <p className={styles.errorTitle}>Failed to load file review.</p>
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
  const ttlStale = isStale(envelope.generatedAt, envelope.ttlHours);
  const fileStale = detail.stale;

  return (
    <div className={styles.body}>
      <div className={styles.viewHeader}>
        <CacheFreshnessLine
          status={ttlStale ? 'stale' : 'fresh'}
          generatedAtIso={envelope.generatedAt}
          onRegenerate={onRegenerate}
        />
        <RegenerateButton onClick={onRegenerate} busy={fetch.regenerating} />
      </div>

      {fileStale && (
        <div
          className={styles.staleBanner}
          role="status"
          data-testid="file-stale-banner"
        >
          <span className={styles.staleGlyph} aria-hidden="true">
            ▮
          </span>
          <span className={styles.staleMessage}>
            File changed since this review.
          </span>
          <button
            type="button"
            className={styles.staleAction}
            onClick={onRegenerate}
            data-testid="file-stale-regenerate"
          >
            Regenerate
          </button>
        </div>
      )}

      <header className={styles.header}>
        <code className={styles.filePath} data-testid="file-review-path">
          {detail.filePath}
        </code>
        <span className={styles.lastReviewed} data-testid="last-reviewed">
          Last reviewed: {formatRelativeTime(detail.lastReviewedAt)}
        </span>
      </header>

      <section className={styles.section} aria-label="Summary">
        <h3 className={styles.sectionTitle}>Summary</h3>
        <p className={styles.summaryBody}>{detail.summary}</p>
      </section>

      <div className={styles.qualityRow}>
        <span className={styles.qualityLabel}>Quality:</span>
        <QualityPill quality={detail.depUsageQuality} />
      </div>

      <section className={styles.section} aria-label="Findings">
        <h3 className={styles.sectionTitle}>
          Findings
          <span className={styles.sectionCount}> ({detail.findings.length})</span>
        </h3>
        {detail.findings.length === 0 ? (
          <p className={styles.muted} data-testid="findings-empty">
            No findings — usage looks correct and modern.
          </p>
        ) : (
          <ul role="list" className={styles.findingsList}>
            {detail.findings.map((finding, i) => (
              <FindingRow key={i} finding={finding} index={i} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function QualityPill({ quality }: { quality: FileReviewDetail['depUsageQuality'] }): JSX.Element {
  const cls = {
    good: styles.qualityGood,
    outdated: styles.qualityMid,
    incorrect: styles.qualityBad,
    risky: styles.qualityBad,
    unknown: styles.qualityNeutral
  }[quality];
  return (
    <span
      className={[styles.qualityPill, cls].filter(Boolean).join(' ')}
      data-testid={`quality-pill-${quality}`}
    >
      {quality}
    </span>
  );
}

function FindingRow({ finding, index }: { finding: ReviewFinding; index: number }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = Boolean(finding.suggestion) || finding.confidence !== 'high' || finding.line !== undefined;
  return (
    <li
      role="listitem"
      className={styles.findingRow}
      data-testid={`finding-${index}`}
    >
      <button
        type="button"
        className={styles.findingHeader}
        aria-expanded={expanded}
        onClick={() => hasDetails && setExpanded((v) => !v)}
        disabled={!hasDetails}
      >
        <SeverityPill severity={finding.severity} />
        <KindPill kind={finding.kind} />
        {finding.line !== undefined && (
          <span className={styles.findingLine} data-testid={`finding-${index}-line`}>
            line {finding.line}
          </span>
        )}
        <span className={styles.findingMessage}>{finding.message}</span>
        {hasDetails && (
          <span className={styles.findingChevron} aria-hidden="true">
            {expanded ? '▾' : '▸'}
          </span>
        )}
      </button>
      {expanded && (
        <div className={styles.findingDetails} data-testid={`finding-${index}-details`}>
          {finding.suggestion && (
            <p className={styles.findingSuggestion}>
              <strong>Suggestion:</strong> {finding.suggestion}
            </p>
          )}
          <p className={styles.findingConfidence}>
            <strong>Confidence:</strong> {finding.confidence}
          </p>
        </div>
      )}
    </li>
  );
}

function SeverityPill({ severity }: { severity: FindingSeverity }): JSX.Element {
  const cls = {
    critical: styles.sevCrit,
    high: styles.sevHigh,
    medium: styles.sevMid,
    low: styles.sevLow,
    info: styles.sevInfo
  }[severity];
  return (
    <span
      className={[styles.sevPill, cls].filter(Boolean).join(' ')}
      data-testid={`finding-sev-${severity}`}
    >
      {severity}
    </span>
  );
}

function KindPill({ kind }: { kind: ReviewFinding['kind'] }): JSX.Element {
  return (
    <span className={styles.kindPill} data-testid={`finding-kind-${kind}`}>
      {kind}
    </span>
  );
}
