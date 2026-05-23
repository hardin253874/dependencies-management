'use client';

import type { JobOrphan } from '@/lib/api-types';
import { useAppContext } from '../AppContext';
import styles from './OrphanBanner.module.css';

interface Props {
  orphan: JobOrphan;
}

/**
 * Left-panel banner shown when `GET /api/jobs.orphans` returns an entry whose
 * `slug` matches a registered project (spec §10.10).
 *
 * Two actions:
 *   - **Re-run** — POSTs the appropriate refresh endpoint inferred from the
 *     orphan's `resourceKey`, then discards the journal entry.
 *   - **Discard** — DELETE `/api/jobs/orphans/:slug/:jobId` only; the user
 *     gets back to a clean state without re-running.
 *
 * Per Stage 2 review M3 + UI_DESIGN.md §2.2 `OrphanRelocateBanner` styling.
 */
export function OrphanBanner({ orphan }: Props): JSX.Element {
  const { discardOrphan, rerunOrphan } = useAppContext();

  return (
    <div
      className={styles.banner}
      role="status"
      data-testid={`orphan-banner-${orphan.jobId}`}
    >
      <p className={styles.message}>Previous job interrupted</p>
      <p className={styles.subtitle}>{describeKind(orphan.resourceKey)}</p>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.action}
          onClick={() => void rerunOrphan(orphan)}
          data-testid={`orphan-rerun-${orphan.jobId}`}
        >
          Re-run
        </button>
        <button
          type="button"
          className={styles.action}
          onClick={() => void discardOrphan(orphan.slug, orphan.jobId)}
          data-testid={`orphan-discard-${orphan.jobId}`}
        >
          Discard
        </button>
      </div>
    </div>
  );
}

function describeKind(resourceKey: string): string {
  const parts = resourceKey.split(':');
  const kind = parts[0];
  const name = parts[2];
  switch (kind) {
    case 'deps':
      return `Dependency detail · ${name ?? ''}`;
    case 'versions':
      return `Version mapping · ${name ?? ''}`;
    case 'usage':
      return `Usage scan · ${name ?? ''}`;
    case 'reports':
      return `Update report · ${name ?? ''}`;
    case 'deep-reports':
      return `Deep update report · ${name ?? ''}`;
    case 'file-reviews':
      return `File review · ${name ?? ''}`;
    case 'refresh':
      return 'Project refresh';
    case 'scan':
      return 'Project scan';
    default:
      return kind ?? 'unknown job';
  }
}
