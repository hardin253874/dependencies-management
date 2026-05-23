/**
 * GET /api/fs/list?path=… — server-side filesystem tree picker (spec §6.1, §9.3).
 *
 * Returns immediate children of the given path. Rejects `..` segments and
 * symlinks that point outside the queried base (spec §9.4).
 */
import os from 'os';
import path from 'path';
import { NextResponse } from 'next/server';
import { listDirectory, listFilesystemRoots } from '@/lib/fs/picker';
import { badRequest, forbidden, internalError, notFound } from '@/lib/http/errors';
import { withRequestLog } from '@/lib/http/guards';
import type { FsListResponse } from '@/lib/api-types';

/**
 * Translate a leading `~` into the OS home directory. This is a server-side
 * convenience: even though the Frontend tree-browser should send absolute
 * paths, defensively accept `~` / `~/sub` so clients that haven't been
 * updated yet don't break. Any other use of `~` (e.g. mid-path) is left
 * alone and will be rejected downstream by the picker.
 */
function expandTilde(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export const GET = withRequestLog<unknown>(async (req): Promise<NextResponse> => {
  const url = new URL(req.url);
  const requested = url.searchParams.get('path');

  // No path → return the top-level filesystem roots (drives on Windows, '/' on
  // Unix). Lets the user pick a folder on any mounted drive, not just under
  // their home directory. The response shape is identical to a regular listing
  // so the FE tree code doesn't need a special "roots mode" beyond rendering
  // every entry as a top-level row.
  if (requested === null || requested === '') {
    const roots = await listFilesystemRoots();
    const payload: FsListResponse = {
      path: '',
      parent: null,
      entries: roots.map((c) => ({
        name: c.name,
        path: c.absolutePath,
        isDirectory: c.isDirectory,
        isSymlink: c.isSymlink,
        hasPackageJson: c.hasPackageJson,
        hasLockfile: c.hasLockfile
      }))
    };
    return NextResponse.json<FsListResponse>(payload);
  }

  const target = expandTilde(requested);

  const result = await listDirectory(target);
  if (!result.ok) {
    switch (result.error.code) {
      case 'PATH_TRAVERSAL':
        return forbidden('PATH_TRAVERSAL', result.error.message);
      case 'NOT_ABSOLUTE':
        return badRequest('PATH_NOT_ABSOLUTE', result.error.message);
      case 'NOT_FOUND':
        return notFound('PATH_NOT_FOUND', result.error.message);
      case 'NOT_DIRECTORY':
        return badRequest('NOT_A_DIRECTORY', result.error.message);
      case 'PERMISSION_DENIED':
        return forbidden('PERMISSION_DENIED', result.error.message);
      default:
        return internalError('FS_LIST_FAILED', 'Unknown filesystem error.');
    }
  }

  const payload: FsListResponse = {
    path: result.result.basePath,
    parent: result.result.parentPath,
    entries: result.result.children.map((c) => ({
      name: c.name,
      path: c.absolutePath,
      isDirectory: c.isDirectory,
      isSymlink: c.isSymlink,
      hasPackageJson: c.hasPackageJson,
      hasLockfile: c.hasLockfile
    }))
  };
  return NextResponse.json<FsListResponse>(payload);
});
