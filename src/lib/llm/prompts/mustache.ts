/**
 * Minimal Mustache implementation (spec §11.7).
 *
 * Supports the subset our v0 prompt drafts use:
 *   - `{{path.to.value}}` — value lookup (HTML-escaping disabled; we don't render to HTML)
 *   - `{{{path.to.value}}}` — same as `{{...}}` since we never escape
 *   - `{{#name}}…{{/name}}` — falsy-skipping section (also iteration on arrays)
 *   - `{{^name}}…{{/name}}` — inverted section (renders when value is falsy)
 *   - `{{#if path}}…{{/if}}` — alias for section; the v0 prompt drafts in
 *     Appendix A use both `{{#if x}}` and `{{#each xs}}` Handlebars-style,
 *     so we accept both forms.
 *   - `{{#each xs}}…{{/each}}` — array iteration; inside, `{{this}}` resolves
 *     to the current item.
 *   - `../path` — parent-context lookup inside an iteration block
 *
 * Why hand-roll: Mustache + Handlebars compatibility shim. Adds zero runtime
 * deps and matches the prompt drafts exactly.
 *
 * Output is plain text; we never need HTML escaping.
 */

export type RenderContext = Record<string, unknown>;

/** Render a Mustache/Handlebars-flavored template against the context. */
export function renderTemplate(template: string, context: RenderContext): string {
  return renderInner(template, [context]);
}

interface ParsedSection {
  /** The tag content (e.g. "if foo", "each xs", "foo"). */
  expr: string;
  /** The slice of the template inside this section. */
  body: string;
  /** Position after the closing `{{/...}}` tag. */
  end: number;
  /** True if the tag started with `^` (inverted). */
  inverted: boolean;
}

