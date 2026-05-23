/**
 * Gitignore + bake-in skipped-folder resolver (spec §10.6).
 *
 * Returns a function `isIgnored(absolutePath)` that returns true if the path
 * should be skipped by the code scanner. Combines:
 *   1. The bake-in skip list (always skipped, regardless of gitignore):
 *      `node_modules`, `.next`, `dist`, `build`, `out`, `coverage`,
 *      `.git`, `.github`, `.husky`, `.playwright-mcp`, `.vscode`,
 *      `test-results`
 *   2. The target project's `.gitignore` (parsed via the `ignore` library so
 *      gitignore semantics like negation `!`, globbing, and trailing-slash
 *      directory matching are honoured correctly).
 */
import { promises as fs } from 'fs';
import path from 'path';

export const ALWAYS_SKIP_DIRS = [
  'node_modules',
  '.next',
  'dist',
  'build',
  'out',
  'coverage',
  '.git',
  '.github',
  '.husky',
  '.playwright-mcp',
  '.vscode',
  'test-results'
] as const;

const ALWAYS_SKIP_SET = new Set<string>(ALWAYS_SKIP_DIRS);

export interface IgnoreMatcher {
  /** True when the given absolute path is inside an ignored folder/file. */
  isIgnored: (absolutePath: string) => boolean;
}

export interface BuildMatcherOptions {
  /** Absolute path to the project root. */
  projectRoot: string;
  /** Optional override of the gitignore text (defaults to reading from disk). */
  gitignoreContent?: string;
}

export async function buildIgnoreMatcher(opts: BuildMatcherOptions): Promise<IgnoreMatcher> {
  const root = path.resolve(opts.projectRoot);
  let gitignoreText = opts.gitignoreContent ?? null;
  if (gitignoreText === null) {
    try {
      gitignoreText = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    } catch {
      gitignoreText = '';
    }
  }

  // Dynamic import keeps test fixtures lean.
  const ignoreModRaw = await import('ignore');
  const factory = resolveCallable<() => IgnoreInstance>(ignoreModRaw);
  const ig = factory();
  ig.add(gitignoreText);

  return {
    isIgnored: (absolutePath) => {
      const rel = path.relative(root, absolutePath);
      if (rel === '' || rel.startsWith('..')) return false; // outside project root
      // First check the bake-in skip list against ALL ancestor segments,
      // because the user can't disable these via a negation in .gitignore.
      const segments = rel.split(/[\\/]/);
      for (const seg of segments) {
        if (ALWAYS_SKIP_SET.has(seg)) return true;
      }
      // `ignore` expects forward-slashed paths regardless of OS.
      const posix = segments.join('/');
      return ig.ignores(posix);
    }
  };
}

interface IgnoreInstance {
  add: (input: string | string[]) => IgnoreInstance;
  ignores: (path: string) => boolean;
}

/**
 * Resolve a callable export across ESM/CJS interop boundaries. Handles:
 *   - module itself is the callable (CJS `module.exports = fn`)
 *   - module.default is the callable (ESM `export default fn`)
 *   - module.default.default is the callable (re-export chain)
 */
function resolveCallable<T extends (...args: never[]) => unknown>(mod: unknown): T {
  if (typeof mod === 'function') return mod as T;
  if (mod !== null && typeof mod === 'object') {
    const m = mod as { default?: unknown };
    if (typeof m.default === 'function') return m.default as T;
    if (m.default !== null && typeof m.default === 'object') {
      const inner = m.default as { default?: unknown };
      if (typeof inner.default === 'function') return inner.default as T;
    }
  }
  throw new Error('dynamic import did not yield a callable');
}
