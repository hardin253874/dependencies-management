/**
 * Schema migration registry (spec §8.3 / G21).
 *
 * Stub for v1: no migrations exist yet. The framework is in place so v1.x can
 * add migrations without architectural rework. Each migration takes an
 * envelope-shaped value and returns the next-version envelope.
 */
import type { Envelope } from './envelope';

type AnyEnvelope = Envelope<unknown>;
type Migration = (env: AnyEnvelope) => AnyEnvelope;

/**
 * Map from `fromVersion` → migration that produces `fromVersion + 1`.
 * Empty for v1. Add entries as schema evolves.
 */
const MIGRATIONS: Record<number, Migration> = {};

export const LATEST_SCHEMA_VERSION = 1;

export function applyMigrations<T>(env: Envelope<T>): Envelope<T> {
  if (typeof env.schemaVersion !== 'number') {
    throw new Error(`Envelope missing schemaVersion`);
  }
  let current: AnyEnvelope = env as AnyEnvelope;
  while (current.schemaVersion < LATEST_SCHEMA_VERSION) {
    const migrate = MIGRATIONS[current.schemaVersion];
    if (migrate === undefined) {
      throw new Error(
        `No migration registered from schemaVersion ${current.schemaVersion} → ${current.schemaVersion + 1}`
      );
    }
    current = migrate(current);
    current.schemaVersion += 1;
  }
  if (current.schemaVersion > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `Envelope schemaVersion ${current.schemaVersion} is newer than this build supports (${LATEST_SCHEMA_VERSION}). Upgrade the agent.`
    );
  }
  return current as Envelope<T>;
}
