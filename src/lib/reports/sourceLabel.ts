/**
 * Human label for an envelope `source`. Everything renders as-is except the
 * legacy `openai:<model>` value (v2 removed OpenAI; v1 envelopes stay
 * readable), which is marked so nobody mistakes it for a current run.
 * Pure and total: any string in, a string out, never throws.
 */
const LEGACY_OPENAI_PREFIX = 'openai:';

export function formatSourceLabel(source: string): string {
  if (source.startsWith(LEGACY_OPENAI_PREFIX)) {
    return `OpenAI · ${source.slice(LEGACY_OPENAI_PREFIX.length)} (legacy)`;
  }
  return source;
}
