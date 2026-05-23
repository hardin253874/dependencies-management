'use client';

import type { DependencyEntry } from '@/lib/api-types';
import { formatCompactAge } from '@/lib/client/format';
import { BadgeCluster, deriveBadgeState } from './BadgeCluster';
import styles from './DependencyRow.module.css';

interface Props {
  dep: DependencyEntry;
  active: boolean;
  onClick: () => void;
}

const NO_INSTALL_PLACEHOLDER = '—';
const STALE_AGE_MS = 24 * 60 * 60 * 1000;

function describeInstalled(dep: DependencyEntry): string {
  return dep.installedVersion ?? 'not resolved';
}

function describeBadges(dep: DependencyEntry): string {
  const b = dep.badges;
  const unscanned =
    b.outdatedSeverity === null && b.hasCve === null && b.deprecated === null;
  if (unscanned) return 'not yet scanned';
  const parts: string[] = [];
  if (b.outdatedSeverity === 'major') parts.push('major version behind');
  else if (b.outdatedSeverity === 'minor' || b.outdatedSeverity === 'patch')
    parts.push(`${b.outdatedSeverity} version behind`);
  if (b.hasCve === true) parts.push('has known CVE');
  if (b.deprecated === true) parts.push('deprecated');
  if (parts.length === 0) parts.push('current and clean');
  return parts.join(', ');
}

export function DependencyRow({ dep, active, onClick }: Props): JSX.Element {
  const badgeState = deriveBadgeState(dep.badges);
  // Subtle "3d ago" timestamp only when last-scan is older than 24h per §7.3.
  let staleHint: string | null = null;
  if (dep.badges.lastScannedAt) {
    const age = Date.now() - new Date(dep.badges.lastScannedAt).getTime();
    if (age > STALE_AGE_MS) staleHint = formatCompactAge(dep.badges.lastScannedAt);
  }

  return (
    <button
      type="button"
      role="button"
      aria-pressed={active}
      aria-label={`${dep.name}, declared ${dep.declaredRange}, installed ${describeInstalled(dep)}, ${describeBadges(dep)}`}
      className={[styles.row, active ? styles.active : ''].filter(Boolean).join(' ')}
      onClick={onClick}
      data-testid={`dep-row-${dep.name}`}
    >
      <span className={styles.name}>{dep.name}</span>
      <span className={styles.badgeSlot}>
        <BadgeCluster badges={badgeState} />
      </span>
      <span className={styles.versions}>
        <span className={styles.declared}>{dep.declaredRange}</span>
        <span className={styles.arrow} aria-hidden="true">
          →
        </span>
        <span className={styles.installed}>
          {dep.installedVersion ?? NO_INSTALL_PLACEHOLDER}
        </span>
        {staleHint && (
          <span className={styles.staleHint} aria-hidden="true">
            {staleHint} ago
          </span>
        )}
      </span>
    </button>
  );
}
