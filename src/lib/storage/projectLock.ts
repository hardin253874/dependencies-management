/**
 * Per-project in-process serialization (Stage 3 review M5).
 *
 * The job queue uses `resourceKey` to dedupe identical concurrent jobs, but
 * different `resourceKey`s within the same project (e.g. two refresh-report
 * jobs for different upgrade triples) can still race when they both mutate
 * `project.json`. The atomic-write helper protects against on-disk corruption,
 * but a "first writer wins" race can silently drop one writer's update — e.g.
 * if two refresh jobs both flip `legacyPeerDeps: true`, the second writer
 * overwrites with a fresh read that pre-dated the first writer's flip.
 *
 * `withProjectLock(slug, fn)` serializes the read-modify-write critical section
 * per slug. The lock is an in-memory promise chain, not a filesystem lock; it's
 * sufficient for the single-server-process v1 architecture (§3.3 local-only).
 *
 * Usage:
 *   await withProjectLock(slug, async () => {
 *     const project = await readJson<ProjectJson>(projectJsonPath(slug));
 *     // ... compute changes
 *     await atomicWriteJson(projectJsonPath(slug), updated);
 *   });
 */

// Stash the locks map on `globalThis` (same pattern as queue / csrf /
// logger / orphan cache). Next.js dev evaluates this module per-route
// bundle, so a module-scoped `const locks = new Map()` would mean each
// route handler holds its OWN map — and `withProjectLock(slug, fn)` from
// two different routes wouldn't actually serialize on the same slug,
// defeating the lock's purpose for cross-route `project.json` writes.
declare global {
  // eslint-disable-next-line no-var
  var __DEP_AGENT_PROJECT_LOCKS__: Map<string, Promise<unknown>> | undefined;
}

function getLocksMap(): Map<string, Promise<unknown>> {
  if (globalThis.__DEP_AGENT_PROJECT_LOCKS__ === undefined) {
    globalThis.__DEP_AGENT_PROJECT_LOCKS__ = new Map<string, Promise<unknown>>();
  }
  return globalThis.__DEP_AGENT_PROJECT_LOCKS__;
}

export async function withProjectLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  const locks = getLocksMap();
  // Chain onto any in-flight lock for this slug. We don't reject if the
  // previous holder throws — we propagate its rejection out of fn's promise
  // chain so the next holder runs cleanly.
  const previous = locks.get(slug);
  const next = (previous === undefined ? Promise.resolve() : previous.catch(() => undefined)).then(fn);
  locks.set(slug, next);
  try {
    return await next;
  } finally {
    // If we're the last waiter, clear the map entry to avoid unbounded growth.
    if (locks.get(slug) === next) locks.delete(slug);
  }
}

/** Test helper — assert no slugs hold open locks. */
export function _activeProjectLockCount(): number {
  return getLocksMap().size;
}
