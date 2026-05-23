/**
 * Code scan (spec §10.6). Walks a target project, parses every `.{js,jsx,ts,
 * tsx,mjs,cjs}` file with `@babel/parser` (typescript plugin), and reports
 * which files import which dependencies.
 *
 * Output is keyed by dependency name; consumers slice it into one usage
 * payload per requested dep.
 *
 * Walk rules:
 *   - Skip folders per `buildIgnoreMatcher` (bake-in list + .gitignore).
 *   - Skip files > 2MB (record in `oversizedSkipped`).
 *   - Skip `.min.{js,mjs,cjs}` minified bundles.
 *
 * Parsing rules:
 *   - Walk `ImportDeclaration` and `CallExpression(callee.name === 'require')`
 *     with a string-literal first arg.
 *   - Dynamic imports (`require(variable)` / `import(variable)`) are captured
 *     into `dynamicImports` (file + line + snippet) but not resolved.
 *
 * Parallelism: `min(8, cpus)` parallel parses via `p-limit` (spec §10.8).
 *
 * Category tagging per §10.6:
 *   - test:   path contains __tests__, __test__, .test., .spec.
 *   - story:  path contains .stories. or .story.
 *   - config: file is at project root AND matches *.config.{js,ts,mjs,cjs}
 *             or starts with `.`
 *   - prod:   anything else
 */
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import pLimit from 'p-limit';
import { buildIgnoreMatcher, type IgnoreMatcher } from './gitignore';
import type { UsageCategory } from '../api-types';

export const PARSEABLE_EXTS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'] as const;
export const MIN_HEURISTIC_RE = /\.min\.(?:js|mjs|cjs)$/i;
export const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;

export interface CodeScanOptions {
  projectRoot: string;
  /** Cap the parallel parse pool; defaults to min(8, cpus). */
  concurrency?: number;
  /** Inject an alternative ignore matcher for tests. */
  matcher?: IgnoreMatcher;
  /** Report progress to caller. */
  onProgress?: (current: number, total: number, label: string) => void;
}

export interface CodeImportSite {
  /** Relative POSIX path from `projectRoot`. */
  path: string;
  /** SHA1 first 12 chars of the relative path (spec §8.2). */
  pathHash: string;
  category: UsageCategory;
  importStatements: string[];
}

export interface CodeDynamicImport {
  file: string;
  line: number;
  snippet: string;
}

export interface CodeOversizedFile {
  path: string;
  sizeBytes: number;
  reason: string;
}

export interface CodeScanResult {
  /** Map from package name → list of files that imported it. */
  imports: Map<string, CodeImportSite[]>;
  dynamicImports: CodeDynamicImport[];
  oversizedSkipped: CodeOversizedFile[];
  totalFilesScanned: number;
}

