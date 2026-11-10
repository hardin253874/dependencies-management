/**
 * Open graph reader handles, one per project slug (V2_STAGE3_SPEC 3b-A.1).
 *
 * Lives on `globalThis` (CLAUDE.md invariant #4): webpack dev evaluates this
 * module once per route bundle, and a module-scoped Map would let one route
 * close a handle that another route's copy still thinks is open, or leave a
 * handle open that blocks `fs.rm(library/<slug>)` on Windows.
 *
 * Callers use a handle synchronously (node:sqlite is sync) and never keep it
 * across an `await`; `closeGraphReaders` may close it at any await point.
 */
import { graphDbPath } from '@/lib/paths';
import { GraphNotBuiltError, openGraphReader, type GraphDriver } from '@/core/graph/store';

interface CachedReader {
  handle: GraphDriver;
  /** `meta.builtAt` when the handle was opened; a newer build reopens it. */
  builtAt: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __DEP_AGENT_GRAPH_READERS__: Map<string, CachedReader> | undefined;
}

function readers(): Map<string, CachedReader> {
  if (globalThis.__DEP_AGENT_GRAPH_READERS__ === undefined) {
    globalThis.__DEP_AGENT_GRAPH_READERS__ = new Map<string, CachedReader>();
  }
  return globalThis.__DEP_AGENT_GRAPH_READERS__;
}

/** `meta.builtAt`, or null when the DB has tables but no completed build. */
function builtAtOf(handle: GraphDriver): string | null {
  try {
    const row = handle.prepare("SELECT value FROM meta WHERE key = 'builtAt'").get();
    return row === undefined || row.value === null ? null : String(row.value);
  } catch {
    // No meta table at all: the file exists but was never initialised.
    return null;
  }
}

function closeQuietly(handle: GraphDriver): void {
  try {
    handle.close();
  } catch {
    // Already closed (e.g. after a failed open path); nothing left to release.
  }
}

/**
 * A reader for the project's current graph. Throws `GraphNotBuiltError` when
 * there is no DB or no completed build in it: a failed or aborted first build
 * leaves an empty but openable `graph.db` (3a QA m1), and answering "no files
 * use X" from it would be a silent lie.
 */
export function getGraphReader(slug: string): GraphDriver {
  const map = readers();
  const cached = map.get(slug);
  if (cached !== undefined) {
    // WAL readers see the latest committed data on each new statement, so this
    // also notices a rebuild committed by a writer since the handle was opened.
    const current = builtAtOf(cached.handle);
    if (current !== null && current === cached.builtAt) return cached.handle;
    map.delete(slug);
    closeQuietly(cached.handle);
  }
  const dbPath = graphDbPath(slug);
  const handle = openGraphReader(dbPath);
  const builtAt = builtAtOf(handle);
  if (builtAt === null) {
    closeQuietly(handle);
    throw new GraphNotBuiltError(dbPath);
  }
  map.set(slug, { handle, builtAt });
  return handle;
}

/** Closes and forgets the slug's reader so the DB file can be deleted or rebuilt. */
export function closeGraphReaders(slug: string): void {
  const map = readers();
  const cached = map.get(slug);
  if (cached === undefined) return;
  map.delete(slug);
  closeQuietly(cached.handle);
}

/** Test helper: number of slugs holding an open reader. */
export function _openGraphReaderCount(): number {
  return readers().size;
}
