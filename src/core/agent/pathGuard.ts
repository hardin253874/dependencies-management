/**
 * Path guard for the file tools (V2_STAGE4_SPEC 4a.3, D7 read-only investigator).
 *
 * A model-supplied path is refused unless it is a plain project-relative path
 * to a file the graph already knows (that set excludes `.gitignore`d files,
 * `node_modules`, `.env*` and oversize junk) or a `package.json`, AND its
 * realpath stays inside the realpath of `workspaceRoot`. Every string check
 * runs before any fs call, so a refused path is never stat'ed or opened.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { createRows } from '../graph/rows';
import { isEnvFileName } from '../graph/walk';
import type { GraphDriver } from '../graph/store';
import type { FileKind } from '../graph/types';
import { ToolError } from './types';

export class PathRefusedError extends ToolError {
  constructor(reason: string) {
    super(`path refused: ${reason}`);
    this.name = 'PathRefusedError';
  }
}

export interface GraphFileEntry {
  path: string;
  kind: FileKind;
  size: number;
}

/** The graph `file` table as path → entry (read through `rows.ts`, no SQL here). */
export function graphFileSet(graph: GraphDriver): Map<string, GraphFileEntry> {
  const out = new Map<string, GraphFileEntry>();
  for (const f of createRows(graph).allFiles()) out.set(f.path, { path: f.path, kind: f.kind, size: f.size });
  return out;
}

/** Pure string checks + normalisation. Returns the POSIX relative path or throws `PathRefusedError`. */
export function normalizeRelPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') throw new PathRefusedError('empty path');
  if (raw.includes('\0')) throw new PathRefusedError('NUL byte');
  // Percent-escapes (`%2e%2e`) are refused instead of decoded: no layer below decodes them, so accepting them only invites confusion.
  if (/%[0-9a-f]{2}/i.test(raw)) throw new PathRefusedError('percent-encoded characters');
  const p = raw.replace(/\\/g, '/');
  if (p.startsWith('/')) throw new PathRefusedError('absolute path (or UNC / device path)');
  if (/^[A-Za-z]:/.test(p)) throw new PathRefusedError('drive-letter path');
  const segments = p.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) throw new PathRefusedError('empty path');
  for (const s of segments) {
    if (s === '..') throw new PathRefusedError('".." segment');
    if (isEnvFileName(s)) throw new PathRefusedError('.env files are never read');
    // A trailing dot/space or an ADS colon aliases another name on Windows.
    if (s.includes(':')) throw new PathRefusedError('":" in a path segment');
    if (/[. ]$/.test(s)) throw new PathRefusedError('segment ends with "." or space');
  }
  return segments.join('/');
}

function isInside(child: string, root: string): boolean {
  const norm = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const rel = path.relative(norm(root), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export interface GuardedPath {
  rel: string;
  abs: string;
}

/**
 * Full guard: string checks, allow-list (graph files + `package.json`), then
 * realpath containment (symlinks / junctions out of the root are refused).
 */
export async function pathGuard(workspaceRoot: string, raw: unknown, allowed: ReadonlyMap<string, unknown>): Promise<GuardedPath> {
  const rel = normalizeRelPath(raw);
  if (!allowed.has(rel) && path.posix.basename(rel) !== 'package.json') {
    throw new PathRefusedError(`"${rel}" is not a source file in the project graph`);
  }
  const rootReal = await fs.realpath(workspaceRoot);
  let real: string;
  try {
    real = await fs.realpath(path.join(rootReal, ...rel.split('/')));
  } catch {
    throw new ToolError(`file not found: ${rel}`);
  }
  if (!isInside(real, rootReal)) throw new PathRefusedError('resolves outside the project root');
  if (isEnvFileName(path.basename(real))) throw new PathRefusedError('.env files are never read');
  return { rel, abs: real };
}
