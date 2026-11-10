/**
 * Per-view `output_config.effort` (v2 Stage 1.4, decision D12 — Proposed).
 *
 * Every service sets effort explicitly: Claude Opus 5.5 defaults to `medium`
 * while other current models default to `high`, so leaving it implicit would
 * change behaviour whenever the user switches model. One table so the Stage 4
 * eval can tune it.
 *
 * Effort is a request parameter, deliberately NOT part of `computeCacheKey`
 * (open question Q7): changing it must not invalidate users' on-disk caches.
 */
export type LlmEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const VIEW_EFFORT = {
  fileReview: 'medium',
  updateReport: 'medium',
  relatedUpgrade: 'medium',
  cveImpact: 'medium',
  deepReport: 'high'
} as const satisfies Record<string, LlmEffort>;
