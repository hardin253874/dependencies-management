/**
 * Right-panel routing — tagged union covering Stage 2 + Stage 3 + Stage 4 views.
 *
 * Stages 2 + 3 ship views [A], [B], [C], [D], [E]; Stage 4 adds `'D-deep'`. The
 * shape is kept narrow so adding a new view forces compilation to surface all
 * switches that need updating.
 *
 * Spec authority: §7.4 (breadcrumb composition), §7.6 (view triggers).
 */

export type DetailRoute =
  | { kind: 'A'; depName: string }
  | { kind: 'B'; depName: string; version: string }
  | { kind: 'C'; depName: string }
  | { kind: 'D'; depName: string; fromVersion: string; toVersion: string }
  | { kind: 'D-deep'; depName: string; fromVersion: string; toVersion: string }
  | { kind: 'E'; depName: string; pathHash: string; filePath: string };

/** Breadcrumb segment as understood by `Breadcrumb` component. */
export interface BreadcrumbSegment {
  /** Visible label for the segment. */
  label: string;
  /**
   * Route this segment navigates to when clicked; `null` for the current
   * (last) segment per spec §7.4.
   */
  route: DetailRoute | null;
}

/**
 * Truncate a long file path in the middle so the head + tail remain visible.
 * Spec §7.4: "[E]: <dep> › Usage › <relative-file-path> (path truncated middle
 * if long)". Threshold = 64 characters; truncated form uses an ellipsis.
 */
export function truncatePathMiddle(path: string, max = 64): string {
  if (path.length <= max) return path;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${path.slice(0, head)}…${path.slice(path.length - tail)}`;
}

/** Build breadcrumb segments per spec §7.4 for views [A], [B], [C], [D], [E]. */
export function buildBreadcrumb(route: DetailRoute): BreadcrumbSegment[] {
  switch (route.kind) {
    case 'A':
      return [{ label: route.depName, route: null }];
    case 'B':
      return [
        { label: route.depName, route: { kind: 'A', depName: route.depName } },
        { label: `v${route.version}`, route: null }
      ];
    case 'C':
      return [
        { label: route.depName, route: { kind: 'A', depName: route.depName } },
        { label: 'Usage', route: null }
      ];
    case 'D':
      return [
        { label: route.depName, route: { kind: 'A', depName: route.depName } },
        {
          label: `v${route.fromVersion} → v${route.toVersion}`,
          route: { kind: 'B', depName: route.depName, version: route.toVersion }
        },
        { label: 'Update Report', route: null }
      ];
    case 'D-deep':
      return [
        { label: route.depName, route: { kind: 'A', depName: route.depName } },
        {
          label: `v${route.fromVersion} → v${route.toVersion}`,
          route: { kind: 'B', depName: route.depName, version: route.toVersion }
        },
        {
          label: 'Update Report',
          route: {
            kind: 'D',
            depName: route.depName,
            fromVersion: route.fromVersion,
            toVersion: route.toVersion
          }
        },
        { label: 'Deep Report', route: null }
      ];
    case 'E':
      return [
        { label: route.depName, route: { kind: 'A', depName: route.depName } },
        { label: 'Usage', route: { kind: 'C', depName: route.depName } },
        { label: truncatePathMiddle(route.filePath), route: null }
      ];
  }
}

/** True if two routes target the same view + parameters. */
export function routesEqual(a: DetailRoute, b: DetailRoute): boolean {
  if (a.kind !== b.kind) return false;
  if (a.depName !== b.depName) return false;
  if (a.kind === 'B' && b.kind === 'B') return a.version === b.version;
  if (a.kind === 'D' && b.kind === 'D') {
    return a.fromVersion === b.fromVersion && a.toVersion === b.toVersion;
  }
  if (a.kind === 'D-deep' && b.kind === 'D-deep') {
    return a.fromVersion === b.fromVersion && a.toVersion === b.toVersion;
  }
  if (a.kind === 'E' && b.kind === 'E') return a.pathHash === b.pathHash;
  return true;
}
