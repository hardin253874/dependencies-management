/**
 * UI persistence helpers — wraps localStorage with JSON + safe SSR fallbacks.
 *
 * In Stage 1 these are the immediate persistence layer; PATCH /api/config will
 * also persist these settings, but the UI reads them from localStorage on boot
 * for instant render (no flash of un-collapsed sidebar).
 */

const KEY_PREFIX = 'dep-agent:';

export function readLocal<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeLocal<T>(key: string, value: T): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEY_PREFIX + key, JSON.stringify(value));
  } catch {
    // localStorage quota exceeded or disabled — silently degrade
  }
}

export const PersistenceKeys = {
  sidebarCollapsed: 'ui.sidebarCollapsed',
  panelWidths: 'ui.panelWidths',
  showTestFiles: 'ui.showTestFiles',
  expandedGroups: 'ui.expandedGroups',
  detailRoute: 'ui.detailRoute'
} as const;
