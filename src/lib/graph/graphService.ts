/**
 * App-side entry point to the code graph (V2_STAGE3_SPEC 3b-A.1).
 *
 * - Builds/refreshes `library/<slug>/graph.db` with `mode: 'auto'` (full on
 *   first run, relocation, schema/parser/resolver change; else incremental).
 * - Runs under `withProjectLock('graph:<slug>')`: a separate key from the
 *   slug's `project.json` lock, so a long build does not block those writers,
 *   while two builds of the same project (or a build and a delete) serialize.
 * - Maps build progress onto the job's `phase: 'scan'` reports.
 */
import { buildGraph, type BuildGraphResult, type BuildProgress } from '@/core/graph/build';
import { graphDbPath } from '@/lib/paths';
import { withProjectLock } from '@/lib/storage/projectLock';
import { getLogger } from '@/lib/logger';
import type { JobProgress } from '@/lib/jobs/types';
import { closeGraphReaders } from '@/lib/graph/readerCache';

export function graphLockKey(slug: string): string {
  return `graph:${slug}`;
}

/** Runs `fn` while no graph build for `slug` is in flight (e.g. deleting the project dir). */
export function withProjectGraphLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  return withProjectLock(graphLockKey(slug), fn);
}

export interface RefreshProjectGraphInput {
  slug: string;
  projectRoot: string;
  report?: (p: JobProgress) => void;
  signal?: AbortSignal;
}

const PHASE_LABEL: Readonly<Record<BuildProgress['phase'], string>> = Object.freeze({
  walk: 'graph: listing files',
  parse: 'graph: parsing',
  resolve: 'graph: resolving imports',
  write: 'graph: writing'
});

function isAbort(err: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (err instanceof Error && err.name === 'AbortError');
}

export async function refreshProjectGraph(input: RefreshProjectGraphInput): Promise<BuildGraphResult> {
  const { slug, projectRoot, report, signal } = input;
  const log = (await getLogger()).child({ scope: 'graph', slug });
  try {
    const result = await buildGraph({
      projectRoot,
      dbPath: graphDbPath(slug),
      mode: 'auto',
      // Release the cached reader once the lock is held, not before: a corrupt
      // DB is deleted and recreated by the writer, which an open handle blocks
      // on Windows, and another job may cache a fresh reader while this one
      // waits for the lock (3b QA m3).
      lock: (key, fn) =>
        withProjectLock(key, () => {
          closeGraphReaders(slug);
          return fn();
        }),
      lockKey: graphLockKey(slug),
      signal,
      onProgress: (p) => report?.({ current: p.current, total: p.total, label: PHASE_LABEL[p.phase], phase: 'scan' })
    });
    log.info(
      {
        mode: result.mode,
        files: result.files,
        edges: result.edges,
        unresolved: result.unresolved,
        filesChanged: result.filesChanged ?? null,
        rebuildReason: result.rebuildReason ?? null,
        durationMs: result.durationMs
      },
      `graph ${result.mode} build done — ${result.files} files, ${result.edges} edges in ${result.durationMs} ms`
    );
    if (result.diagnostics.length > 0) {
      // Unreadable dirs/configs mean the graph under-reports; core has no logger, so say it here (3a QA m5).
      log.warn(
        { diagnostics: result.diagnostics.slice(0, 20), total: result.diagnostics.length },
        `graph build skipped ${result.diagnostics.length} unreadable path(s), first: ${result.diagnostics[0]!.path} (${result.diagnostics[0]!.code})`
      );
    }
    return result;
  } catch (err) {
    if (isAbort(err, signal)) {
      log.info({}, 'graph build aborted — previous graph left unchanged');
    } else {
      log.error({ err: (err as Error).message, name: (err as Error).name }, `graph build failed: ${(err as Error).message}`);
    }
    throw err;
  } finally {
    // The next getGraphReader() opens a fresh handle on the committed graph.
    closeGraphReaders(slug);
  }
}