export async function scanCode(opts: CodeScanOptions): Promise<CodeScanResult> {
  const root = path.resolve(opts.projectRoot);
  const matcher = opts.matcher ?? (await buildIgnoreMatcher({ projectRoot: root }));
  const cpus = os.cpus().length || 1;
  const concurrency = opts.concurrency ?? Math.min(8, cpus);

  const files: string[] = [];
  for await (const file of walk(root, matcher)) {
    if (!isParseable(file)) continue;
    files.push(file);
  }

  const imports = new Map<string, CodeImportSite[]>();
  const dynamicImports: CodeDynamicImport[] = [];
  const oversizedSkipped: CodeOversizedFile[] = [];

  const limit = pLimit(concurrency);
  let processed = 0;

  await Promise.all(
    files.map((file) =>
      limit(async () => {
        const rel = toPosixRel(root, file);
        try {
          const stat = await fs.stat(file);
          if (stat.size > MAX_FILE_SIZE_BYTES) {
            oversizedSkipped.push({ path: rel, sizeBytes: stat.size, reason: 'exceeds 2MB cap' });
            return;
          }
          const content = await fs.readFile(file, 'utf8');
          const parsed = parseImports(content, rel);
          if (parsed.staticImports.length === 0 && parsed.dynamicImports.length === 0) return;

          for (const ent of parsed.dynamicImports) dynamicImports.push(ent);

          if (parsed.staticImports.length > 0) {
            const cat = categorizeFile(rel);
            const hash = sha1Prefix(rel, 12);
            // Group by package name within this file so a file with multiple
            // imports from the same dep produces one entry per dep.
            const byPkg = new Map<string, string[]>();
            for (const imp of parsed.staticImports) {
              const arr = byPkg.get(imp.packageName);
              if (arr === undefined) byPkg.set(imp.packageName, [imp.statement]);
              else arr.push(imp.statement);
            }
            for (const [pkgName, statements] of byPkg) {
              const list = imports.get(pkgName);
              const site: CodeImportSite = {
                path: rel,
                pathHash: hash,
                category: cat,
                importStatements: statements
              };
              if (list === undefined) imports.set(pkgName, [site]);
              else list.push(site);
            }
          }
        } catch {
          // Parser failures are non-fatal — the file is silently skipped. We
          // do not surface parser errors because a strict v0.1 syntax file
          // could pollute the report; the file simply doesn't appear in the
          // usage list.
        } finally {
          processed += 1;
          opts.onProgress?.(processed, files.length, rel);
        }
      })
    )
  );

  return {
    imports,
    dynamicImports,
    oversizedSkipped,
    totalFilesScanned: files.length
  };
}

export function isParseable(file: string): boolean {
  const lower = file.toLowerCase();
  if (MIN_HEURISTIC_RE.test(lower)) return false;
  for (const ext of PARSEABLE_EXTS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

export function categorizeFile(relPosixPath: string): UsageCategory {
  const segments = relPosixPath.split('/');
  const last = segments[segments.length - 1] ?? '';
  if (
    relPosixPath.includes('__tests__') ||
    relPosixPath.includes('__test__') ||
    /\.test\./i.test(last) ||
    /\.spec\./i.test(last)
  ) {
    return 'test';
  }
  if (/\.stories\./i.test(last) || /\.story\./i.test(last)) {
    return 'story';
  }
  if (segments.length === 1) {
    // Root file
    if (last.startsWith('.')) return 'config';
    if (/\.config\.(?:js|ts|mjs|cjs)$/i.test(last)) return 'config';
  }
  return 'prod';
}

export function sha1Prefix(value: string, prefixLen = 12): string {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, prefixLen);
}

function toPosixRel(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join('/');
}

async function* walk(root: string, matcher: IgnoreMatcher): AsyncGenerator<string, void, void> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (matcher.isIgnored(full)) continue;
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile()) {
        yield full;
      }
    }
  }
}

/**
 * Parse a file's source for static + dynamic imports. Returns:
 *   - staticImports: `(packageName, statement)` pairs for resolvable imports
 *   - dynamicImports: line/snippet for `require(x)` / `import(x)` with
 *     non-string-literal arguments
 *
 * Exported for direct unit testing without the filesystem.
 */
export interface ParseImportsResult {
  staticImports: Array<{ packageName: string; statement: string }>;
  dynamicImports: CodeDynamicImport[];
}

// @babel/parser ships a CJS entry that's friendlier to bundlers; we import it
// statically at module init so a synchronous parseImports() call doesn't need
// async plumbing through walkAst. The eslint-config-next stack doesn't enable
// no-require-imports, so we use createRequire to satisfy the strict default.
import { createRequire } from 'module';
const requireFn = createRequire(import.meta.url);
const babelParser = requireFn('@babel/parser') as typeof import('@babel/parser');

