/**
 * Filesystem picker helpers (spec §6.1 / §9.4).
 *
 * - Lists immediate children of an absolute path.
 * - Rejects `..` segments before any filesystem access.
 * - Rejects symlinks that point outside the queried base directory.
 *
 * This is paranoid by design: the FE folder-picker is the most directly
 * user-controlled filesystem-touching surface, so traversal is the #1 worry.
 */
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

export interface DirChild {
  name: string;
  absolutePath: string;
  isDirectory: boolean;
  /** True if this entry is a symlink. We still report it but skip listing into it. */
  isSymlink: boolean;
  hasPackageJson: boolean;
  hasLockfile: boolean;
}

export interface ListDirResult {
  basePath: string;
  /** Parent path, or null when at a drive/root. */
  parentPath: string | null;
  children: DirChild[];
}

export type ListError =
  | { code: 'NOT_ABSOLUTE'; message: string }
  | { code: 'PATH_TRAVERSAL'; message: string }
  | { code: 'NOT_FOUND'; message: string }
  | { code: 'NOT_DIRECTORY'; message: string }
  | { code: 'PERMISSION_DENIED'; message: string };

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

export async function listDirectory(input: string): Promise<{ ok: true; result: ListDirResult } | { ok: false; error: ListError }> {
  if (typeof input !== 'string' || input.trim() === '') {
    return { ok: false, error: { code: 'NOT_ABSOLUTE', message: 'Path must be a non-empty string.' } };
  }
  const trimmed = input.trim();
  // CRITICAL: traversal detection MUST run before any normalize/resolve/stat
  // call. See containsTraversalSegment() for the why.
  if (containsTraversalSegment(trimmed)) {
    return { ok: false, error: { code: 'PATH_TRAVERSAL', message: 'Path contains parent-directory segments (..).' } };
  }
  if (!path.isAbsolute(trimmed)) {
    return { ok: false, error: { code: 'NOT_ABSOLUTE', message: 'Path must be absolute.' } };
  }
  const normalized = path.normalize(trimmed);
  if (containsTraversalSegment(normalized)) {
    return { ok: false, error: { code: 'PATH_TRAVERSAL', message: 'Path contains parent-directory segments after normalization.' } };
  }

  let stat;
  try {
    stat = await fs.stat(normalized);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EACCES' || e.code === 'EPERM') {
      return { ok: false, error: { code: 'PERMISSION_DENIED', message: e.message } };
    }
    return { ok: false, error: { code: 'NOT_FOUND', message: `Path does not exist: ${normalized}` } };
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: { code: 'NOT_DIRECTORY', message: `Not a directory: ${normalized}` } };
  }

  let entries;
  try {
    entries = await fs.readdir(normalized, { withFileTypes: true });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EACCES' || e.code === 'EPERM') {
      return { ok: false, error: { code: 'PERMISSION_DENIED', message: e.message } };
    }
    throw err;
  }

  const children: DirChild[] = [];
  for (const entry of entries) {
    const childAbs = path.join(normalized, entry.name);
    const isSymlink = entry.isSymbolicLink();

    let isDirectory = entry.isDirectory();
    if (isSymlink) {
      // Resolve and verify the target doesn't escape the queried base.
      let realPath: string | null = null;
      try {
        realPath = await fs.realpath(childAbs);
      } catch {
        realPath = null;
      }
      if (realPath !== null) {
        const rel = path.relative(normalized, realPath);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          // Symlink escapes the base — don't expose as a directory we'll list into.
          isDirectory = false;
        } else {
          try {
            const targetStat = await fs.stat(realPath);
            isDirectory = targetStat.isDirectory();
          } catch {
            isDirectory = false;
          }
        }
      } else {
        isDirectory = false;
      }
    }

    let hasPackageJson = false;
    let hasLockfile = false;
    if (isDirectory && !isSymlink) {
      hasPackageJson = await quickFileCheck(path.join(childAbs, 'package.json'));
      hasLockfile =
        (await quickFileCheck(path.join(childAbs, 'package-lock.json'))) ||
        (await quickFileCheck(path.join(childAbs, 'yarn.lock')));
    }

    children.push({
      name: entry.name,
      absolutePath: childAbs,
      isDirectory,
      isSymlink,
      hasPackageJson,
      hasLockfile
    });
  }

  children.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const parent = path.dirname(normalized);
  const parentPath = parent === normalized ? null : parent;

  return { ok: true, result: { basePath: normalized, parentPath, children } };
}

async function quickFileCheck(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

export function defaultStartPath(): string {
  return os.homedir();
}

/**
 * Enumerate the top-level filesystem roots the picker should show when the user
 * hasn't yet typed a path:
 *
 * - **Windows**: try every drive letter A:\ … Z:\ and return the ones that exist.
 *   This lets the user pick a folder on any mounted drive, not just under their
 *   home directory.
 * - **Unix**: return `/`.
 *
 * Each root is represented as a `DirChild` with `isDirectory: true` so it
 * renders like a normal expandable folder in the tree picker.
 */
export async function listFilesystemRoots(): Promise<DirChild[]> {
  if (process.platform === 'win32') {
    const roots: DirChild[] = [];
    // A=65, Z=90. A: and B: are historically floppy drives but we still try
    // them for completeness — fs.stat fails fast on missing drives.
    for (let code = 65; code <= 90; code++) {
      const letter = String.fromCharCode(code);
      const drivePath = `${letter}:\\`;
      try {
        const stat = await fs.stat(drivePath);
        if (!stat.isDirectory()) continue;
      } catch {
        continue; // drive doesn't exist or isn't accessible
      }
      roots.push({
        name: `${letter}:\\`,
        absolutePath: drivePath,
        isDirectory: true,
        isSymlink: false,
        hasPackageJson: false,
        hasLockfile: false
      });
    }
    return roots;
  }
  return [
    {
      name: '/',
      absolutePath: '/',
      isDirectory: true,
      isSymlink: false,
      hasPackageJson: false,
      hasLockfile: false
    }
  ];
}
