'use client';

import { useEffect, useRef, useState } from 'react';
import { ApiError, getApiClient } from '@/lib/client/api-client';
import type {
  CveDeltaEntry,
  DeepCriticalBlocker,
  DeepUpdateReportDetail,
  DeepUpgradeStep,
  FileEnvelope,
  PeerDepOnTarget
} from '@/lib/api-types';
import { useDetailFetch } from '@/lib/client/useDetailFetch';
import { triggerDownload } from '@/lib/client/download';
import { useAppContext } from '../AppContext';
import { CacheFreshnessLine, isStale } from './CacheFreshnessLine';
import { EmptyStateCTA } from './EmptyStateCTA';
import { RegenerateButton } from './RegenerateButton';
import { Button } from '../modals/Button';
import styles from './DeepUpdateReportView.module.css';

interface Props {
  slug: string;
  depName: string;
  fromVersion: string;
  toVersion: string;
}

/**
 * View [D-Deep] — Deep Update Report (spec §7.6, §11.6, Appendix A.4, Wireframe 13).
 *
 * Renders the union of [D]'s deterministic + AI fields and the L2/L3
 * additions: transitive impact tiles, CVE delta, peer-dep conflicts across
 * the transitive graph, critical blockers, AI narrative (length adapts to
 * risk per §7.6), suggested upgrade order, estimated effort pill.
 *
 * Cache-first per §3.2: GET 404 NOT_CACHED → empty-state CTA. Download
 * button hits `…/download?format=md|html`; 404 surfaces a friendly "Generate
 * the report first" message.
 */
