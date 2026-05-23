/**
 * Date / time / size formatting helpers. English-only per spec §12.
 */

const RTF = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

const TIME_UNITS: Array<{ unit: Intl.RelativeTimeFormatUnit; ms: number }> = [
  { unit: 'year', ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: 'month', ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: 'week', ms: 7 * 24 * 60 * 60 * 1000 },
  { unit: 'day', ms: 24 * 60 * 60 * 1000 },
  { unit: 'hour', ms: 60 * 60 * 1000 },
  { unit: 'minute', ms: 60 * 1000 },
  { unit: 'second', ms: 1000 }
];

/** "3d ago", "5 minutes ago", "just now" — Intl-driven (spec §12). */
export function formatRelativeTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  const diffMs = then - now.getTime();
  const absMs = Math.abs(diffMs);
  if (absMs < 30_000) return 'just now';
  for (const { unit, ms } of TIME_UNITS) {
    if (absMs >= ms) {
      const value = Math.round(diffMs / ms);
      return RTF.format(value, unit);
    }
  }
  return RTF.format(0, 'second');
}

/** "3d", "5 mo" — compact for dep-row "3d ago" subtitle. */
export function formatCompactAge(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '';
  const diff = now.getTime() - new Date(iso).getTime();
  if (diff < 60_000) return 'now';
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))}h`;
  if (diff < 30 * 24 * 60 * 60_000) return `${Math.floor(diff / (24 * 60 * 60_000))}d`;
  if (diff < 365 * 24 * 60 * 60_000) return `${Math.floor(diff / (30 * 24 * 60 * 60_000))}mo`;
  return `${Math.floor(diff / (365 * 24 * 60 * 60_000))}y`;
}
