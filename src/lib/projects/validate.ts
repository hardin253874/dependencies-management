/**
 * Path validation for the Add Project flow (spec §6.2).
 *
 * Validation rules in order:
 *   1. Path must be absolute (§6.2.1).
 *   2. Path must exist and be a directory (§6.2.1).
 *   3. `package.json` must exist at that path (§6.2.2).
 *   4. Lockfile must exist (§6.2.3) — npm wins when both present.
 *   5. Path must not equal or be inside the agent's own directory (§6.2.5).
 *   6. Path must not already be registered (§6.2.5).
 *
 * Workspaces detection and nested-project warnings are returned as soft signals
 * (the caller decides how to surface them).
 */
import { promises as fs } from 'fs';
import path from 'path';
import { detectLockfile } from '../scanners/lockfile';
import { readProjects } from '../storage/projects';
import { agentRepoRoot } from '../paths';
import { readPackageJson } from '../scanners/packageJson';

export type ValidationCode =
  | 'NOT_ABSOLUTE'
  | 'PATH_TRAVERSAL'
  | 'NOT_FOUND'
  | 'NOT_DIRECTORY'
  | 'NO_PACKAGE_JSON'
  | 'INVALID_PACKAGE_JSON'
  | 'NO_LOCKFILE'
  | 'INSIDE_AGENT'
  | 'DUPLICATE';

export interface ValidationError {
  code: ValidationCode;
  message: string;
}

export interface ValidationOk {
  ok: true;
  absolutePath: string;
  packageManager: 'npm' | 'yarn-classic' | 'yarn-berry';
  lockfilePath: string;
  packageJsonName: string | null;
  workspacesDetected: boolean;
  /**
   * Soft warning when this path is nested inside another registered project.
   * Caller may surface a "nested" badge but should still allow the add.
   */
  nestedUnderSlug: string | null;
}

export type ValidationResult = ValidationOk | { ok: false; error: ValidationError };

const TRAVERSAL_RE = /(^|[\\/])\.\.([\\/]|$)/;

/**
 * Per-segment `..` check that runs BEFORE any normalize/resolve/stat call.
 *
 * Why split-then-scan as well as the regex: path.join/path.normalize/path.resolve
 * collapse `..` segments aggressively (e.g. `path.join('/a/b', '..', 'c')`
 * returns `'/a/c'`). If we check only after that step, the `..` is already
 * gone and we miss the traversal intent. Splitting the raw input by both
 * separators and scanning for an exact `..` token catches every traversal
 * variant regardless of OS or the caller's join history.
 */
function containsTraversalSegment(rawInput: string): boolean {
  if (TRAVERSAL_RE.test(rawInput)) return true;
  for (const segment of rawInput.split(/[/\\]/)) {
    if (segment === '..') return true;
  }
  return false;
}

/**
 * Validate a candidate target project path. Returns an OK result describing
 * the detected layout, or an error describing why it cannot be registered.
 *
 * This function does not mutate any state.
 */
export async function validateProjectPath(input: string): Promise<ValidationResult> {
  if (typeof input !== 'string' || input.trim() === '') {
    return fail('NOT_ABSOLUTE', 'Path must be a non-empty string.');
  }

  const trimmed = input.trim();

  // CRITICAL: traversal detection MUST run before any normalize/resolve/stat
  // call. path.normalize collapses `..` segments, so a post-normalize check
  // would miss the traversal intent entirely. See containsTraversalSegment().
  if (containsTraversalSegment(trimmed)) {
    return fail('PATH_TRAVERSAL', 'Path contains parent-directory segments (..).');
  }

  if (!path.isAbsolute(trimmed)) {
    return fail('NOT_ABSOLUTE', 'Path must be absolute.');
  }

  // Normalize, then re-check absoluteness + traversal defensively.
  const normalized = path.normalize(trimmed);
  if (!path.isAbsolute(normalized)) {
    return fail('PATH_TRAVERSAL', 'Path is not absolute after normalization.');
  }
  if (containsTraversalSegment(normalized)) {
    return fail('PATH_TRAVERSAL', 'Path contains parent-directory segments after normalization.');
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(normalized);
  } catch {
    return fail('NOT_FOUND', `Path does not exist: ${normalized}`);
  }
  if (!stat.isDirectory()) {
    return fail('NOT_DIRECTORY', `Path is not a directory: ${normalized}`);
  }

  // Security check before any deeper inspection: reject the agent's own folder
  // and any descendant. We do this before reading package.json so users get a
  // clear error even on a freshly-checked-out agent (no lockfile yet).
  const agentRoot = agentRepoRoot();
  if (isSameOrInside(normalized, agentRoot)) {
    return fail('INSIDE_AGENT', `Path is the agent's own folder or a descendant: ${normalized}`);
  }

  const pkgPath = path.join(normalized, 'package.json');
  try {
    const pkgStat = await fs.stat(pkgPath);
    if (!pkgStat.isFile()) {
      return fail('NO_PACKAGE_JSON', `Not a file: ${pkgPath}`);
    }
  } catch {
    return fail('NO_PACKAGE_JSON', `No package.json at ${normalized}`);
  }

  let pkg;
  try {
    pkg = await readPackageJson(normalized);
  } catch (err) {
    return fail('INVALID_PACKAGE_JSON', `Could not parse package.json: ${(err as Error).message}`);
  }

  const detected = await detectLockfile(normalized);
  if (detected === null) {
    return fail('NO_LOCKFILE', 'No supported lockfile found (package-lock.json or yarn.lock).');
  }

  const registry = await readProjects();
  if (registry.projects.some((p) => p.absolutePath === normalized)) {
    return fail('DUPLICATE', `Project already registered: ${normalized}`);
  }

  // Nested-under-existing detection (§6.2.6) — soft warning only.
  const nested = registry.projects.find(
    (p) => isStrictlyInside(normalized, p.absolutePath) || isStrictlyInside(p.absolutePath, normalized)
  );

  return {
    ok: true,
    absolutePath: normalized,
    packageManager: detected.packageManager,
    lockfilePath: detected.lockfilePath,
    packageJsonName: pkg.name,
    workspacesDetected: pkg.workspacesDetected,
    nestedUnderSlug: nested?.slug ?? null
  };
}

function fail(code: ValidationCode, message: string): ValidationResult {
  return { ok: false, error: { code, message } };
}

function isSameOrInside(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isStrictlyInside(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel === '' || rel === '.') return false;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}
