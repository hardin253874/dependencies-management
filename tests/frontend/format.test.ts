import { describe, expect, it } from 'vitest';
import { formatCompactAge, formatRelativeTime } from '@/lib/client/format';

describe('formatCompactAge', () => {
  const now = new Date('2026-05-23T10:00:00Z');

  it('shows seconds as "now"', () => {
    const iso = new Date(now.getTime() - 10_000).toISOString();
    expect(formatCompactAge(iso, now)).toBe('now');
  });

  it('shows minutes', () => {
    const iso = new Date(now.getTime() - 5 * 60_000).toISOString();
    expect(formatCompactAge(iso, now)).toBe('5m');
  });

  it('shows hours', () => {
    const iso = new Date(now.getTime() - 3 * 60 * 60_000).toISOString();
    expect(formatCompactAge(iso, now)).toBe('3h');
  });

  it('shows days', () => {
    const iso = new Date(now.getTime() - 3 * 24 * 60 * 60_000).toISOString();
    expect(formatCompactAge(iso, now)).toBe('3d');
  });

  it('returns empty for null', () => {
    expect(formatCompactAge(null, now)).toBe('');
  });
});

describe('formatRelativeTime', () => {
  const now = new Date('2026-05-23T10:00:00Z');
  it('returns "just now" within 30s', () => {
    const iso = new Date(now.getTime() - 5_000).toISOString();
    expect(formatRelativeTime(iso, now)).toBe('just now');
  });
  it('returns a day-scale relative time', () => {
    const iso = new Date(now.getTime() - 3 * 24 * 60 * 60_000).toISOString();
    expect(formatRelativeTime(iso, now)).toMatch(/3 days ago/);
  });
});
