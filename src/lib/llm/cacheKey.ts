/**
 * AI cache key (spec §11.10).
 *
 * Cache key = sha256(rendered prompt + tool schema + model name).
 *
 * Concrete inputs:
 *   - The fully-rendered system + user prompt (post-Mustache substitution).
 *     The rendering already includes the dep metadata, file hash, lockfile
 *     state hash, etc., so this single string captures every input that
 *     should bust the cache.
 *   - The tool schema, serialized via canonical JSON (sorted keys) so map
 *     iteration order can't accidentally bust the hash on identical schemas.
 *   - The model name (so switching models forces a re-run).
 *
 * Output is the hex digest. Stable across machines, deterministic, and an
 * obvious key for both fixture lookup (MOCK_LLM) and on-disk cache filenames.
 */
import crypto from 'crypto';
import type { ToolSchema } from './client';

export interface CacheKeyInput {
  systemPrompt: string;
  userPrompt: string;
  tool: ToolSchema;
  model: string;
}

export function computeCacheKey(input: CacheKeyInput): string {
  const payload = canonicalJsonStringify({
    systemPrompt: input.systemPrompt,
    userPrompt: input.userPrompt,
    tool: input.tool,
    model: input.model
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Canonical JSON: keys sorted at every depth. JSON.stringify with a sort-by-
 * key replacer would only sort one level; this recurses. Arrays preserve
 * order (which is semantically meaningful in a JSON schema's `enum` etc.).
 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
