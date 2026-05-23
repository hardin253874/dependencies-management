/**
 * Canonical writer for `project.json` (spec §8.4, §10.1 Phase 2).
 *
 * The Phase 2 scan fans out into many async fetches (registry + CVE) that each
 * want to update one or more dep badges on `project.json`. If they all wrote
 * the file independently, last-write-wins would lose updates and concurrent
 * writers would race.
 *
 * This module holds a per-project in-memory representation, lets callers patch
 * individual dep badges, and **batches** writes onto a single atomic
 * temp-then-rename via a debounced flush. The semantics callers care about:
 *   - `read()` returns the current in-memory state (or hydrates from disk).
 *   - `patchBadges(name, badges)` updates an entry in the in-memory state and
 *     schedules a flush.
 *   - `flush()` forces an immediate write; called at the end of the scan or
 *     when the caller wants visibility from another process.
 *
 * Multiple callers sharing the same slug share the same writer instance, so
 * concurrent patches across all the fan-out paths collapse into a single
 * temp file.
 *
 * Drain semantics (v0.4 — replaces the previous recursive forceFlush):
 *   - At most ONE write-loop is in flight per slug. While it runs, it
 *     repeatedly snapshots the current state and writes until `state.dirty`
 *     is false at end-of-write.
 *   - Concurrent `forceFlush` callers await the in-flight loop. After it
 *     completes, they each re-check `state.dirty` and either start a new
 *     loop or return.
 *
 * Why this design: the previous version used `state.writing.then(...)` to
 * chain writes, with the callback recursing into `forceFlush` when more
 * patches landed mid-write. The recursive call observed `state.writing`
 * pointing at the very promise it was running inside, so
 * `state.writing.then(...)` created a self-referential chain that could
 * never resolve — a deadlock that manifests reliably on hot scan loops
 * (200+ patchBadges calls in one JS tick). Replacing the recursion with a
 * `while (state.dirty)` loop inside a single owned promise removes the
 * self-reference entirely.
 *
 * Why `globalThis`: Next.js dev mode evaluates this module per-route bundle.
 * A module-scoped `const STATES = new Map()` means POST /scan, POST /refresh,
 * and the canonical-writer-using endpoints each get their own map; concurrent
 * writes to the same `project.json` then race because they can't see each
 * other's in-flight chain. Pinning the registry on `globalThis` keeps a
 * single map per Node process. Same pattern as `csrf.ts`, `queue.ts`,
 * `logger.ts`.
 */
import path from 'path';
import { promises as fs } from 'fs';
import { atomicWriteJson, readJson, pathExists } from './atomic';
import { projectJsonPath } from '../paths';
import { getLoggerSync } from '../logger';
import type { ProjectJson, ProjectDependency } from '../projects/add';

const FLUSH_DELAY_MS = 50;

interface WriterState {
  json: ProjectJson;
  dirty: boolean;
  flushTimer: NodeJS.Timeout | null;
  /**
   * Currently-running drain loop, or `null` when idle. Concurrent flush
   * callers see this and `await` it before deciding whether to start a new
   * loop themselves.
   */
  writing: Promise<void> | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __DEP_AGENT_CANONICAL_STATES__: Map<string, WriterState> | undefined;
}

function getStates(): Map<string, WriterState> {
  if (globalThis.__DEP_AGENT_CANONICAL_STATES__ === undefined) {
    globalThis.__DEP_AGENT_CANONICAL_STATES__ = new Map<string, WriterState>();
  }
  return globalThis.__DEP_AGENT_CANONICAL_STATES__;
}

export async function getCanonicalWriter(slug: string): Promise<CanonicalWriter> {
  const STATES = getStates();
  let state = STATES.get(slug);
  if (state === undefined) {
    const fp = projectJsonPath(slug);
    if (!(await pathExists(fp))) {
      throw new Error(`Canonical writer requires existing project.json at ${fp}`);
    }
    const json = await readJson<ProjectJson>(fp);
    state = {
      json,
      dirty: false,
      flushTimer: null,
      writing: null
    };
    STATES.set(slug, state);
  }
  return makeWriter(slug, state);
}

function makeWriter(slug: string, state: WriterState): CanonicalWriter {
  return {
    read: () => structuredClone(state.json),
    patchBadges: (name, badges) => {
      const dep = state.json.dependencies.find((d) => d.name === name);
      if (dep === undefined) return false;
      dep.badges = { ...dep.badges, ...badges, lastScannedAt: new Date().toISOString() };
      state.dirty = true;
      scheduleFlush(slug, state);
      return true;
    },
    patchTopLevel: (patch) => {
      Object.assign(state.json, patch);
      state.dirty = true;
      scheduleFlush(slug, state);
    },
    flush: () => forceFlush(slug, state)
  };
}