export function DeepUpdateReportView({
  slug,
  depName,
  fromVersion,
  toVersion
}: Props): JSX.Element {
  const { navigate } = useAppContext();
  const fetch = useDetailFetch<FileEnvelope<DeepUpdateReportDetail>>({
    fetcher: (signal) =>
      getApiClient().getDeepUpdateReport(slug, depName, fromVersion, toVersion, { signal }),
    deps: [slug, depName, fromVersion, toVersion]
  });

  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<'md' | 'html' | null>(null);

  // Abort controller for the SSE job-wait. See DependencyDetailView for rationale.
  const jobWaitAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      jobWaitAbortRef.current?.abort();
      jobWaitAbortRef.current = null;
    };
  }, [slug, depName, fromVersion, toVersion]);

  const onRegenerate = async () => {
    jobWaitAbortRef.current?.abort();
    const controller = new AbortController();
    jobWaitAbortRef.current = controller;

    fetch.setRegenerating(true);
    try {
      const { jobId } = await getApiClient().refreshDeepUpdateReport(
        slug,
        depName,
        fromVersion,
        toVersion
      );
      // L2 transitive fetch + L3 AI can take minutes; wait for `done` SSE.
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

  const onDownload = async (format: 'md' | 'html') => {
    setDownloading(format);
    setDownloadError(null);
    try {
      const payload = await getApiClient().downloadDeepUpdateReport(
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
        const message = err instanceof Error ? err.message : 'Download failed.';
        setDownloadError(message);
      }
    } finally {
      setDownloading(null);
    }
  };

  const onBackToUpdateReport = () => {
    navigate({ kind: 'D', depName, fromVersion, toVersion });
  };

  if (fetch.status === 'loading' && !fetch.data) {
    return (
      <div className={styles.loading} role="status">
        Loading deep update report…
      </div>
    );
  }

  if (fetch.status === 'missing') {
    if (fetch.regenerating) {
      return (
        <div className={styles.loading} role="status" aria-live="polite">
          <p>
            Generating deep update report for <strong>{depName}</strong> v{fromVersion} → v
            {toVersion}…
          </p>
          <p>
            Fetching transitive packages, computing CVE delta, then running the AI
            narrative. This can take a few minutes the first time per project.
            Progress shown in the status bar below.
          </p>
        </div>
      );
    }
    return (
      <EmptyStateCTA
        title="No deep analysis yet."
        description={`Generate a deep update report for ${depName} v${fromVersion} → v${toVersion}.`}
        actionLabel="Generate deep report"
        onAction={onRegenerate}
        busy={fetch.regenerating}
      />
    );
  }

  if (fetch.status === 'error' || !fetch.data) {
    return (
      <div className={styles.errorBanner} role="alert">
        <p className={styles.errorTitle}>Failed to load deep update report.</p>
        <p className={styles.errorBody}>
          {fetch.error ?? 'Please retry. If the problem persists, regenerate.'}
        </p>
        <RegenerateButton onClick={onRegenerate} busy={fetch.regenerating} />
      </div>
    );
  }

  const envelope = fetch.data;
  const detail = envelope.data;
  const stale = isStale(envelope.generatedAt, envelope.ttlHours);
  const peerDepsOnTarget = detail.lockfileSummary?.peerDepsOnTarget ?? [];
  const totalPackages = detail.lockfileSummary?.totalPackages ?? 0;

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

      <section className={styles.section} aria-label="Summary">
        <h3 className={styles.sectionTitle}>Summary</h3>
        <p className={styles.summaryBody}>{detail.summary}</p>
      </section>

      <div className={styles.riskRow}>
        <span className={styles.riskLabel}>Risk:</span>
        <RiskPill level={detail.riskLevel} />
        <span className={styles.effortLabel}>Estimated effort:</span>
        <EffortPill effort={detail.estimatedEffort} />
      </div>

      <section className={styles.section} aria-label="Transitive impact">
        <h3 className={styles.sectionTitle}>Transitive impact</h3>
        <div className={styles.tileRow}>
          <Tile label="Added" value={detail.transitiveDelta.packagesAdded.length} />
          <Tile label="Removed" value={detail.transitiveDelta.packagesRemoved.length} />
          <Tile label="Upgraded" value={detail.transitiveDelta.packagesUpgraded.length} />
        </div>
        <p className={styles.tileFootnote}>
          {totalPackages.toLocaleString()} transitive packages total.
        </p>
      </section>

      <section className={styles.section} aria-label="CVE delta">
        <h3 className={styles.sectionTitle}>CVE delta</h3>
        <div className={styles.cveBlock}>
          <p className={styles.cveSubhead} data-testid="cve-resolved-head">
            ✓ Resolved by upgrade ({detail.cveDelta.resolvedCves.length})
          </p>
          {detail.cveDelta.resolvedCves.length === 0 ? (
            <p className={styles.muted}>None.</p>
          ) : (
            <ul role="list" className={styles.cveList}>
              {detail.cveDelta.resolvedCves.map((c) => (
                <CveDeltaRow key={`resolved-${c.id}`} entry={c} kind="resolved" />
              ))}
            </ul>
          )}
        </div>
        <div className={styles.cveBlock}>
          <p className={styles.cveSubheadWarn} data-testid="cve-new-head">
            ⚠ New CVEs introduced ({detail.cveDelta.newCves.length})
          </p>
          {detail.cveDelta.newCves.length === 0 ? (
            <p className={styles.muted}>None.</p>
          ) : (
            <ul role="list" className={styles.cveList}>
              {detail.cveDelta.newCves.map((c) => (
                <CveDeltaRow key={`new-${c.id}`} entry={c} kind="new" />
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className={styles.section} aria-label="Peer-dep conflicts across transitive graph">
        <h3 className={styles.sectionTitle}>
          Peer-dep conflicts
          <span className={styles.sectionCount}>
            {' '}({peerDepsOnTarget.length})
          </span>
        </h3>
        {peerDepsOnTarget.length === 0 ? (
          <p className={styles.muted}>No peer-dep declarers on this target.</p>
        ) : (
          <ul role="list" className={styles.peerList}>
            {peerDepsOnTarget.map((p) => (
              <PeerDepRow key={`${p.package}-${p.version}`} entry={p} />
            ))}
          </ul>
        )}
      </section>

      {detail.criticalBlockers.length > 0 && (
        <section className={styles.section} aria-label="Critical blockers">
          <h3 className={styles.sectionTitle}>
            Critical blockers
            <span className={styles.sectionCount}>
              {' '}({detail.criticalBlockers.length})
            </span>
          </h3>
          <ul role="list" className={styles.blockerList}>
            {detail.criticalBlockers.map((b, i) => (
              <BlockerRow key={`${b.package}-${i}`} blocker={b} />
            ))}
          </ul>
        </section>
      )}

      <section
        className={styles.section}
        aria-label="AI narrative"
        data-testid="ai-narrative-section"
      >
        <h3 className={styles.sectionTitle}>Narrative</h3>
        <Narrative narrative={detail.narrative} />
      </section>

      {detail.suggestedUpgradeOrder.length > 0 && (
        <section className={styles.section} aria-label="Suggested upgrade order">
          <h3 className={styles.sectionTitle}>Suggested upgrade order</h3>
          <ol className={styles.orderList} data-testid="upgrade-order-list">
            {detail.suggestedUpgradeOrder
              .slice()
              .sort((a, b) => a.step - b.step)
              .map((s) => (
                <UpgradeOrderStep key={s.step} step={s} />
              ))}
          </ol>
        </section>
      )}

      <section className={styles.section} aria-label="Shared with update report">
        <h3 className={styles.sectionTitleSmall}>From the update report</h3>
        <ul className={styles.sharedList}>
          <li>Co-upgrade deps ({detail.coUpgradeDeps.length}) — see Update Report.</li>
        </ul>
        <button
          type="button"
          className={styles.backLink}
          onClick={onBackToUpdateReport}
          data-testid="back-to-update-report"
        >
          ← Back to Update Report
        </button>
      </section>

      {downloadError && (
        <div className={styles.downloadError} role="alert" data-testid="download-error">
          {downloadError}
        </div>
      )}

      <div className={styles.actions}>
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
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function RiskPill({
  level
}: {
  level: 'low' | 'medium' | 'high' | 'critical';
}): JSX.Element {
  const cls =
    level === 'critical' || level === 'high'
      ? styles.riskHigh
      : level === 'medium'
        ? styles.riskMid
        : styles.riskLow;
  return (
    <span
      className={[styles.riskPill, cls].join(' ')}
      data-testid={`risk-pill-${level}`}
    >
      {level}
    </span>
  );
}

function EffortPill({
  effort
}: {
  effort: 'small' | 'medium' | 'large' | 'very-large';
}): JSX.Element {
  const cls =
    effort === 'small'
      ? styles.effortSmall
      : effort === 'medium'
        ? styles.effortMedium
        : effort === 'large'
          ? styles.effortLarge
          : styles.effortVeryLarge;
  return (
    <span
      className={[styles.effortPill, cls].join(' ')}
      data-testid={`effort-pill-${effort}`}
    >
      {effort}
    </span>
  );
}

function Tile({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className={styles.tile} data-testid={`tile-${label.toLowerCase()}`}>
      <span className={styles.tileLabel}>{label}</span>
      <span className={styles.tileValue}>{value}</span>
    </div>
  );
}

function severityClass(severity: string): string {
  if (severity === 'critical' || severity === 'high') return styles.sevHigh!;
  if (severity === 'medium' || severity === 'moderate') return styles.sevMed!;
  if (severity === 'low') return styles.sevLow!;
  return styles.sevUnknown!;
}

function CveDeltaRow({
  entry,
  kind
}: {
  entry: CveDeltaEntry;
  kind: 'resolved' | 'new';
}): JSX.Element {
  return (
    <li
      role="listitem"
      className={styles.cveRow}
      data-testid={`cve-${kind}-${entry.id}`}
    >
      <code className={styles.cveId}>{entry.id}</code>
      <span className={[styles.severityPill, severityClass(entry.severity)].join(' ')}>
        {entry.severity}
      </span>
      <span className={styles.cveMeta}>
        in {entry.package}
        {kind === 'new' && entry.summary ? ` — ${entry.summary}` : ''}
      </span>
    </li>
  );
}

function PeerDepRow({ entry }: { entry: PeerDepOnTarget }): JSX.Element {
  return (
    <li
      role="listitem"
      className={styles.peerRow}
      data-testid={`peer-${entry.package}`}
    >
      <span aria-hidden="true" className={styles.peerGlyph}>
        {entry.satisfiedByCandidate ? '✓' : '⚠'}
      </span>
      <code className={styles.peerName}>
        {entry.package}@{entry.version}
      </code>
      <span className={styles.peerDetail}>
        peer <code>{entry.peerRange}</code>{' '}
        {entry.satisfiedByCandidate ? 'satisfied' : 'not satisfied'}
      </span>
      <span
        className={[
          styles.peerStatusPill,
          entry.satisfiedByCandidate ? styles.peerOk : styles.peerBad
        ].join(' ')}
      >
        {entry.satisfiedByCandidate ? 'OK' : 'Conflict'}
      </span>
    </li>
  );
}

function BlockerRow({ blocker }: { blocker: DeepCriticalBlocker }): JSX.Element {
  return (
    <li
      role="listitem"
      className={styles.blockerRow}
      data-testid={`blocker-${blocker.package}`}
    >
      <strong className={styles.blockerTitle}>{blocker.title}</strong>
      <p className={styles.blockerDescription}>{blocker.description}</p>
      <code className={styles.blockerPackage}>{blocker.package}</code>
    </li>
  );
}

/**
 * Renders the AI narrative. Spec §7.6: length adapts to risk level. We split
 * on blank lines into paragraphs so the BE's "1 paragraph for low / 3-4 for
 * high" prompt outputs render naturally.
 */
function Narrative({ narrative }: { narrative: string }): JSX.Element {
  const paragraphs = narrative
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paragraphs.length === 0) {
    return <p className={styles.muted}>No narrative provided.</p>;
  }
  return (
    <div
      className={styles.narrative}
      data-testid="narrative-body"
      data-paragraph-count={paragraphs.length}
    >
      {paragraphs.map((p, i) => (
        <p key={i} className={styles.narrativePara}>
          {p}
        </p>
      ))}
    </div>
  );
}

function UpgradeOrderStep({ step }: { step: DeepUpgradeStep }): JSX.Element {
  return (
    <li className={styles.orderItem} data-testid={`upgrade-step-${step.step}`}>
      <span className={styles.orderStepNum}>{step.step}</span>
      <div className={styles.orderText}>
        <p className={styles.orderAction}>{step.action}</p>
        <p className={styles.orderRationale}>{step.rationale}</p>
      </div>
    </li>
  );
}
