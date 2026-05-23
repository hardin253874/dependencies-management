/**
 * File-content truncation strategy for view [E] (spec §11.4).
 *
 * Three-step pipeline:
 *   1. Strip comments + collapse whitespace — typically buys ~20% slack.
 *   2. If still over budget, smart-slice: keep imports + lines mentioning
 *      the dep's known symbols + ±10 lines of context, plus all import
 *      statements at the top.
 *   3. If still over budget, hard truncate from the bottom; set `truncated:
 *      true` and the consumer warns the LLM in the prompt.
 *
 * Token-counting is approximated as 4 chars/token — a standard ballpark for
 * English code. Adapters report actual token usage post-call; this is only
 * the pre-call budget guard so we don't blow the configured `maxInputTokens`.
 *
 * Heuristics:
 *   - We don't full-parse. The intent is best-effort triage, not a precise
 *     code transformation. Worst case we keep too much, the LLM trims its
 *     own attention. Best case we keep the right lines and the model
 *     ignores the rest.
 */

const CHARS_PER_TOKEN = 4;
const CONTEXT_LINES = 10;

export interface TruncateOptions {
  /** Full file contents (utf-8 string). */
  content: string;
  /** Hard input-token budget; we slice to stay under this. */
  maxInputTokens: number;
  /**
   * Reserved token budget for the rest of the prompt (system + user
   * boilerplate + tool schema). The content gets `maxInputTokens - reserved`.
   */
  reservedTokens: number;
  /**
   * Symbols / names known to be exported by the target dep. Lines containing
   * these substrings are prioritized when smart-slicing.
   */
  knownSymbols: string[];
}

export interface TruncateResult {
  /** Final content to embed in the prompt. */
  content: string;
  /** True if any truncation happened (either smart-slice or hard cut). */
  truncated: boolean;
  /** Approximate token count of the final content. */
  approxTokens: number;
  /** Set when we couldn't preserve enough context (smart-slice or hard cut). */
  warning?: string;
}

export function truncateFileContent(opts: TruncateOptions): TruncateResult {
  const budgetChars = Math.max(0, (opts.maxInputTokens - opts.reservedTokens) * CHARS_PER_TOKEN);

  // Step 0: nothing to do if already within budget.
  if (opts.content.length <= budgetChars) {
    return { content: opts.content, truncated: false, approxTokens: Math.ceil(opts.content.length / CHARS_PER_TOKEN) };
  }

  // Step 1: strip comments + collapse whitespace.
  const stripped = stripCommentsAndCollapse(opts.content);
  if (stripped.length <= budgetChars) {
    return {
      content: stripped,
      truncated: true,
      approxTokens: Math.ceil(stripped.length / CHARS_PER_TOKEN),
      warning: 'Comments stripped to fit input budget.'
    };
  }

  // Step 2: smart slice.
  const sliced = smartSlice(stripped, opts.knownSymbols);
  if (sliced.length <= budgetChars) {
    return {
      content: sliced,
      truncated: true,
      approxTokens: Math.ceil(sliced.length / CHARS_PER_TOKEN),
      warning: 'File smart-sliced to imports + dep-symbol lines + ±10 lines of context.'
    };
  }

  // Step 3: hard truncate from the bottom.
  const hard = sliced.slice(0, budgetChars);
  const lastNewline = hard.lastIndexOf('\n');
  const safeEnd = lastNewline > budgetChars * 0.5 ? lastNewline : budgetChars;
  const finalContent = `${hard.slice(0, safeEnd)}\n// [TRUNCATED — file exceeded input budget. Findings beyond this point are not analyzed.]\n`;
  return {
    content: finalContent,
    truncated: true,
    approxTokens: Math.ceil(finalContent.length / CHARS_PER_TOKEN),
    warning: 'Hard truncate applied after comment-strip + smart-slice still exceeded budget.'
  };
}

// ---------------------------------------------------------------------------
// Comment stripper — block + line comments, preserves strings + template
// literals (very basic, but safe enough for legacy JS/TS files).
// ---------------------------------------------------------------------------

export function stripCommentsAndCollapse(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    const next = src[i + 1] ?? '';

    // Line comment.
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    // Block comment.
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    // String literal — preserve.
    if (c === '"' || c === '\'' || c === '`') {
      const quote = c;
      out += c;
      i += 1;
      while (i < n) {
        const ch = src[i]!;
        out += ch;
        i += 1;
        if (ch === '\\' && i < n) {
          out += src[i]!;
          i += 1;
          continue;
        }
        if (ch === quote) break;
      }
      continue;
    }
    out += c;
    i += 1;
  }

  // Collapse runs of blank lines.
  return out.replace(/\n[ \t]*\n[ \t]*\n+/g, '\n\n');
}

// ---------------------------------------------------------------------------
// Smart slice — keep imports + dep-symbol-bearing lines + ±10 lines of context.
// ---------------------------------------------------------------------------

export function smartSlice(src: string, knownSymbols: string[]): string {
  const lines = src.split('\n');
  const keepFlags = new Array<boolean>(lines.length).fill(false);
  const symbolSet = new Set(knownSymbols.filter((s) => s.length > 1));

  // Always-keep: import / require statements at any depth.
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^\s*import\b/.test(line) || /\brequire\s*\(/.test(line)) {
      keepFlags[i] = true;
    }
  }

  // Symbol-bearing lines.
  if (symbolSet.size > 0) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      for (const sym of symbolSet) {
        if (line.includes(sym)) {
          keepFlags[i] = true;
          break;
        }
      }
    }
  }

  // ±10 lines of context around any flagged line.
  const contextFlags = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i += 1) {
    if (!keepFlags[i]) continue;
    const lo = Math.max(0, i - CONTEXT_LINES);
    const hi = Math.min(lines.length - 1, i + CONTEXT_LINES);
    for (let j = lo; j <= hi; j += 1) contextFlags[j] = true;
  }

  const out: string[] = [];
  let lastIncluded = -2;
  for (let i = 0; i < lines.length; i += 1) {
    if (!contextFlags[i]) continue;
    if (i - lastIncluded > 1) {
      out.push(`// ... (lines ${lastIncluded + 2}..${i} omitted) ...`);
    }
    out.push(lines[i]!);
    lastIncluded = i;
  }
  return out.join('\n');
}
