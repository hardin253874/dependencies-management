'use client';

import { formatRelativeTime } from '@/lib/client/format';
import styles from './CacheFreshnessLine.module.css';

export type FreshnessStatus = 'fresh' | 'stale';

interface Props {
  status: FreshnessStatus;
  generatedAtIso: string;
  onRegenerate: () => void;
}

/**
 * Spec §7.4: "Cache freshness line" under the breadcrumb when data is cached.
 *   - Fresh (within TTL): gray "Cached • generated 3d ago"
 *   - Stale (past TTL): amber "Stale • generated 9d ago — Regenerate"
 */
export function CacheFreshnessLine({
  status,
  generatedAtIso,
  onRegenerate
}: Props): JSX.Element {
  const relative = formatRelativeTime(generatedAtIso);
  if (status === 'fresh') {
    return (
      <p className={styles.fresh} data-testid="cache-freshness">
        Cached • generated {relative}
      </p>
    );
  }
  return (
    <p className={styles.stale} role="status" data-testid="cache-freshness">
      <span aria-hidden="true" className={styles.amberDot}>
        ▮
      </span>
      Stale • generated {relative}
      {' — '}
      <button
        type="button"
        className={styles.regenerateLink}
        onClick={onRegenerate}
        data-testid="cache-freshness-regenerate"
      >
        Regenerate
      </button>
    </p>
  );
}

/**
 * True if the envelope's generatedAt is older than its declared ttlHours.
 * Null ttl means "never auto-expire" (always fresh).
 */
export function isStale(generatedAtIso: string, ttlHours: number | null, now: Date = new Date()): boolean {
  if (ttlHours === null) return false;
  const ageMs = now.getTime() - new Date(generatedAtIso).getTime();
  return ageMs > ttlHours * 60 * 60 * 1000;
}
