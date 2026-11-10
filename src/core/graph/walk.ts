/**
 * Deterministic source-file discovery (V2_STAGE3_SPEC §2, 3a.3).
 *
 * - Folder skips: `ALWAYS_SKIP_DIRS` + the target's `.gitignore`, via the v1
 *   matcher (same policy as `scanCode`, so v1 and v2 see the same tree).
 * - `.env*` names are dropped on sight from the `readdir` listing: never
 *   stat'd, opened or read, whatever `.gitignore` says (v2 invariant).
 * - `.min.{js,mjs,cjs}` files are dropped (as in v1); files over 2 MB are
 *   returned with `skipReason: 'oversized'` so callers can report them.
 * - Symlinks: a link whose real path leaves the root is skipped; directory
 *   links inside the root are skipped too (their target is walked directly,
 *   and following them could loop).
 *
 * The walk never reads file contents itself; only `buildIgnoreMatcher` reads
 * the project's `.gitignore`.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { buildIgnoreMatcher, type IgnoreMatcher } from '../../lib/scanners/gitignore';
import { categorizeFile, MAX_FILE_SIZE_BYTES, MIN_HEURISTIC_RE } from '../../lib/scanners/code';
import { dataConfigInfo, jsConfigInfo } from './configFiles';
import type { FileCategory, FileKind, SkipReason } from './types';

export const JS_EXTS: readonly string[] = Object.freeze(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts']);
export const STYLE_EXTS: readonly string[] = Object.freeze(['.css', '.scss', '.sass', '.less']);

export interface WalkEntry {
  /** POSIX path relative to the project root. */
  path: string;
  absPath: string;
  size: number;
  mtimeMs: number;
  kind: FileKind;
  category: FileCategory;
  skipReason: SkipReason | null;
}

export interface WalkOptions {
  projectRoot: string;
  matcher?: IgnoreMatcher;
}

/** True for `.env`, `.env.local`, `.envrc`, … — the hard-skip rule. */
export function isEnvFileName(name: string): boolean {
  return name.startsWith('.env');
}

export function fileKindOf(relPosixPath: string): FileKind | null {
  const lower = relPosixPath.toLowerCase();
  const ext = path.posix.extname(lower);
  if (JS_EXTS.includes(ext)) return MIN_HEURISTIC_RE.test(lower) ? null : 'js';
  if (STYLE_EXTS.includes(ext)) return 'style';
  if (dataConfigInfo(relPosixPath) !== null) return 'config';
  return null;
}

function categoryOf(rel: string, kind: FileKind): FileCategory {
  if (kind === 'config' || jsConfigInfo(rel) !== null) return 'config';
  return categorizeFile(rel);
}

function isInside(child: string, root: string): boolean {
  const key = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rel = path.relative(key(root), key(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export async function walkProject(opts: WalkOptions): Promise<WalkEntry[]> {
  const root = path.resolve(opts.projectRoot);
  const realRoot = await fs.realpath(root);
  const matcher = opts.matcher ?? (await buildIgnoreMatcher({ projectRoot: root }));
  const out: WalkEntry[] = [];
  const stack: string[] = [root];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (isEnvFileName(e.name)) continue;
      const full = path.join(dir, e.name);
      if (matcher.isIgnored(full)) continue;

      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        let real: string;
        try {
          real = await fs.realpath(full);
        } catch {
          continue; // dangling link
        }
        if (!isInside(real, realRoot)) continue; // outside-root
        const st = await fs.stat(full).catch(() => null);
        if (st === null || st.isDirectory()) continue;
        isDir = false;
        isFile = st.isFile();
      }

      if (isDir) {
        stack.push(full);
        continue;
      }
      if (!isFile) continue;

      const rel = path.relative(root, full).split(path.sep).join('/');
      const kind = fileKindOf(rel);
      if (kind === null) continue;
      const st = await fs.stat(full).catch(() => null);
      if (st === null) continue;
      out.push({
        path: rel,
        absPath: full,
        size: st.size,
        mtimeMs: st.mtimeMs,
        kind,
        category: categoryOf(rel, kind),
        skipReason: st.size > MAX_FILE_SIZE_BYTES ? 'oversized' : null
      });
    }
  }

  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}
