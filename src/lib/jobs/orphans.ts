/**
 * Job journal orphan detection on boot (spec §10.10).
 *
 * On startup, walk `library/<slug>/_jobs/` for every registered project. Any
 * `<jobId>.json` files present at boot are from a previous server process
 * (the queue clears its in-memory state when the process exits and deletes
 * journals on success/error/cancel). These are *orphans*.
 *
 * Orphans are surfaced via `GET /api/jobs` so the UI can show:
 *   "Previous job interrupted — Re-run? / Discard"
 *
 * The journals are NOT automatically deleted; the user dismisses (Discard)
 * via `DELETE /api/jobs/orphans/<jobId>` (Stage 2 endpoint).
 */
import { promises as fs } from 'fs';
import path from 'path';
import { projectJobsDir } from '../paths';
import { readProjects } from '../storage/projects';
import { readJson, pathExists } from '../storage/atomic';
import type { JobOrphan } from '../api-types';
import type { JobRecord } from './types';

// Stash the orphan cache on `globalThis` (same pattern as queue / csrf /
// logger). Next.js dev evaluates this module per-route bundle, so a
// module-scoped `let cached` would mean each route handler keeps its OWN
// orphan cache + scans the FS independently — wasteful but mostly harmless
// here, since orphan detection is read-only. Pinned for consistency with
// the rest of the singletons.
declare global {
  // eslint-disable-next-line no-var
  var __DEP_AGENT_ORPHAN_CACHE__: { value: JobOrphan[]; at: number } | undefined;
}

/** Cache for 5s so the GET /api/jobs poll path doesn't hammer the FS. */
const CACHE_TTL_MS = 5_000;

export async function detectOrphans(force = false): Promise<JobOrphan[]> {
  const now = Date.now();
  const slot = globalThis.__DEP_AGENT_ORPHAN_CACHE__;
  if (!force && slot !== undefined && now - slot.at < CACHE_TTL_MS) {
    return slot.value;
  }
  const reg = await readProjects();
  const orphans: JobOrphan[] = [];
  const detectedAt = new Date().toISOString();
  for (const project of reg.projects) {
    const dir = projectJobsDir(project.slug);
    if (!(await pathExists(dir))) continue;
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const fp = path.join(dir, name);
      try {
        const record = await readJson<JobRecord>(fp);
        orphans.push({
          slug: project.slug,
          jobId: record.jobId,
          kind: record.kind,
          resourceKey: record.resourceKey,
          createdAt: record.createdAt,
          detectedAt
        });
      } catch {
        // Skip corrupt journal entries.
      }
    }
  }
  globalThis.__DEP_AGENT_ORPHAN_CACHE__ = { value: orphans, at: now };
  return orphans;
}

export async function discardOrphan(slug: string, jobId: string): Promise<boolean> {
  const fp = path.join(projectJobsDir(slug), `${jobId}.json`);
  if (!(await pathExists(fp))) return false;
  await fs.unlink(fp).catch(() => undefined);
  // Invalidate the cache so the next list reflects the deletion.
  globalThis.__DEP_AGENT_ORPHAN_CACHE__ = undefined;
  return true;
}

export function resetOrphanCache(): void {
  globalThis.__DEP_AGENT_ORPHAN_CACHE__ = undefined;
}
