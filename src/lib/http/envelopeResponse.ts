/**
 * Read a persisted envelope JSON file and return either:
 *   - The flat `FileEnvelope<T>` JSON response (200) per spec §8.3
 *   - `404 NOT_CACHED` (the convention for cache-first reads, spec §9.1)
 *
 * The frontend derives `stale` itself from `generatedAt` + `ttlHours` so the
 * wire shape matches the on-disk shape (spec §8.3). This convergence is the
 * Stage 2 carry-over called out in REVIEW_stage_2_backend.md.
 */
import { NextResponse } from 'next/server';
import { readEnvelope } from '../storage/envelope';
import { pathExists } from '../storage/atomic';
import { notFound, internalError } from './errors';
import type { FileEnvelope } from '../api-types';

export async function envelopeOr404<T>(filePath: string): Promise<NextResponse> {
  if (!(await pathExists(filePath))) {
    return notFound('NOT_CACHED', 'No cached data for this resource. POST refresh first.');
  }
  try {
    const env = await readEnvelope<T>(filePath);
    // The on-disk envelope already matches the FileEnvelope<T> contract. We
    // re-shape it explicitly so tests and consumers can rely on field order
    // and on the fact that no internal-only fields slip out.
    const flat: FileEnvelope<T> = {
      schemaVersion: env.schemaVersion as 1,
      generatedAt: env.generatedAt,
      source: env.source,
      ttlHours: env.ttlHours,
      data: env.data
    };
    return NextResponse.json<FileEnvelope<T>>(flat);
  } catch (err) {
    return internalError('ENVELOPE_READ_FAILED', (err as Error).message);
  }
}
