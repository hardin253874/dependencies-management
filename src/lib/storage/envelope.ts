/**
 * Envelope read/write helpers (spec §8.3).
 *
 * Every JSON file (except _config.json and _projects.json) wraps its data in:
 *   { schemaVersion, generatedAt, source, ttlHours, data }
 *
 * Schema migrations are applied at read time via the registry in ./migrations.ts.
 */
import { atomicWriteJson, readJson } from './atomic';
import { applyMigrations } from './migrations';

export type EnvelopeSource =
  | 'registry'
  | 'deterministic'
  | 'deterministic-partial'
  | 'endoflife.date'
  | `anthropic:${string}`
  | `openai:${string}`;

export interface Envelope<T> {
  schemaVersion: number;
  generatedAt: string;
  source: EnvelopeSource;
  /** null = never auto-expire */
  ttlHours: number | null;
  data: T;
}

export interface WriteEnvelopeInput<T> {
  source: EnvelopeSource;
  ttlHours: number | null;
  data: T;
  schemaVersion?: number;
  /** Optional override for tests; defaults to now. */
  generatedAt?: string;
}

export const CURRENT_SCHEMA_VERSION = 1;

export function makeEnvelope<T>(input: WriteEnvelopeInput<T>): Envelope<T> {
  return {
    schemaVersion: input.schemaVersion ?? CURRENT_SCHEMA_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    source: input.source,
    ttlHours: input.ttlHours,
    data: input.data
  };
}

export async function writeEnvelope<T>(filePath: string, input: WriteEnvelopeInput<T>): Promise<Envelope<T>> {
  const env = makeEnvelope(input);
  await atomicWriteJson(filePath, env);
  return env;
}

export async function readEnvelope<T>(filePath: string): Promise<Envelope<T>> {
  const raw = await readJson<Envelope<T>>(filePath);
  return applyMigrations<T>(raw);
}

/**
 * Returns true when the envelope's TTL has elapsed relative to `now`. Envelopes
 * with ttlHours === null are never considered stale.
 */
export function isStale<T>(env: Envelope<T>, now: Date = new Date()): boolean {
  if (env.ttlHours === null) return false;
  const generated = Date.parse(env.generatedAt);
  if (Number.isNaN(generated)) return true;
  const ageMs = now.getTime() - generated;
  return ageMs > env.ttlHours * 3_600_000;
}
