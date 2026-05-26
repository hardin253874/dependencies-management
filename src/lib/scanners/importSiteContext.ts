/**
 * Import-site + use-site context extractor for the CVE impact analyzer
 * (v0.6, view [A] "Analyze Usage").
 *
 * Given a project root, a dep name, and the dep's cached usage payload, walks
 * each importing file and extracts a window (±20 lines) around:
 *   - The import declaration itself.
 *   - Every line that references any binding imported from the dep.
 *
 * Use-site detection is **regex-based**, not AST-based — deliberately:
 *   - The current code scanner already parses every file once. Re-parsing
 *     here for AST-accurate symbol resolution would roughly double scan cost
 *     for a marginal accuracy gain on a feature that's an LLM input anyway.
 *   - False positives (a comment mentioning a binding name) cost a few tokens
 *     of extra context — the LLM still sees them in context and can reason
 *     correctly. False negatives (dynamic uses like `obj[binding+'']`) are
 *     rare in modern codebases and the LLM can still rule on the import-line
 *     window even when it doesn't see the indirect call.
 *   - Token cap is enforced AFTER window coalescing so a huge file with many
 *     uses doesn't blow the prompt budget; files past the cap are dropped
 *     and `contextTruncated: true` is surfaced in the report.
 *
 * Output shape is designed to be Mustache-friendly: an array of
 * `{ relativePath, windows: [{ startLine, endLine, code }] }` so the prompt
 * template can iterate without per-render normalization.
 */
import { promises as fs } from 'fs';
import path from 'path';

/**
 * One coalesced window of source code from one file, with line metadata so
 * the LLM can cite "file:line-range" precisely in its verdict.
 */
export interface CodeWindow {
  /** 1-indexed inclusive start line. */
  startLine: number;
  /** 1-indexed inclusive end line. */
  endLine: number;
  /** The raw source code of those lines, newline-joined. */
  code: string;
}

export interface FileContextResult {
  /** POSIX relative path from `projectRoot` (matches the usage cache shape). */
  relativePath: string;
  /** Coalesced windows around imports + use sites. Empty when no usage lines found. */
  windows: CodeWindow[];
  /** Total chars across all windows — used by the token estimator. */
  charCount: number;
}

export interface ExtractContextResult {
  files: FileContextResult[];
  /** True when the 30k-token cap dropped at least one file's context. */
  truncated: boolean;
  /** Heuristic input-token count (chars / 4). Surfaced in the report. */
  approxTokens: number;
}

export interface ExtractOptions {
  projectRoot: string;
  /**
   * The dep name to find import + use sites for. Used both to match the
   * `from '<depName>'` clause and to detect binding references.
   */
  depName: string;
  /**
   * Relative paths of files known to import this dep (from `usage/<dep>.json`).
   * The extractor only reads these — it doesn't re-scan the entire project.
   */
  importingFiles: string[];
  /** Lines of context above + below each match (default 20). */
  contextRadius?: number;
  /** Max total chars across all windows (default ≈ 30k tokens × 4 chars/token = 120000). */
  maxTotalChars?: number;
  /** Test seam — swap fs.readFile. */
  readFile?: (absPath: string) => Promise<string>;
}

const DEFAULT_RADIUS = 20;
/**
 * 30k tokens × ~4 chars/token. Keeps the LLM prompt input below the
 * `TOKEN_BUDGET_*` envelope while still permitting a reasonable amount of
 * code context. Smaller projects easily fit; pathological cases truncate.
 */
const DEFAULT_MAX_CHARS = 120_000;

export async function extractImportSiteContext(
  opts: ExtractOptions
): Promise<ExtractContextResult> {
  const radius = opts.contextRadius ?? DEFAULT_RADIUS;
  const maxChars = opts.maxTotalChars ?? DEFAULT_MAX_CHARS;
  const reader = opts.readFile ?? ((p) => fs.readFile(p, 'utf8'));

  const files: FileContextResult[] = [];
  let runningChars = 0;
  let truncated = false;

  for (const relPath of opts.importingFiles) {
    if (runningChars >= maxChars) {
      // Already over the cap — every remaining file is dropped.
      truncated = true;
      break;
    }
    const absPath = path.resolve(opts.projectRoot, relPath);
    let source: string;
    try {
      source = await reader(absPath);
    } catch {
      // File missing or unreadable — skip silently. The usage cache may be
      // stale (file deleted since the last scan) but that's not fatal for
      // the analysis.
      continue;
    }
    const lines = source.split('\n');
    const windows = buildWindowsForFile(lines, opts.depName, radius);
    if (windows.length === 0) {
      // No matches — usage cache thinks this file imports the dep but we
      // can't find the import line in current source. Skip.
      continue;
    }
    const charCount = windows.reduce((sum, w) => sum + w.code.length, 0);
    if (runningChars + charCount > maxChars) {
      // Adding this file would exceed the cap — drop it, mark truncated.
      // We don't try to partially fit a single file because that breaks the
      // line-citation contract with the LLM.
      truncated = true;
      continue;
    }
    files.push({ relativePath: relPath, windows, charCount });
    runningChars += charCount;
  }

  return {
    files,
    truncated,
    approxTokens: Math.ceil(runningChars / 4)
  };
}

