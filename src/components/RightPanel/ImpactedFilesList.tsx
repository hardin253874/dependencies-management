'use client';

/**
 * [D] impacted files (v2 Stage 5a.6): the graph's usage set for the package
 * with the agent's ranking, additions and evidence-backed exclusions on top.
 *
 *   1. "Agent-ranked": confirmed base files by rank, then agent-added files
 *      (badge `agent`) — the agent's own pick.
 *   2. "Also uses <pkg> (graph)": the rest of the base set, collapsed, first
 *      GRAPH_ROWS_PREVIEW rows + "show all" (superset has > 1,300 files).
 *   3. "Excluded by agent": base files the agent read and excluded, with the
 *      one-line evidence (kept visible, never deleted).
 *
 * Renders nothing for an empty list, so older envelopes (`impactedFiles`
 * missing → `?? []` at the call site) look exactly as before.
 */
import type { JSX } from 'react';
import { useState } from 'react';
import type { ImpactedFile } from '@/lib/api-types';
import { CollapsibleSection } from './CollapsibleSection';
import styles from './ImpactedFilesList.module.css';
import viewStyles from './UpdateReportView.module.css';

export const GRAPH_ROWS_PREVIEW = 50;

interface Props {
  files: readonly ImpactedFile[];
  /** Package name for the graph section title. */
  packageLabel: string;
}

function byRank(a: ImpactedFile, b: ImpactedFile): number {
  return (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER);
}

export function ImpactedFilesList({ files, packageLabel }: Props): JSX.Element | null {
  const [showAll, setShowAll] = useState(false);
  if (files.length === 0) return null;

  const confirmed = files.filter((f) => f.agent === 'confirmed').sort(byRank);
  const added = files.filter((f) => f.agent === 'added').sort(byRank);
  const ranked = [...confirmed, ...added];
  const graphOnly = files.filter((f) => f.agent === null);
  const excluded = files.filter((f) => f.agent === 'excluded');
  const visibleGraph = showAll ? graphOnly : graphOnly.slice(0, GRAPH_ROWS_PREVIEW);

  return (
    <section className={viewStyles.section} aria-label="Impacted files">
      <h3 className={viewStyles.sectionTitle}>
        Impacted files
        <span className={viewStyles.sectionCount}> ({files.length - excluded.length})</span>
      </h3>

      {ranked.length > 0 && (
        <section className={styles.subsection} aria-label="Agent-ranked">
          <h4 className={styles.subTitle}>
            Agent-ranked
            <span className={styles.count} data-testid="impacted-ranked-count">
              {' '}
              ({ranked.length})
            </span>
          </h4>
          <ul role="list" className={styles.list}>
            {ranked.map((f) => (
              <ImpactedRow key={f.path} file={f} />
            ))}
          </ul>
        </section>
      )}

      {graphOnly.length > 0 && (
        <CollapsibleSection
          title={`Also uses ${packageLabel} (graph)`}
          count={graphOnly.length}
          testId="impacted-graph-toggle"
          sectionClassName={styles.subsection}
          titleClassName={styles.subTitle}
          countClassName={styles.count}
        >
          <ul role="list" className={styles.list}>
            {visibleGraph.map((f) => (
              <ImpactedRow key={f.path} file={f} />
            ))}
          </ul>
          {!showAll && graphOnly.length > GRAPH_ROWS_PREVIEW && (
            <button type="button" className={styles.showAll} onClick={() => setShowAll(true)} data-testid="impacted-graph-show-all">
              Show all {graphOnly.length}
            </button>
          )}
        </CollapsibleSection>
      )}

      {excluded.length > 0 && (
        <section className={styles.subsection} aria-label="Excluded by agent">
          <h4 className={styles.subTitle}>
            Excluded by agent
            <span className={styles.count}> ({excluded.length})</span>
          </h4>
          <ul role="list" className={styles.list}>
            {excluded.map((f) => (
              <ImpactedRow key={f.path} file={f} />
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

function ImpactedRow({ file }: { file: ImpactedFile }): JSX.Element {
  const note = file.agent === 'excluded' ? file.evidence : file.brief;
  return (
    <li role="listitem" className={styles.row} data-testid={`impacted-${file.path}`}>
      {file.rank !== null && <span className={styles.rank}>{file.rank}.</span>}
      <code className={styles.path}>{file.path}</code>
      {file.origin === 'agent' && <span className={[styles.badge, styles.badgeAgent].join(' ')}>agent</span>}
      {file.via !== undefined && file.via !== 'direct' && <span className={styles.badge}>{file.via}</span>}
      {file.kind !== 'js' && <span className={styles.badge}>{file.kind}</span>}
      {file.confidence === 'low' && <span className={styles.badge}>low confidence</span>}
      {file.estimatedChangeSize !== null && (
        <span className={[viewStyles.sizePill, viewStyles[`size_${file.estimatedChangeSize}`]].join(' ')}>{file.estimatedChangeSize}</span>
      )}
      {note !== null && note !== '' && <span className={styles.brief}>{note}</span>}
    </li>
  );
}
