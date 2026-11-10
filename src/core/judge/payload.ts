/**
 * Payload builders per class (V2_STAGE5_SPEC 5b.3). The only way to build a
 * `JudgePayload`: code decides what may leave the machine.
 *
 * - `metadataPayload`: numbers, booleans, null, enum strings from a fixed
 *   list, npm package names, semver versions/ranges and ISO dates. Any other
 *   string throws `JudgePrivacyError` (a path, a code line, a sentence).
 * - `publicTextPayload`: public text (J4 `.d.ts` signatures, J7 advisory
 *   text, J8 public report text), size-capped.
 * - `sourcePayload`: target-project source snippets (J1–J3), each capped at
 *   40 lines / 2 KB, the whole request bounded so it stays under Jev's 64k
 *   context. The privacy guard decides whether a source payload may be sent.
 */
import semver from 'semver';
import { JudgePrivacyError, type JudgePayload } from './types';

/** Fixed enum vocabulary allowed in metadata payloads. Extend only with code-defined labels. */
export const METADATA_ENUMS: readonly string[] = Object.freeze([
  // router facts
  'update-report', 'deep-report', 'file-review', 'agent',
  'major', 'minor', 'patch', 'none', 'add', 'remove',
  // dependency sections / J5 / J6
  'dependencies', 'devDependencies', 'peerDependencies', 'volta',
  'keep', 'upgrade', 'investigate', 'unknown'
]);

/** validate-npm-package-name "new package" rules: lowercase, url-safe, optional scope, ≤ 214 chars. */
const NPM_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
const MAX_DEPTH = 4;
const MAX_METADATA_STRING = 214;

export const SNIPPET_MAX_LINES = 40;
export const SNIPPET_MAX_BYTES = 2_048;
/** Bound on one request's serialized size; UTF-8 bytes are an upper bound on tokens, 64k context minus headroom. */
export const REQUEST_MAX_BOUND_TOKENS = 48_000;
export const PUBLIC_TEXT_MAX_BYTES = 16_384;

export function isMetadataString(s: string): boolean {
  if (s.length === 0 || s.length > MAX_METADATA_STRING) return false;
  if (METADATA_ENUMS.includes(s)) return true;
  if (NPM_NAME_RE.test(s)) return true;
  if (ISO_DATE_RE.test(s) && !Number.isNaN(Date.parse(s))) return true;
  // semver: a version or a range. `validRange` alone accepts e.g. "x"; that is a range too.
  if (/^[0-9xX*^~<>=|.\s+a-zA-Z-]+$/.test(s) && (semver.valid(s) !== null || semver.validRange(s) !== null)) return true;
  return false;
}

function checkMetadata(value: unknown, where: string, depth: number): void {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new JudgePrivacyError(`metadata field ${where}: non-finite number`);
    return;
  }
  if (typeof value === 'string') {
    if (!isMetadataString(value)) throw new JudgePrivacyError(`metadata field ${where}: string is not an enum, package name, semver or ISO date`);
    return;
  }
  if (depth >= MAX_DEPTH) throw new JudgePrivacyError(`metadata field ${where}: nested too deep`);
  if (Array.isArray(value)) {
    value.forEach((v, i) => checkMetadata(v, `${where}[${i}]`, depth + 1));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Keys are code-defined; a key shaped like data (a path, a package name with `/`) is refused too.
      if (!KEY_RE.test(k) && !NPM_NAME_RE.test(k)) throw new JudgePrivacyError(`metadata field ${where}: key is not an identifier or package name`);
      checkMetadata(v, `${where}.${k}`, depth + 1);
    }
    return;
  }
  throw new JudgePrivacyError(`metadata field ${where}: unsupported type ${typeof value}`);
}

export function metadataPayload(fields: Record<string, unknown>): JudgePayload {
  checkMetadata(fields, 'state', 0);
  return Object.freeze({ payloadClass: 'metadata' as const, state: structuredClone(fields) });
}

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Cuts at a UTF-8 byte budget without splitting a code point. */
export function clipBytes(s: string, maxBytes: number): string {
  if (utf8Bytes(s) <= maxBytes) return s;
  let out = '';
  let used = 0;
  for (const ch of s) {
    const b = utf8Bytes(ch);
    if (used + b > maxBytes) break;
    out += ch;
    used += b;
  }
  return out;
}

export function publicTextPayload(fields: { text: Record<string, string>; meta?: Record<string, unknown> }): JudgePayload {
  if (fields.meta !== undefined) checkMetadata(fields.meta, 'meta', 1);
  const text: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields.text)) {
    if (!KEY_RE.test(k)) throw new JudgePrivacyError(`public text key ${k} is not an identifier`);
    text[k] = clipBytes(v, PUBLIC_TEXT_MAX_BYTES);
  }
  return Object.freeze({ payloadClass: 'public-text' as const, state: { ...(fields.meta !== undefined ? { meta: structuredClone(fields.meta) } : {}), text } });
}

export interface SourceSnippet {
  /** Project-relative POSIX path. */
  path: string;
  text: string;
}

export function capSnippet(text: string): string {
  const lines = text.split(/\r?\n/).slice(0, SNIPPET_MAX_LINES).join('\n');
  return clipBytes(lines, SNIPPET_MAX_BYTES);
}

export function sourcePayload(fields: { snippets: readonly SourceSnippet[]; meta?: Record<string, unknown>; publicText?: Record<string, string> }): JudgePayload {
  if (fields.meta !== undefined) checkMetadata(fields.meta, 'meta', 1);
  const snippets = fields.snippets.map((s) => ({ path: s.path, text: capSnippet(s.text) }));
  const text: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields.publicText ?? {})) {
    if (!KEY_RE.test(k)) throw new JudgePrivacyError(`public text key ${k} is not an identifier`);
    text[k] = clipBytes(v, PUBLIC_TEXT_MAX_BYTES);
  }
  const payload = {
    payloadClass: 'source' as const,
    state: { ...(fields.meta !== undefined ? { meta: structuredClone(fields.meta) } : {}), ...(fields.publicText !== undefined ? { text } : {}), snippets }
  };
  if (utf8Bytes(JSON.stringify(payload.state)) > REQUEST_MAX_BOUND_TOKENS) {
    throw new JudgePrivacyError(`source payload over the ${REQUEST_MAX_BOUND_TOKENS}-token bound; batch it`);
  }
  return Object.freeze(payload);
}

/** UTF-8 bytes of a serialized request: the token upper bound used by the ledger and the batcher. */
export function requestBoundTokens(model: string, state: unknown, questions: unknown): number {
  return utf8Bytes(JSON.stringify({ model, state, questions }));
}
