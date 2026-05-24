'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { getApiClient } from '@/lib/client/api-client';
import type {
  AvailableVersion,
  CveRecord,
  DepDetail,
  FileEnvelope,
  RelatedDep,
  RelatedDepReason
} from '@/lib/api-types';
import { useDetailFetch } from '@/lib/client/useDetailFetch';
import { findInstalledVersion } from '@/lib/client/findInstalledVersion';
import { useAppContext } from '../AppContext';
import { CacheFreshnessLine, isStale } from './CacheFreshnessLine';
import { CollapsibleSection } from './CollapsibleSection';
import { EmptyStateCTA } from './EmptyStateCTA';
import { RegenerateButton } from './RegenerateButton';
import { Button } from '../modals/Button';
import styles from './DependencyDetailView.module.css';

interface Props {
  slug: string;
  depName: string;
}

/** Group versions by major and return sorted majors with the latest entry per major. */
function groupByMajor(versions: AvailableVersion[]): Map<string, AvailableVersion[]> {
  const byMajor = new Map<string, AvailableVersion[]>();
  for (const v of versions) {
    const major = v.version.split('.')[0] ?? '0';
    const arr = byMajor.get(major) ?? [];
    arr.push(v);
    byMajor.set(major, arr);
  }
  // Sort each major's entries by semver descending; sort majors descending.
  for (const [major, arr] of byMajor) {
    arr.sort((a, b) => compareSemver(b.version, a.version));
    byMajor.set(major, arr);
  }
  return new Map(
    [...byMajor.entries()].sort((a, b) => Number(b[0]) - Number(a[0]))
  );
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((p) => parseInt(p, 10) || 0);
  const pb = b.split('.').map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
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

export function DependencyDetailView({ slug, depName }: Props): JSX.Element {
  const { navigate, pushToast, activeProject } = useAppContext();
  const fetch = useDetailFetch<FileEnvelope<DepDetail>>({
    fetcher: (signal) => getApiClient().getDepDetail(slug, depName, { signal }),
    deps: [slug, depName]
  });
  // Resolves direct deps + Volta toolchain entries. Used to filter the
  // Available versions section to "since installed only" — see the
  // DependencyDetailBody for the actual filter.
  const installedVersion = findInstalledVersion(activeProject, depName);

  // Abort controller for the SSE-based job-wait. If the user switches away
  // (component unmounts or slug/dep changes), we abort to stop EventSource
  // and avoid setState-after-unmount.
  const jobWaitAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      jobWaitAbortRef.current?.abort();
      jobWaitAbortRef.current = null;
    };
  }, [slug, depName]);

  // "Re-scan all deps" busy state. Distinct from `fetch.regenerating` so the
  // button can show its own "Re-scanning…" label while the (longer-running)
  // Phase 2 + per-dep refresh chain runs.
  const [rescanningAll, setRescanningAll] = useState(false);

  const onRegenerate = async () => {
    // Cancel any prior in-flight job-wait before starting a new one.
    jobWaitAbortRef.current?.abort();
    const controller = new AbortController();
    jobWaitAbortRef.current = controller;

    fetch.setRegenerating(true);
    try {
      const { jobId } = await getApiClient().refreshDepDetail(slug, depName);
      // POST returns when the job is ENQUEUED. Wait for the job's `done` SSE
      // event before reloading — otherwise the GET would still 404 NOT_CACHED
      // and the UI would flip back to the empty-state CTA.
      await getApiClient().awaitJob(jobId, { signal: controller.signal });
      if (controller.signal.aborted) return;
      fetch.reload();
    } catch (err) {
      // Aborted → user switched away or clicked Cancel; silent.
      if (controller.signal.aborted || (err as Error).name === 'AbortError') return;
      // Non-abort errors must be visible. Without this, a 404 (e.g. server
      // rejecting `node` from `project.dependencies`) silently flips the UI
      // back to the empty CTA — looks like the click did nothing.
      const message =
        err instanceof Error ? err.message : 'Generation failed; please try again.';
      pushToast({
        severity: 'error',
        title: `Couldn't generate analysis for ${depName}`,
        body: message
      });
    } finally {
      if (jobWaitAbortRef.current === controller) jobWaitAbortRef.current = null;
      fetch.setRegenerating(false);
    }
  };

  /**
   * Re-scan every dep in the project (full Phase 2), then refresh the currently
   * viewed dep so its `relatedDeps[]` is recomputed against fresh sibling caches.
   *
   * Motivation: the "Related deps in this project" list depends on every other
   * dep's packument being current — specifically `latestPeerDeps` and
   * `latestEngines`, which are only present in caches written by v0.4+. If a
   * sibling (e.g. `next`) was last scanned by an older build, its packument
   * cache lacks `latestEngines`, so the viewed dep (`node`) won't see it as an
   * inbound-engine relation. Clicking this button forces a full re-fetch of
   * every dep's packument so the next computation sees the v0.4 shape on every
   * sibling.
   */
  const onRescanAllDeps = async () => {
    jobWaitAbortRef.current?.abort();
    const controller = new AbortController();
    jobWaitAbortRef.current = controller;

    setRescanningAll(true);
    fetch.setRegenerating(true);
    try {
      // Phase 2: re-fetch every dep's packument + CVE record + write each
      // `deps/<name>.json` cache.
      const scanResult = await getApiClient().scanProject(slug, { signal: controller.signal });
      await getApiClient().awaitJob(scanResult.jobId, { signal: controller.signal });
      if (controller.signal.aborted) return;
      // Now refresh the currently viewed dep so its `relatedDeps[]` is
      // recomputed against the fresh sibling caches.
      const depRefresh = await getApiClient().refreshDepDetail(slug, depName, {
        signal: controller.signal
      });
      await getApiClient().awaitJob(depRefresh.jobId, { signal: controller.signal });
      if (controller.signal.aborted) return;
      fetch.reload();
    } catch (err) {
      if (controller.signal.aborted || (err as Error).name === 'AbortError') return;
      const message =
        err instanceof Error ? err.message : 'Re-scan failed; please try again.';
      pushToast({
        severity: 'error',
        title: `Couldn't re-scan dependencies`,
        body: message
      });
    } finally {
      if (jobWaitAbortRef.current === controller) jobWaitAbortRef.current = null;
      setRescanningAll(false);
      fetch.setRegenerating(false);
    }
  };

  if (fetch.status === 'loading' && !fetch.data) {
    return (
      <div className={styles.loading} role="status">
        Loading dependency detail…
      </div>
    );
  }

  // When the user clicks "Generate analysis" the missing-cache path runs:
  // POST refresh fires, the job is enqueued, and we wait for it via SSE.
  // During that wait, render a clear "Generating…" panel instead of the
  // empty CTA — otherwise the panel looks unresponsive.
  if (fetch.status === 'missing') {
    if (fetch.regenerating) {
      return (
        <div className={styles.loading} role="status" aria-live="polite">
          <p>
            Generating analysis for <strong>{depName}</strong>…
          </p>
          <p>
            Fetching registry metadata and CVE data. Progress shown in the
            status bar below.
          </p>
        </div>
      );
    }
    return (
      <EmptyStateCTA
        title="No analysis yet."
        description={`Generate the dependency detail for ${depName}.`}
        actionLabel="Generate analysis"
        onAction={onRegenerate}
        busy={fetch.regenerating}
      />
    );
  }

  if (fetch.status === 'error' || !fetch.data) {
    return (
      <div className={styles.errorBanner} role="alert">
        <p className={styles.errorTitle}>Failed to load dependency detail.</p>
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

  return (
    <DependencyDetailBody
      slug={slug}
      depName={depName}
      envelope={fetch.data}
      onNavigate={navigate}
      onRegenerate={onRegenerate}
      regenerating={fetch.regenerating}
      onRescanAllDeps={onRescanAllDeps}
      rescanningAll={rescanningAll}
      installedVersion={installedVersion}
    />
  );
}

interface BodyProps {
  slug: string;
  depName: string;
  envelope: FileEnvelope<DepDetail>;
  onNavigate: (
    route:
      | { kind: 'A'; depName: string }
      | { kind: 'B'; depName: string; version: string }
      | { kind: 'C'; depName: string }
  ) => void;
  onRegenerate: () => void;
  regenerating: boolean;
  onRescanAllDeps: () => void;
  rescanningAll: boolean;
  /** Installed version (resolved via findInstalledVersion); drives "since installed only". */
  installedVersion: string | null;
}

function DependencyDetailBody({
  envelope,
  depName,
  onNavigate,
  onRegenerate,
  regenerating,
  onRescanAllDeps,
  rescanningAll,
  installedVersion
}: BodyProps): JSX.Element {
  const detail = envelope.data;
  const stale = isStale(envelope.generatedAt, envelope.ttlHours);
  // Defensive: `relatedDeps` was added in v0.3. Envelopes written by an
  // earlier build lack the field, so we treat undefined as an empty list.
  // Clicking Regenerate re-runs the refresh route which writes the new shape.
  const relatedDeps = detail.relatedDeps ?? [];
  // Default: only show versions newer than the installed one (v0.5). Users
  // who want to see older versions toggle this off. When `installedVersion`
  // is null (we couldn't resolve it from the project), we have no anchor to
  // compare against, so the filter is a no-op regardless of the toggle.
  const [sinceInstalledOnly, setSinceInstalledOnly] = useState(true);
  const [expandedMajors, setExpandedMajors] = useState<Set<string>>(new Set());
  const allVersions = useMemo(() => {
    if (!sinceInstalledOnly || installedVersion === null) return detail.availableVersions;
    return detail.availableVersions.filter((v) => compareSemver(v.version, installedVersion) > 0);
  }, [detail.availableVersions, sinceInstalledOnly, installedVersion]);
  const majors = useMemo(() => groupByMajor(allVersions), [allVersions]);

  const toggleMajor = (major: string) => {
    setExpandedMajors((prev) => {
      const next = new Set(prev);
      if (next.has(major)) next.delete(major);
      else next.add(major);
      return next;
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
        <RegenerateButton onClick={onRegenerate} busy={regenerating} />
      </div>
      {detail.deprecation && (
        <div className={styles.deprecationBanner} role="alert" data-testid="deprecation-banner">
          <span aria-hidden="true" className={styles.deprecationGlyph}>
            ⊘
          </span>
          <div>
            <strong>Deprecated</strong>
            <p className={styles.deprecationMessage}>{detail.deprecation.message}</p>
            {detail.deprecation.replacementSuggestion && (
              <p className={styles.deprecationMessage}>
                Replacement: <code>{detail.deprecation.replacementSuggestion}</code>
              </p>
            )}
          </div>
        </div>
      )}

      {detail.currentVersionCves === null && (
        <div className={styles.amberBanner} role="status" data-testid="cve-unavailable-banner">
          CVE data unavailable — try Regenerate later.
        </div>
      )}

      <header className={styles.header}>
        <h2 className={styles.depTitle}>{depName}</h2>
        <Button onClick={() => onNavigate({ kind: 'C', depName })} data-testid="view-usage-button">
          View Usage
        </Button>
      </header>

      <dl className={styles.meta}>
        {detail.license && (
          <div className={styles.metaRow}>
            <dt>License</dt>
            <dd>{detail.license}</dd>
          </div>
        )}
        {detail.support.homepage && (
          <div className={styles.metaRow}>
            <dt>Homepage</dt>
            <dd>
              <a href={detail.support.homepage} target="_blank" rel="noreferrer noopener">
                {detail.support.homepage}
              </a>
            </dd>
          </div>
        )}
        {detail.support.repository && (
          <div className={styles.metaRow}>
            <dt>Repository</dt>
            <dd>
              <a href={detail.support.repository} target="_blank" rel="noreferrer noopener">
                {detail.support.repository}
              </a>
            </dd>
          </div>
        )}
        {detail.support.lastPublishAt && (
          <div className={styles.metaRow}>
            <dt>Last publish</dt>
            <dd>{new Date(detail.support.lastPublishAt).toISOString().slice(0, 10)}</dd>
          </div>
        )}
      </dl>

      <section className={styles.section} aria-label="Current vulnerabilities">
        <h3 className={styles.sectionTitle}>
          Current vulnerabilities
          {detail.currentVersionCves !== null && (
            <span className={styles.sectionCount}> ({detail.currentVersionCves.length})</span>
          )}
        </h3>
        {detail.currentVersionCves === null ? (
          <p className={styles.muted}>Data unavailable.</p>
        ) : detail.currentVersionCves.length === 0 ? (
          <p className={styles.cleanLine} data-testid="cve-clean">
            No known CVEs in the installed version.
          </p>
        ) : (
          <ul role="list" className={styles.cveList}>
            {detail.currentVersionCves.map((cve) => (
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

      <CollapsibleSection
        ariaLabel="Related dependencies"
        title="Related deps in this project"
        count={relatedDeps.length}
        sectionClassName={styles.section}
        headerClassName={styles.sectionHeader}
        titleClassName={styles.sectionTitle}
        countClassName={styles.sectionCount}
        testId="related-deps-collapse"
        headerAction={
          <Button
            onClick={onRescanAllDeps}
            disabled={rescanningAll || regenerating}
            title="Re-fetch every dep's npm packument so engines / peerDeps signals are fresh. Useful when a sibling's cache predates v0.4 and is missing 'latestEngines'."
            data-testid="rescan-all-deps-button"
          >
            {rescanningAll ? 'Re-scanning…' : 'Re-scan all deps'}
          </Button>
        }
      >
        {relatedDeps.length === 0 ? (
          <p className={styles.muted} data-testid="related-deps-empty">
            None detected. (Other deps' caches must be populated — run Phase 2 / refresh them first.)
          </p>
        ) : (
          <ul role="list" className={styles.cveList} data-testid="related-deps-list">
            {relatedDeps.map((rel) => (
              <RelatedDepRow
                key={rel.name}
                rel={rel}
                viewedName={depName}
                onNavigate={onNavigate}
              />
            ))}
          </ul>
        )}
      </CollapsibleSection>

      <CollapsibleSection
        ariaLabel="Available versions"
        title="Available versions"
        count={allVersions.length}
        sectionClassName={styles.section}
        headerClassName={styles.sectionHeader}
        titleClassName={styles.sectionTitle}
        countClassName={styles.sectionCount}
        testId="available-versions-collapse"
        headerAction={
          <label className={styles.toggleLabel}>
            <input
              type="checkbox"
              checked={sinceInstalledOnly}
              onChange={(e) => setSinceInstalledOnly(e.target.checked)}
              data-testid="since-installed-toggle"
              disabled={installedVersion === null}
              title={
                installedVersion === null
                  ? 'Installed version unknown; filter has no effect.'
                  : 'Toggle off to see ALL versions, including older ones.'
              }
            />
            Since installed only
          </label>
        }
      >
        {installedVersion !== null && sinceInstalledOnly && (
          <p
            className={styles.muted}
            data-testid="available-versions-filter-hint"
            style={{ margin: 0 }}
          >
            Showing versions newer than installed <code>{installedVersion}</code>.
          </p>
        )}
        {allVersions.length === 0 ? (
          <p className={styles.muted} data-testid="available-versions-empty">
            {sinceInstalledOnly && installedVersion !== null
              ? `No newer versions than ${installedVersion} — you're on the latest known release.`
              : 'No versions found.'}
          </p>
        ) : (
        <ul role="list" className={styles.majorList}>
          {[...majors.entries()].map(([major, versions]) => {
            const latest = versions[0];
            if (!latest) return null;
            const isOpen = expandedMajors.has(major);
            return (
              <li role="listitem" key={major} className={styles.majorRow}>
                <button
                  type="button"
                  className={styles.majorHeader}
                  aria-expanded={isOpen}
                  onClick={() => toggleMajor(major)}
                  data-testid={`major-toggle-${major}`}
                >
                  <span aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                  <span className={styles.majorLabel}>{major}.x</span>
                  <span className={styles.majorLatest}>
                    latest {latest.version}
                    {latest.publishedAt && ` (${latest.publishedAt.slice(0, 10)})`}
                  </span>
                </button>
                {isOpen && (
                  <ul role="list" className={styles.versionList}>
                    {versions.map((v) => (
                      <li role="listitem" key={v.version}>
                        <button
                          type="button"
                          className={styles.versionLink}
                          onClick={() => onNavigate({ kind: 'B', depName, version: v.version })}
                          data-testid={`version-link-${v.version}`}
                        >
                          <span className={styles.versionNumber}>{v.version}</span>
                          {v.publishedAt && (
                            <span className={styles.versionDate}>
                              {v.publishedAt.slice(0, 10)}
                            </span>
                          )}
                          {v.isPrerelease && (
                            <span className={styles.prereleaseTag} aria-label="prerelease">
                              prerelease
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
        )}
      </CollapsibleSection>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Related deps row                                                             */
/* -------------------------------------------------------------------------- */

const REASON_LABEL: Record<RelatedDepReason['kind'], string> = {
  naming: 'naming',
  'inbound-peer-dep': 'peer-dep ←',
  'outbound-peer-dep': 'peer-dep →',
  'inbound-engine': 'engine ←',
  'outbound-engine': 'engine →'
};

function reasonPhrase(reason: RelatedDepReason, viewedName: string, relName: string): JSX.Element {
  switch (reason.kind) {
    case 'inbound-peer-dep':
      return (
        <>
          <code>{relName}</code> declares <code>peerDependencies.{viewedName}</code>
          {reason.range !== null ? <> = <code>{reason.range}</code></> : null}
        </>
      );
    case 'outbound-peer-dep':
      return (
        <>
          <code>{viewedName}</code> declares <code>peerDependencies.{relName}</code>
          {reason.range !== null ? <> = <code>{reason.range}</code></> : null}
        </>
      );
    case 'inbound-engine':
      return (
        <>
          <code>{relName}</code> declares <code>engines.{viewedName}</code>
          {reason.range !== null ? <> = <code>{reason.range}</code></> : null}
        </>
      );
    case 'outbound-engine':
      return (
        <>
          <code>{viewedName}</code> declares <code>engines.{relName}</code>
          {reason.range !== null ? <> = <code>{reason.range}</code></> : null}
        </>
      );
    case 'naming':
      return (
        <>
          typings package — moves in lockstep with <code>{viewedName}</code>
        </>
      );
  }
}

/**
 * Defensive default for `RelatedDep.health` + `reasons[]`. Caches written
 * before v0.4 carry the old shape (`reason` singular, no `health` block);
 * the renderer needs to not crash on those. Old rows degrade to "no badges,
 * no reasons" until the dep is regenerated.
 */
const EMPTY_HEALTH: RelatedDep['health'] = {
  deprecated: null,
  cveCount: null,
  maxCveSeverity: null,
  eol: null,
  ageDays: null
};

function RelatedDepRow({
  rel,
  viewedName,
  onNavigate
}: {
  rel: RelatedDep;
  viewedName: string;
  /**
   * Navigation callback. Clicking the dep name routes to that dep's own
   * view [A]. We pass the parent's callback (not a fresh one) so the route
   * goes through the AppContext dispatcher just like every other navigation.
   */
  onNavigate: (
    route:
      | { kind: 'A'; depName: string }
      | { kind: 'B'; depName: string; version: string }
      | { kind: 'C'; depName: string }
  ) => void;
}): JSX.Element {
  const health = rel.health ?? EMPTY_HEALTH;
  const reasons = Array.isArray(rel.reasons) ? rel.reasons : [];
  // If the related dep IS the currently-viewed dep (degenerate edge case —
  // self-relations shouldn't exist but the renderer must not crash), skip
  // the link and render plain text so the user doesn't click and get a
  // no-op route change.
  const isSelf = rel.name === viewedName;
  return (
    <li
      role="listitem"
      className={styles.cveCard}
      data-testid={`related-dep-${rel.name}`}
    >
      {isSelf ? (
        <span className={styles.cveId}>{rel.name}</span>
      ) : (
        <button
          type="button"
          className={styles.relatedDepLink}
          onClick={() => onNavigate({ kind: 'A', depName: rel.name })}
          data-testid={`related-dep-link-${rel.name}`}
          title={`Open ${rel.name}'s detail view`}
        >
          {rel.name}
        </button>
      )}
      {rel.installedVersion !== null && (
        <span className={styles.muted}>
          {' '}· installed <code>{rel.installedVersion}</code>
        </span>
      )}
      {/* Health badges */}
      <span className={styles.healthRow}>
        {health.deprecated === true && (
          <span className={`${styles.severity} ${styles.sevHigh ?? ''}`} title="Officially deprecated">
            ⊘ deprecated
          </span>
        )}
        {health.cveCount !== null && health.cveCount > 0 && health.maxCveSeverity && (
          <span
            className={`${styles.severity} ${severityClass(health.maxCveSeverity)}`}
            title={`${health.cveCount} known CVE${health.cveCount === 1 ? '' : 's'} at ${health.maxCveSeverity} severity`}
          >
            • {health.cveCount} CVE
          </span>
        )}
        {health.eol !== null && (
          <span
            className={`${styles.severity} ${health.eol.status === 'eol' ? styles.sevHigh ?? '' : styles.sevMid ?? ''}`}
            title={
              health.eol.eolDate !== null
                ? `${health.eol.cycle}.x — EOL ${health.eol.eolDate} (${health.eol.status})`
                : `${health.eol.cycle}.x — ${health.eol.status}`
            }
          >
            ⏰ {health.eol.status} ({health.eol.cycle}.x)
          </span>
        )}
        {health.ageDays !== null && health.ageDays > 730 && (
          <span className={`${styles.severity} ${styles.sevMid ?? ''}`} title={`Last publish ${health.ageDays} days ago`}>
            💤 {Math.round(health.ageDays / 365)}y stale
          </span>
        )}
      </span>
      {/* Reasons */}
      <ul role="list" className={styles.relatedReasons}>
        {reasons.map((reason, i) => (
          <li
            role="listitem"
            key={`${reason.kind}:${i}`}
            className={styles.cveSummary}
            data-testid={`related-dep-${rel.name}-reason-${reason.kind}`}
          >
            <span className={styles.muted}>[{REASON_LABEL[reason.kind]}]</span>{' '}
            {reasonPhrase(reason, viewedName, rel.name)}
            {reason.satisfied === false && (
              <span className={`${styles.severity} ${styles.sevHigh ?? ''}`} title="Constraint NOT satisfied by installed version">
                {' '}❗ unsatisfied
              </span>
            )}
          </li>
        ))}
      </ul>
    </li>
  );
}
