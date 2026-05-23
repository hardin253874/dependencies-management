import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { createSandbox, disposeAllSandboxes, type Sandbox } from './helpers/sandbox';
import { writeEnvelope, readEnvelope, isStale, makeEnvelope, CURRENT_SCHEMA_VERSION } from '@/lib/storage/envelope';
import { applyMigrations } from '@/lib/storage/migrations';

let sandbox: Sandbox | undefined;

afterEach(async () => {
  if (sandbox !== undefined) await sandbox.dispose();
  await disposeAllSandboxes();
});

describe('envelope read/write round-trip', () => {
  it('writes and reads back identical payload', async () => {
    sandbox = await createSandbox('envelope');
    const fp = path.join(sandbox.libraryRoot, 'dep.json');
    const data = { name: 'react', notes: 'hello', count: 7 };
    const written = await writeEnvelope(fp, { source: 'registry', ttlHours: 24, data });
    expect(written.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);

    const read = await readEnvelope<typeof data>(fp);
    expect(read.data).toEqual(data);
    expect(read.source).toBe('registry');
    expect(read.ttlHours).toBe(24);
    expect(read.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('isStale returns false for never-expire (ttlHours = null)', () => {
    const env = makeEnvelope({ source: 'deterministic', ttlHours: null, data: {} });
    expect(isStale(env)).toBe(false);
  });

  it('isStale returns true when age exceeds TTL', () => {
    const past = new Date(Date.now() - 30 * 3_600_000).toISOString();
    const env = makeEnvelope({ source: 'registry', ttlHours: 24, data: {}, generatedAt: past });
    expect(isStale(env)).toBe(true);
  });

  it('isStale returns false when age is within TTL', () => {
    const recent = new Date(Date.now() - 3_600_000).toISOString();
    const env = makeEnvelope({ source: 'registry', ttlHours: 24, data: {}, generatedAt: recent });
    expect(isStale(env)).toBe(false);
  });
});

describe('schema migration stub', () => {
  it('passes through current schemaVersion as no-op', () => {
    const env = makeEnvelope({ source: 'deterministic', ttlHours: null, data: { x: 1 } });
    expect(env.schemaVersion).toBe(1);
    const after = applyMigrations(env);
    expect(after.schemaVersion).toBe(1);
    expect(after.data).toEqual({ x: 1 });
  });

  it('rejects envelopes from a newer build', () => {
    const env = { ...makeEnvelope({ source: 'deterministic', ttlHours: null, data: {} }), schemaVersion: 999 };
    expect(() => applyMigrations(env)).toThrow(/newer than this build/);
  });

  it('rejects envelopes with missing schemaVersion', () => {
    // @ts-expect-error: intentional bad shape
    expect(() => applyMigrations({ data: {}, source: 'x', ttlHours: null })).toThrow(/missing schemaVersion/);
  });
});
