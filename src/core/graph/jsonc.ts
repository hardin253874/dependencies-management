/**
 * Minimal JSONC reader for tsconfig/jsconfig/.babelrc/.eslintrc files, which
 * allow comments and trailing commas. Strips both outside strings, then
 * `JSON.parse`. Returns null on invalid input (configs are best effort).
 */

/** Copies `text` with comments removed; string literals are kept verbatim. */
function stripComments(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i += 1;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** Drops commas that are followed only by whitespace and `}` / `]`, outside strings. */
function stripTrailingCommas(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < n && /\s/.test(text[j]!)) j += 1;
      if (text[j] === '}' || text[j] === ']') {
        i += 1;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

export function stripJsonc(text: string): string {
  return stripTrailingCommas(stripComments(text));
}

export function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(stripJsonc(text.replace(/^﻿/, '')));
  } catch {
    return null;
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
