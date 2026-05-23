'use client';

import type { OutdatedSeverity } from '@/lib/api-types';
import styles from './BadgeCluster.module.css';

/**
 * Spec §7.5 badge cluster. Per UI_DESIGN.md §2.3 render order is:
 *
 *   ↑ red  (major) | ↑ amber (minor/patch) | • red (CVE) | ⊘ gray (deprecated)
 *   ✓ green (clean and current) — only when none of the above and not unscanned
 *   ? gray  — collapses the whole cluster when not yet scanned
 *
 * Per DESIGN_TOKENS.md §3.3 (Designer Option 1, the wireframe choice): glyphs
 * are rendered inside small tinted pills so the contrast meets WCAG AA against
 * the pill background rather than the bright Apple status hex on near-white.
 */

export interface BadgeState {
  outdatedSeverity: OutdatedSeverity;
  hasCve: boolean | null;
  deprecated: boolean | null;
  /** True while Phase-2 hasn't scanned this dep yet (i.e., all fields null). */
  unscanned?: boolean;
  /** OSV.dev down — render `?` in the CVE slot. */
  cveDataUnavailable?: boolean;
}

interface Props {
  badges: BadgeState;
}

/**
 * Convenience adapter — derives the BadgeState from a DependencyEntry.badges
 * value as it lives in project.json.
 */
export function deriveBadgeState(
  badges: { outdatedSeverity: OutdatedSeverity; hasCve: boolean | null; deprecated: boolean | null }
): BadgeState {
  const unscanned =
    badges.outdatedSeverity === null && badges.hasCve === null && badges.deprecated === null;
  return {
    outdatedSeverity: badges.outdatedSeverity,
    hasCve: badges.hasCve,
    deprecated: badges.deprecated,
    unscanned,
    cveDataUnavailable: false
  };
}

export function BadgeCluster({ badges }: Props): JSX.Element {
  // Unscanned collapses everything to a single `?` per UI_DESIGN.md.
  if (badges.unscanned) {
    return (
      <span
        className={styles.cluster}
        role="img"
        aria-label="Not yet scanned"
        data-testid="badge-cluster"
      >
        <span className={`${styles.pill} ${styles.gray}`} aria-hidden="true" data-glyph="unscanned">
          ?
        </span>
      </span>
    );
  }

  const labels: string[] = [];
  const items: JSX.Element[] = [];

  if (badges.outdatedSeverity === 'major') {
    labels.push('major version behind');
    items.push(
      <span
        key="out-major"
        className={`${styles.pill} ${styles.red}`}
        aria-hidden="true"
        data-glyph="outdated-major"
      >
        ↑
      </span>
    );
  } else if (badges.outdatedSeverity === 'minor' || badges.outdatedSeverity === 'patch') {
    labels.push(`${badges.outdatedSeverity} version behind`);
    items.push(
      <span
        key="out-amber"
        className={`${styles.pill} ${styles.amber}`}
        aria-hidden="true"
        data-glyph="outdated-minor"
      >
        ↑
      </span>
    );
  }

  if (badges.cveDataUnavailable) {
    labels.push('CVE data unavailable');
    items.push(
      <span
        key="cve-unknown"
        className={`${styles.pill} ${styles.gray}`}
        aria-hidden="true"
        data-glyph="cve-unknown"
      >
        ?
      </span>
    );
  } else if (badges.hasCve === true) {
    labels.push('has known CVE');
    items.push(
      <span
        key="cve"
        className={`${styles.pill} ${styles.red}`}
        aria-hidden="true"
        data-glyph="cve"
      >
        •
      </span>
    );
  }

  if (badges.deprecated === true) {
    labels.push('deprecated');
    items.push(
      <span
        key="deprecated"
        className={`${styles.pill} ${styles.gray}`}
        aria-hidden="true"
        data-glyph="deprecated"
      >
        ⊘
      </span>
    );
  }

  if (items.length === 0) {
    // Nothing flagged and the dep has been scanned → render the clean check.
    return (
      <span
        className={styles.cluster}
        role="img"
        aria-label="current and clean"
        data-testid="badge-cluster"
      >
        <span
          className={`${styles.pill} ${styles.green}`}
          aria-hidden="true"
          data-glyph="clean"
        >
          ✓
        </span>
      </span>
    );
  }

  return (
    <span
      className={styles.cluster}
      role="img"
      aria-label={labels.join(', ')}
      data-testid="badge-cluster"
    >
      {items}
    </span>
  );
}