export interface BadgePatch {
  outdatedSeverity?: ProjectDependency['badges']['outdatedSeverity'];
  hasCve?: ProjectDependency['badges']['hasCve'];
  deprecated?: ProjectDependency['badges']['deprecated'];
}

export interface CanonicalWriter {
  /** Snapshot of the current in-memory state. */
  read: () => ProjectJson;
  /** Update one dep's badges (lastScannedAt auto-updated). Returns false if not found. */
  patchBadges: (name: string, badges: BadgePatch) => boolean;
  /** Patch top-level fields (e.g. legacyPeerDeps after a resolver run). */
  patchTopLevel: (patch: Partial<ProjectJson>) => void;
  /** Force an immediate flush. Awaits pending writes. */
  flush: () => Promise<void>;
}

function scheduleFlush(slug: string, state: WriterState): void {
  if (state.flushTimer !== null) return;
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null;
    void forceFlush(slug, state);
  }, FLUSH_DELAY_MS);
}

/**
 * Drain-loop flush. Returns when `state.dirty` is false AND no other drain
 * loop is in flight.
 *
 *   1. Cancel the pending debounce timer (we're flushing now).
 *   2. If a drain loop is already running, await it — when it finishes
 *      `state.writing` is null and the loop's exit condition matches our
 *      pre-condition. Re-check `state.dirty`; if false we're done.
 *   3. Otherwise, claim the lock by setting `state.writing` to a new drain
 *      loop that snapshots+writes in a while loop until `state.dirty`
 *      drops to false at end-of-write.
 */
async function forceFlush(slug: string, state: WriterState): Promise<void> {
  if (state.flushTimer !== null) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  // Coalesce: drain any in-flight loop first. Loop because between an
  // `await state.writing` resolving and our next `if (!state.dirty)` check,
  // ANOTHER caller might have started a new drain loop — we re-await that
  // too. Bounded in practice by the number of concurrent flush callers.
  while (state.writing !== null) {
    try {
      await state.writing;
    } catch {
      // A prior drain failed (likely EPERM after retries). Don't propagate
      // — let this caller's own attempt surface its own error if it fails.
      break;
    }
  }
  if (!state.dirty) return;

  // Claim the lock. `state.writing` is set to the drain promise BEFORE the
  // first await inside the IIFE (JS executes the async function body
  // synchronously up to the first await), so a concurrent caller entering
  // the while-loop above will observe it correctly.
  const log = getLoggerSync()?.child({ scope: 'canonicalWriter', slug });
  const startedAt = Date.now();
  let writesIssued = 0;

  state.writing = (async () => {
    while (state.dirty) {
      const snapshot = structuredClone(state.json);
      state.dirty = false;
      writesIssued += 1;
      const writeStartedAt = Date.now();
      await atomicWriteJson(projectJsonPath(slug), snapshot);
      log?.debug(
        {
          writeIndex: writesIssued,
          durationMs: Date.now() - writeStartedAt,
          depsCount: snapshot.dependencies.length
        },
        `canonicalWriter write #${writesIssued} done`
      );
      // Loop condition re-checks state.dirty: if more patches landed during
      // the await, we drain them in this same loop iteration. No recursion.
    }
  })();

  try {
    await state.writing;
    log?.debug(
      { writesIssued, totalMs: Date.now() - startedAt },
      `canonicalWriter drain complete (${writesIssued} write${writesIssued === 1 ? '' : 's'})`
    );
  } finally {
    state.writing = null;
  }
}

/**
 * Test-only: drop cached writers for a slug. Useful when a sandbox tears down
 * and a fresh project.json is created at the same path.
 */
export function resetCanonicalWriter(slug?: string): void {
  const STATES = getStates();
  if (slug === undefined) STATES.clear();
  else STATES.delete(slug);
}

/**
 * Re-read project.json from disk. Useful when an out-of-band writer (e.g. the
 * refresh endpoint) has replaced the file and the in-memory state is stale.
 */
export async function reloadCanonicalWriter(slug: string): Promise<void> {
  const STATES = getStates();
  const state = STATES.get(slug);
  if (state === undefined) return;
  const fp = projectJsonPath(slug);
  if (!(await pathExists(fp))) {
    STATES.delete(slug);
    return;
  }
  state.json = await readJson<ProjectJson>(fp);
  state.dirty = false;
}

// structuredClone polyfill safety check for older Node versions.
const _structuredCloneCheck: typeof structuredClone | undefined = (globalThis as { structuredClone?: typeof structuredClone }).structuredClone;
if (_structuredCloneCheck === undefined) {
  (globalThis as { structuredClone: typeof structuredClone }).structuredClone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
}

// Suppress noisy lint for unused fs (kept for potential future use).
void fs;
void path;