/**
 * For one file's source lines, find every line that matches the import-line
 * heuristic OR mentions any binding name imported from the dep. Return a
 * sorted, coalesced list of ±radius windows.
 *
 * Heuristics:
 *   - Import line: contains `from '<dep>'`, `from "<dep>"`, or
 *     `require('<dep>')` / `require("<dep>")`. The dep is escaped for use
 *     inside the regex.
 *   - Binding extraction: from each import line, pull out:
 *       * The default import (`import X from 'dep'` → `X`)
 *       * The namespace import (`import * as X from 'dep'` → `X`)
 *       * The named imports (`import { a, b as c } from 'dep'` → `a`, `c`)
 *       * The CJS-destructure pattern (`const { a, b } = require('dep')` → `a`, `b`)
 *   - Use line: any line whose word-boundary-bounded text contains one of
 *     the extracted binding names. Comments / strings are NOT excluded
 *     (false positives are fine — see file header).
 */
function buildWindowsForFile(
  lines: string[],
  depName: string,
  radius: number
): CodeWindow[] {
  const escaped = depName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fromImportRe = new RegExp(`from\\s+['"]${escaped}['"]`);
  const requireImportRe = new RegExp(`require\\(\\s*['"]${escaped}['"]\\s*\\)`);

  // Pass 1: locate import lines, extract bound symbol names.
  const importLineIdxs: number[] = [];
  const bindings = new Set<string>();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (fromImportRe.test(line) || requireImportRe.test(line)) {
      importLineIdxs.push(i);
      for (const name of extractBindings(line)) bindings.add(name);
    }
  }
  if (importLineIdxs.length === 0) return [];

  // Pass 2: locate use lines (any line referencing one of the bindings, by
  // word boundary). Drop the import lines themselves from this set since
  // they're already pulled in.
  const useLineIdxs = new Set<number>();
  for (const idx of importLineIdxs) useLineIdxs.add(idx);
  if (bindings.size > 0) {
    const bindingRe = new RegExp(
      `\\b(?:${Array.from(bindings)
        .map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|')})\\b`
    );
    for (let i = 0; i < lines.length; i += 1) {
      if (useLineIdxs.has(i)) continue;
      const line = lines[i] ?? '';
      if (bindingRe.test(line)) useLineIdxs.add(i);
    }
  }

  // Pass 3: build raw ±radius windows around each use line, then coalesce
  // any overlapping / touching windows into single ranges.
  const sortedIdxs = Array.from(useLineIdxs).sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  for (const idx of sortedIdxs) {
    const start = Math.max(0, idx - radius);
    const end = Math.min(lines.length - 1, idx + radius);
    if (ranges.length === 0) {
      ranges.push([start, end]);
      continue;
    }
    const last = ranges[ranges.length - 1]!;
    if (start <= last[1] + 1) {
      // Overlaps or directly adjacent — extend the previous range.
      last[1] = Math.max(last[1], end);
    } else {
      ranges.push([start, end]);
    }
  }

  return ranges.map(([start, end]) => ({
    startLine: start + 1, // 1-indexed for human-friendly citations
    endLine: end + 1,
    code: lines.slice(start, end + 1).join('\n')
  }));
}

/**
 * Pull the binding names from a single import / require line. Forgiving:
 * if the line doesn't parse cleanly, returns an empty array (the import
 * line itself will still be captured by the import-line pass).
 */
export function extractBindings(line: string): string[] {
  const names = new Set<string>();
  // import default
  const defaultMatch = /import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{|from)/.exec(line);
  if (defaultMatch?.[1] !== undefined) names.add(defaultMatch[1]);
  // import * as X
  const nsMatch = /import\s+\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(line);
  if (nsMatch?.[1] !== undefined) names.add(nsMatch[1]);
  // import { a, b as c }
  const namedMatch = /import\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?\{\s*([^}]+)\}/.exec(line);
  if (namedMatch?.[1] !== undefined) {
    for (const seg of namedMatch[1].split(',')) {
      // segment can be "a" or "a as b" — we want the local binding (after `as`)
      const trimmed = seg.trim();
      if (trimmed === '') continue;
      const asMatch = /([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/.exec(trimmed);
      if (asMatch?.[2] !== undefined) {
        names.add(asMatch[2]);
      } else {
        const plain = /^([A-Za-z_$][\w$]*)$/.exec(trimmed);
        if (plain?.[1] !== undefined) names.add(plain[1]);
      }
    }
  }
  // const X = require('...')
  const cjsDefault = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(/.exec(line);
  if (cjsDefault?.[1] !== undefined) names.add(cjsDefault[1]);
  // const { a, b } = require('...')
  const cjsDestr = /(?:const|let|var)\s+\{\s*([^}]+)\}\s*=\s*require\(/.exec(line);
  if (cjsDestr?.[1] !== undefined) {
    for (const seg of cjsDestr[1].split(',')) {
      const trimmed = seg.trim();
      if (trimmed === '') continue;
      const asMatch = /([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)/.exec(trimmed);
      if (asMatch?.[2] !== undefined) {
        names.add(asMatch[2]);
      } else {
        const plain = /^([A-Za-z_$][\w$]*)$/.exec(trimmed);
        if (plain?.[1] !== undefined) names.add(plain[1]);
      }
    }
  }
  return Array.from(names);
}
