/**
 * Stylesheet references (D3, design §4.1, V2_STAGE3_SPEC 3a.6). Line-level
 * extraction, no Sass/Less parser — hence `confidence: medium` on every edge.
 *
 *  - `@import`, `@use`, `@forward` (Less `@import (reference) "…"` options
 *    allowed), every quoted or `url()` target on the line;
 *  - `url()` anywhere that points at `~pkg/…` or into `node_modules/`;
 *  - remote URLs (`http:`, `https:`, `//`) and `data:` are not code and are
 *    skipped; `//` line comments and single-line block comments are ignored.
 */
import type { ParsedImport } from './parse';

const AT_RULE_RE = /@(?:import|use|forward)\b\s*(?:\([^)]*\)\s*)?(.*)$/;
const QUOTED_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])((?:(?!\3).)+)\3/g;
const URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
// Not `sass:math`-style module URLs: those are Sass builtins, resolved later.
const REMOTE_RE = /^(?:https?:|ftp:|data:|\/\/)/i;

function stripComments(line: string): string {
  let out = line.replace(/\/\*.*?\*\//g, '');
  // A `//` that is not part of a URL (`http://`, `url(//cdn…)`) starts a line comment.
  const idx = out.search(/(^|[^:'"(])\/\//);
  if (idx !== -1) out = out.slice(0, idx === 0 && out.startsWith('//') ? 0 : idx + 1);
  return out;
}

function isPackageUrl(target: string): boolean {
  return target.startsWith('~') || target.includes('node_modules/');
}

export function parseStyleImports(source: string): ParsedImport[] {
  const out: ParsedImport[] = [];
  const lines = source.split('\n');
  lines.forEach((raw, i) => {
    const line = stripComments(raw);
    if (line.trim() === '') return;
    const snippet = raw.trim().slice(0, 1000);
    const push = (spec: string, col: number) => {
      const s = spec.trim();
      if (s === '' || REMOTE_RE.test(s.replace(/^~/, ''))) return;
      out.push({ specifier: s, kind: 'style-import', bindings: [], line: i + 1, col, snippet });
    };

    const at = AT_RULE_RE.exec(line);
    if (at?.[1] !== undefined) {
      const restStart = line.length - at[1].length;
      for (const m of at[1].matchAll(QUOTED_RE)) {
        const target = m[2] ?? m[4];
        if (target !== undefined) push(target, restStart + (m.index ?? 0));
      }
      return;
    }
    for (const m of line.matchAll(URL_RE)) {
      const target = m[2];
      if (target !== undefined && isPackageUrl(target)) push(target, m.index ?? 0);
    }
  });
  return out;
}

/** `#{…}` (Sass), `@{…}` (Less) or a bare variable as the target → cannot be resolved statically. */
export function isInterpolatedStyleSpecifier(spec: string): boolean {
  return /#\{|@\{|^\$|^@/.test(spec);
}