const TAG_RE = /\{\{\s*(\{?[#^/]?\s*[^}]+?)\s*\}{2,3}/g;

function renderInner(template: string, stack: unknown[]): string {
  let out = '';
  let cursor = 0;
  TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_RE.exec(template)) !== null) {
    out += template.slice(cursor, match.index);
    const raw = match[1]!.trim();
    cursor = match.index + match[0].length;

    if (raw.startsWith('/')) {
      // A stray closing tag — we should never reach this case in a well-formed
      // template because section parsing skips over them.
      continue;
    }

    if (raw.startsWith('#')) {
      const section = readSection(template, raw.slice(1).trim(), cursor, false);
      out += renderSection(section, stack);
      cursor = section.end;
      TAG_RE.lastIndex = cursor;
      continue;
    }
    if (raw.startsWith('^')) {
      const section = readSection(template, raw.slice(1).trim(), cursor, true);
      out += renderSection(section, stack);
      cursor = section.end;
      TAG_RE.lastIndex = cursor;
      continue;
    }

    // Plain interpolation.
    const expr = raw.replace(/^\{|\}$/g, '');
    const value = resolveExpr(expr, stack);
    out += stringify(value);
  }
  out += template.slice(cursor);
  return out;
}

function readSection(template: string, openExpr: string, openEnd: number, inverted: boolean): ParsedSection {
  // The "section name" for close-tag matching is the last word in the
  // open-tag expression (handles `if foo` → close `/if`, `each xs` → `/each`,
  // and the simple `foo` → `/foo` case).
  const tagName = openExpr.split(/\s+/)[0]!;
  const closeRe = new RegExp(`\\{\\{\\s*/\\s*${escapeRegex(tagName)}\\s*\\}\\}`, 'g');
  closeRe.lastIndex = openEnd;
  // We need to balance nested sections of the same name.
  const openRe = new RegExp(`\\{\\{\\s*[#^]\\s*${escapeRegex(tagName)}(?:\\s|\\})`, 'g');
  openRe.lastIndex = openEnd;
  let depth = 1;
  let pos = openEnd;
  while (depth > 0) {
    const nextClose = matchAfter(closeRe, template, pos);
    const nextOpen = matchAfter(openRe, template, pos);
    if (nextClose === null) {
      throw new Error(`Mustache: unclosed section ${tagName}`);
    }
    if (nextOpen !== null && nextOpen.index < nextClose.index) {
      depth += 1;
      pos = nextOpen.index + nextOpen[0].length;
    } else {
      depth -= 1;
      pos = nextClose.index + nextClose[0].length;
    }
  }
  // Walk back to find the closing tag's start so we can slice the body
  // without the closing tag included.
  const closeMatch = lastCloseBefore(template, tagName, pos);
  return {
    expr: openExpr,
    body: template.slice(openEnd, closeMatch.start),
    end: closeMatch.endAfter,
    inverted
  };
}

function lastCloseBefore(
  template: string,
  tagName: string,
  cursor: number
): { start: number; endAfter: number } {
  // Find the close tag immediately preceding `cursor` (which is the position
  // just past the close-tag we balanced into).
  const re = new RegExp(`\\{\\{\\s*/\\s*${escapeRegex(tagName)}\\s*\\}\\}`, 'g');
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    if (m.index + m[0].length > cursor) break;
    last = m;
  }
  if (last === null) throw new Error(`Mustache: cannot find close tag for ${tagName}`);
  return { start: last.index, endAfter: last.index + last[0].length };
}

function matchAfter(re: RegExp, template: string, from: number): RegExpExecArray | null {
  re.lastIndex = from;
  return re.exec(template);
}

function renderSection(section: ParsedSection, stack: unknown[]): string {
  // Section expr may be `if foo`, `each foo`, or just `foo`. Normalize.
  const tokens = section.expr.split(/\s+/);
  const keyword = tokens[0];
  const path = keyword === 'if' || keyword === 'each' ? tokens.slice(1).join('') : tokens.join('');
  const value = resolveExpr(path, stack);

  if (section.inverted) {
    if (isFalsyForMustache(value)) return renderInner(section.body, stack);
    return '';
  }

  // Iteration when:
  //  - keyword === 'each', or
  //  - value is an array and is truthy
  if (Array.isArray(value)) {
    if (value.length === 0) return '';
    return value.map((item) => renderInner(section.body, [...stack, item])).join('');
  }

  if (isFalsyForMustache(value)) return '';
  // Object section — push the value as new top of stack.
  if (typeof value === 'object' && value !== null) {
    return renderInner(section.body, [...stack, value]);
  }
  // Scalar truthy — render with parent context.
  return renderInner(section.body, stack);
}

function isFalsyForMustache(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (value === false) return true;
  if (typeof value === 'number' && Number.isNaN(value)) return true;
  if (typeof value === 'string' && value === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

function resolveExpr(expr: string, stack: unknown[]): unknown {
  if (expr === 'this' || expr === '.') return stack[stack.length - 1];

  // Handle ../foo.bar by counting leading `../`.
  let frame = stack.length - 1;
  let path = expr;
  while (path.startsWith('../')) {
    frame -= 1;
    path = path.slice(3);
  }
  if (frame < 0) return undefined;

  const segments = path.split('.').filter((s) => s !== '');
  if (segments.length === 0) return stack[frame];

  // Walk from the targeted frame down. Fall back to ancestors only when the
  // first segment is unresolved in the current frame (so e.g. `foo.bar` finds
  // `foo` even if it lives on the outer context).
  let scope = stack[frame];
  let resolved: unknown = scope;
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]!;
    if (i === 0) {
      // Climb stack to find the first segment.
      let found = false;
      for (let f = frame; f >= 0; f -= 1) {
        const ctx = stack[f] as Record<string, unknown> | undefined;
        if (ctx !== null && ctx !== undefined && typeof ctx === 'object' && seg in (ctx as object)) {
          resolved = (ctx as Record<string, unknown>)[seg];
          found = true;
          break;
        }
      }
      if (!found) return undefined;
    } else {
      if (resolved === null || resolved === undefined || typeof resolved !== 'object') return undefined;
      resolved = (resolved as Record<string, unknown>)[seg];
    }
    scope = resolved;
  }
  return resolved;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(stringify).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
