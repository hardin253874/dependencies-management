/**
 * `findProjectDep` — single lookup that returns either:
 *  - a real `package.json` dep from `project.dependencies`, or
 *  - a synthesized "Volta dep" when the name matches a toolchain pin in
 *    `project.volta` (node / npm / yarn).
 *
 * Why this exists: the FE renders Volta toolchain pins as first-class rows in
 * the middle panel (a third group alongside `dependencies` / `devDependencies`).
 * When the user clicks one and triggers a refresh, the BE route must accept
 * the name as a valid dep — otherwise it 404s with `DEP_NOT_FOUND` and the UI
 * silently re-renders the empty-state CTA.
 *
 * Phase 1/2 scan does NOT populate Volta entries into `project.dependencies`
 * (it iterates only `package.json`'s `dependencies` + `devDependencies`).
 * Synthesizing on-demand here keeps the project.json shape unchanged while
 * making refresh / GET endpoints work uniformly for Volta names.
 */
import type { ProjectDependency, ProjectJson } from './add';

const VOLTA_TOOLCHAIN_NAMES = new Set(['node', 'npm', 'yarn']);

/**
 * Returns the matching `ProjectDependency` or `null` if the name is neither a
 * real dep nor a Volta toolchain pin in this project.
 */
export function findProjectDep(project: ProjectJson, name: string): ProjectDependency | null {
  const real = project.dependencies.find((d) => d.name === name);
  if (real !== undefined) return real;

  if (project.volta !== null && VOLTA_TOOLCHAIN_NAMES.has(name)) {
    // `volta` is shaped { node, npm, yarn }; index by the requested name.
    const voltaVersion = (project.volta as Record<string, string | null>)[name];
    if (typeof voltaVersion === 'string' && voltaVersion !== '') {
      return {
        name,
        section: 'volta',
        declaredRange: voltaVersion,
        installedVersion: voltaVersion,
        badges: {
          outdatedSeverity: null,
          hasCve: null,
          deprecated: null,
          lastScannedAt: null
        }
      };
    }
  }
  return null;
}
