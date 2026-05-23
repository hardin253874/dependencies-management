/**
 * Build the `ProjectSummary` shape used by GET /api/projects (left-panel list).
 */
import { promises as fs } from 'fs';
import { readJson, pathExists } from '../storage/atomic';
import { projectJsonPath } from '../paths';
import type { ProjectSummary } from '../api-types';
import type { ProjectRegistryEntry } from '../storage/projects';
import type { ProjectJson } from './add';

export async function buildSummary(entry: ProjectRegistryEntry): Promise<ProjectSummary> {
  let depCount = 0;
  let lastScanAt: string | null = null;
  const fp = projectJsonPath(entry.slug);
  if (await pathExists(fp)) {
    try {
      const pj = await readJson<ProjectJson>(fp);
      depCount = pj.dependencies.length;
      lastScanAt = pj.lastFullScanAt ?? null;
    } catch {
      // corrupt project.json — treat as no scan data yet
    }
  }
  const exists = await targetExists(entry.absolutePath);
  return {
    slug: entry.slug,
    name: entry.name,
    path: entry.absolutePath,
    packageManager: entry.packageManager,
    depCount,
    lastScanAt,
    pathExists: exists,
    orphan: !exists
  };
}

async function targetExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}