export function parseImports(source: string, relPosixPath: string): ParseImportsResult {
  const parser = babelParser;
  let ast;
  try {
    ast = parser.parse(source, {
      sourceType: 'unambiguous',
      allowImportExportEverywhere: true,
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      allowSuperOutsideMethod: true,
      errorRecovery: true,
      plugins: [
        'typescript',
        'jsx',
        'decorators-legacy',
        'classProperties',
        'classPrivateProperties',
        'classPrivateMethods',
        'dynamicImport',
        'importMeta',
        'topLevelAwait'
      ]
    });
  } catch {
    return { staticImports: [], dynamicImports: [] };
  }

  const lines = source.split('\n');
  const staticImports: Array<{ packageName: string; statement: string }> = [];
  const dynamicImports: CodeDynamicImport[] = [];

  walkAst(ast.program.body, (node) => {
    // import statements + export-from declarations
    if (
      node.type === 'ImportDeclaration' ||
      node.type === 'ExportAllDeclaration' ||
      node.type === 'ExportNamedDeclaration'
    ) {
      const source = (node as { source?: { type?: string; value?: string } | null }).source;
      if (source !== null && source !== undefined && source.type === 'StringLiteral' && typeof source.value === 'string') {
        const pkg = packageNameFromSpecifier(source.value);
        if (pkg !== null) {
          const stmt = sliceLine(lines, node.loc?.start?.line);
          staticImports.push({ packageName: pkg, statement: stmt });
        }
      }
      return;
    }
    // require() and import()
    if (node.type === 'CallExpression') {
      const callee = (node as { callee?: { type?: string; name?: string } }).callee;
      if (callee === undefined) return;
      const calleeIsRequire = callee.type === 'Identifier' && callee.name === 'require';
      const calleeIsImport = callee.type === 'Import';
      if (!calleeIsRequire && !calleeIsImport) return;
      const args = (node as { arguments?: Array<{ type?: string; value?: string }> }).arguments;
      const arg = args !== undefined ? args[0] : undefined;
      const line = node.loc?.start?.line ?? 0;
      if (arg !== undefined && arg.type === 'StringLiteral' && typeof arg.value === 'string') {
        const pkg = packageNameFromSpecifier(arg.value);
        if (pkg !== null) {
          staticImports.push({ packageName: pkg, statement: sliceLine(lines, line) });
        }
      } else {
        dynamicImports.push({
          file: relPosixPath,
          line,
          snippet: sliceLine(lines, line)
        });
      }
    }
  });

  return { staticImports, dynamicImports };
}

function sliceLine(lines: string[], line: number | undefined): string {
  if (line === undefined || line < 1) return '';
  return (lines[line - 1] ?? '').trim();
}

/**
 * Extract a package name from an import specifier. Returns null for relative
 * specifiers (`./foo`, `../bar`), bare paths (`/abs`), and node: builtins.
 *
 * Examples:
 *   react           → react
 *   react/jsx-runtime → react
 *   @types/react    → @types/react
 *   @scope/pkg/foo  → @scope/pkg
 *   ./foo           → null
 *   node:fs         → null
 *   data:...        → null
 */
export function packageNameFromSpecifier(spec: string): string | null {
  if (spec.length === 0) return null;
  if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') return null;
  if (spec.startsWith('/')) return null;
  // URL-like / built-in prefixes
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) return null;

  if (spec.startsWith('@')) {
    const segs = spec.split('/');
    if (segs.length < 2) return null;
    return `${segs[0]}/${segs[1]}`;
  }
  const firstSlash = spec.indexOf('/');
  if (firstSlash === -1) return spec;
  return spec.slice(0, firstSlash);
}

interface BabelNodeLike {
  type: string;
  loc?: { start?: { line?: number } };
  [key: string]: unknown;
}

function walkAst(nodes: unknown, visitor: (n: BabelNodeLike) => void): void {
  const seen = new WeakSet<object>();
  const stack: unknown[] = Array.isArray(nodes) ? [...nodes] : [nodes];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === null || typeof cur !== 'object') continue;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if ('type' in cur && typeof (cur as { type?: unknown }).type === 'string') {
      visitor(cur as BabelNodeLike);
    }
    for (const key of Object.keys(cur)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
      const child = (cur as Record<string, unknown>)[key];
      if (child === undefined || child === null) continue;
      if (Array.isArray(child)) {
        for (const e of child) stack.push(e);
      } else if (typeof child === 'object') {
        stack.push(child);
      }
    }
  }
}
