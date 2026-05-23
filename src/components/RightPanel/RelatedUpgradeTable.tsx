'use client';

/**
 * Shared rendering for the related-deps upgrade analysis table.
 *
 * Used by view [B] (VersionMappingView) and view [D] (UpdateReportView).
 * Both render the same RelatedUpgradeDetail shape; extracting the table
 * here keeps the two views visually consistent and reduces duplication.
 *
 * The component is presentational — it doesn't fetch, it doesn't refresh.
 * Parents wire data + provide the regenerate button if they want one.
 *
 * CSS — to avoid coupling this component to either parent's CSS module, we
 * accept a `classNames` prop where the parent passes its already-scoped
 * class names. That way the same component renders with either view [B]'s
 * or view [D]'s typography / spacing.
 */
import type {
  RelatedDepUpgradeRecommendation,
  RelatedUpgradeDetail
} from '@/lib/api-types';

export interface RelatedUpgradeTableClassNames {
  /** Container for fallback banner, notes, table, footer. */
  wrapper?: string;
  /** Fallback / empty-state hint paragraph. */
  emptyHint: string;
  /** LLM globalNotes paragraph above the table. */
  globalNotes: string;
  /** The <table> element. */
  table: string;
  /** Action pill (small chip). */
  actionPill: string;
  /** Pill variant: keep. */
  actionKeep: string;
  /** Pill variant: upgrade. */
  actionUpgrade: string;
  /** Pill variant: investigate. */
  actionInvestigate: string;
  /** Inline secondary text (confidence chip, footer). */
  confidence: string;
}

interface Props {
  detail: RelatedUpgradeDetail;
  generatedAt: string;
  source: string;
  classNames: RelatedUpgradeTableClassNames;
}

export function RelatedUpgradeTable({
  detail,
  generatedAt,
  source,
  classNames
}: Props): JSX.Element {
  const isDeterministicOnly = source === 'deterministic-partial';
  return (
    <div className={classNames.wrapper}>
      {isDeterministicOnly && (
        <p className={classNames.emptyHint} data-testid="related-upgrade-fallback">
          ⚠ LLM analysis unavailable — showing deterministic compatibility verdict only.
          Click Re-analyze to retry.
        </p>
      )}
      {detail.globalNotes !== '' && (
        <p className={classNames.globalNotes} data-testid="related-upgrade-global-notes">
          {detail.globalNotes}
        </p>
      )}
      <table className={classNames.table} data-testid="related-upgrade-table">
        <thead>
          <tr>
            <th scope="col">Dep</th>
            <th scope="col">Installed</th>
            <th scope="col">Action</th>
            <th scope="col">Target</th>
            <th scope="col">Severity</th>
            <th scope="col">Notes</th>
          </tr>
        </thead>
        <tbody>
          {detail.recommendations.map((rec) => (
            <RelatedUpgradeRow key={rec.name} rec={rec} classNames={classNames} />
          ))}
        </tbody>
      </table>
      <p className={classNames.emptyHint}>
        Generated {generatedAt.slice(0, 19).replace('T', ' ')} UTC · source: {source}
      </p>
    </div>
  );
}

function RelatedUpgradeRow({
  rec,
  classNames
}: {
  rec: RelatedDepUpgradeRecommendation;
  classNames: RelatedUpgradeTableClassNames;
}): JSX.Element {
  const actionClass =
    rec.action === 'keep'
      ? classNames.actionKeep
      : rec.action === 'upgrade'
        ? classNames.actionUpgrade
        : classNames.actionInvestigate;
  return (
    <tr data-testid={`related-upgrade-row-${rec.name}`}>
      <td>
        <code>{rec.name}</code>
      </td>
      <td>
        <code>{rec.installedVersion ?? '—'}</code>
      </td>
      <td>
        <span className={`${classNames.actionPill} ${actionClass}`}>{rec.action}</span>
        <span className={classNames.confidence}>({rec.confidence})</span>
      </td>
      <td>{rec.suggestedVersion === null ? '—' : <code>{rec.suggestedVersion}</code>}</td>
      <td>{rec.severity === 'none' ? '—' : rec.severity}</td>
      <td>
        {rec.migrationNotes === '' ? (
          <span className={classNames.confidence}>—</span>
        ) : (
          rec.migrationNotes
        )}
      </td>
    </tr>
  );
}
