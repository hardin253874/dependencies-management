/**
 * Client-side helper for "what's the installed version of `<dep>` in this
 * project?" — the same question backend code answers via `findProjectDep`.
 *
 * Why this isn't just `project.dependencies.find(d => d.name === dep)`:
 *   Volta toolchain entries (`node`, `npm`, `yarn`) live on
 *   `project.volta`, NOT in `project.dependencies`. They're synthesized
 *   into the middle-panel dep tree client-side (`synthesizeVoltaEntries`
 *   in MiddlePanel.tsx) but every other lookup that needs an installed
 *   version must also check the toolchain bag — otherwise clicking a
 *   Volta entry's version in view [A] / [B] leads to a "version unknown"
 *   degraded state.
 *
 * Mirrors the backend `findProjectDep(project, name)` helper at
 * `src/lib/projects/lookup.ts`. The two are deliberately separate
 * (backend reads ProjectJson; this reads ProjectDetail from the API
 * response) but agree on the toolchain-name set.
 */
import type { ProjectDetail } from '../api-types';

const VOLTA_TOOLCHAIN_NAMES = new Set(['node', 'npm', 'yarn']);

/**
 * Look up the installed version of `depName` in `project`. Returns null
 * when the dep doesn't exist (and isn't a Volta toolchain entry), or when
 * it exists but has no installed version recorded (rare; Phase 1 sync
 * couldn't resolve it from the lockfile).
 */
export function findInstalledVersion(
  project: ProjectDetail | null | undefined,
  depName: string
): string | null {
  if (project === null || project === undefined) return null;
  const directHit = project.dependencies.find((d) => d.name === depName);
  if (directHit !== undefined) return directHit.installedVersion ?? null;
  // Fall through to Volta toolchain.
  if (VOLTA_TOOLCHAIN_NAMES.has(depName) && project.volta !== null) {
    if (depName === 'node') return project.volta.node ?? null;
    if (depName === 'npm') return project.volta.npm ?? null;
    if (depName === 'yarn') return project.volta.yarn ?? null;
  }
  return null;
}
