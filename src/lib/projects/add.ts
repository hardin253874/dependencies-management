/**
 * Project add pipeline (spec §10.1 Phase 1).
 *
 * Synchronous, target-read-only. Steps:
 *   1. Validate the path (delegates to validateProjectPath).
 *   2. Detect + parse lockfile.
 *   3. Read package.json.
 *   4. Compute slug (sha1 prefix + collision suffix).
 *   5. Write _projects.json (atomic).
 *   6. Create library/<slug>/ skeleton.
 *   7. Write project.json (atomic) with empty badges.
 *
 * Every write goes to library/. The target directory is never modified.
 */
import path from 'path';
import { promises as fs } from 'fs';
import { validateProjectPath, type ValidationResult } from './validate';
import { readPackageJson } from '../scanners/packageJson';
import { parseLockfile, detectLockfile } from '../scanners/lockfile';
import { resolveSlug } from '../storage/slug';
import { addProject, readProjects, type ProjectRegistryEntry, type PackageManager } from '../storage/projects';
import { atomicWriteJson } from '../storage/atomic';
import { projectDir, projectJsonPath, projectJobsDir } from '../paths';

export interface AddProjectInput {
  absolutePath: string;
  /**
   * When true, the workspaces warning is treated as acknowledged. Required when
   * the target has a `workspaces` field (UI surfaces the modal; user confirms).
   */
  acknowledgeWorkspaces?: boolean;
}

export interface ProjectJson {
  schemaVersion: 1;
  name: string;
  path: string;
  packageManager: PackageManager;
  lockfileHash: string;
  lockfileStateHash: string;
  lastFullScanAt: string;
  legacyPeerDeps: boolean;
  volta: { node: string | null; npm: string | null; yarn: string | null } | null;
  workspacesDetected: boolean;
  dependencies: ProjectDependency[];
}

export interface ProjectDependency {
  name: string;
  /**
   * Real `package.json` sections, plus `'volta'` for toolchain pins
   * (node / npm / yarn) which the FE renders alongside dependencies and
   * which the backend treats as first-class deps for refresh / GET endpoints
   * via `findProjectDep`. Phase 1/2 scan only writes `'dependencies'` and
   * `'devDependencies'`; `'volta'` entries are synthesized on-demand by
   * `findProjectDep`.
   */
  section: 'dependencies' | 'devDependencies' | 'volta';
  declaredRange: string;
  installedVersion: string | null;
  badges: {
    outdatedSeverity: 'major' | 'minor' | 'patch' | null;
    hasCve: boolean | null;
    deprecated: boolean | null;
    lastScannedAt: string | null;
  };
}

export interface AddProjectOk {
  ok: true;
  slug: string;
  entry: ProjectRegistryEntry;
  projectJson: ProjectJson;
}

export type AddProjectResult = AddProjectOk | { ok: false; error: { code: string; message: string } };

export async function addProjectPipeline(input: AddProjectInput): Promise<AddProjectResult> {
  const validation: ValidationResult = await validateProjectPath(input.absolutePath);
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }

  if (validation.workspacesDetected && input.acknowledgeWorkspaces !== true) {
    return {
      ok: false,
      error: {
        code: 'WORKSPACES_NOT_ACKNOWLEDGED',
        message:
          'Workspaces detected. v1 will analyze only the root package.json. Re-submit with acknowledgeWorkspaces:true to proceed.'
      }
    };
  }

  const pkg = await readPackageJson(validation.absolutePath);
  const detected = await detectLockfile(validation.absolutePath);
  if (detected === null) {
    return { ok: false, error: { code: 'NO_LOCKFILE', message: 'Lockfile disappeared during add.' } };
  }
  const lockfile = await parseLockfile(detected);

  const registry = await readProjects();
  const slug = resolveSlug(validation.absolutePath, registry.projects.map((p) => p.slug));

  const entry: ProjectRegistryEntry = {
    slug,
    name: pkg.name ?? path.basename(validation.absolutePath),
    absolutePath: validation.absolutePath,
    packageManager: validation.packageManager,
    addedAt: new Date().toISOString(),
    workspacesDetected: validation.workspacesDetected
  };

  // Create library/<slug>/ and library/<slug>/_jobs/ skeleton up-front.
  await fs.mkdir(projectDir(slug), { recursive: true });
  await fs.mkdir(projectJobsDir(slug), { recursive: true });

  // Build the project.json data.
  const deps: ProjectDependency[] = [];
  for (const [name, range] of Object.entries(pkg.dependencies)) {
    deps.push(buildDep(name, range, 'dependencies', lockfile.installedVersions[name] ?? null));
  }
  for (const [name, range] of Object.entries(pkg.devDependencies)) {
    deps.push(buildDep(name, range, 'devDependencies', lockfile.installedVersions[name] ?? null));
  }
  deps.sort((a, b) => (a.section === b.section ? a.name.localeCompare(b.name) : a.section.localeCompare(b.section)));

  const projectJson: ProjectJson = {
    schemaVersion: 1,
    name: entry.name,
    path: entry.absolutePath,
    packageManager: validation.packageManager,
    lockfileHash: lockfile.lockfileHash,
    lockfileStateHash: lockfile.lockfileStateHash,
    lastFullScanAt: new Date().toISOString(),
    legacyPeerDeps: false,
    volta: pkg.volta,
    workspacesDetected: validation.workspacesDetected,
    dependencies: deps
  };

  // Write the registry FIRST. If we crash between the two writes, we end up
  // with a project that's registered but has no scan data; the UI can
  // recover via the refresh endpoint. If we did it in the reverse order, a
  // crash would leave a `library/<slug>/` orphan dir that's invisible to the
  // user but blocks the slug for collision purposes — much worse.
  await addProject(entry);
  await atomicWriteJson(projectJsonPath(slug), projectJson);

  return { ok: true, slug, entry, projectJson };
}

function buildDep(
  name: string,
  declaredRange: string,
  section: 'dependencies' | 'devDependencies',
  installed: string | null
): ProjectDependency {
  return {
    name,
    section,
    declaredRange,
    installedVersion: installed,
    badges: {
      outdatedSeverity: null,
      hasCve: null,
      deprecated: null,
      lastScannedAt: null
    }
  };
}
