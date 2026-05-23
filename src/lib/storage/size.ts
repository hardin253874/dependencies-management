/**
 * Library disk usage (spec §7.7 Settings → Library, §9.3).
 *
 * Walks `library/<slug>/{deps,versions,usage,reports,deep-reports,file-reviews}/`
 * and sums byte counts per category. Also reports the totals for `_logs/`,
 * `_config.json`, and `_projects.json` so the Settings UI can show a complete
 * size breakdown.
 */
import { promises as fs } from 'fs';
import path from 'path';
import {
  depsDir,
  versionsDir,
  usageDir,
  reportsDir,
  deepReportsDir,
  fileReviewsDir,
  logsDir,
  configFilePath,
  projectsFilePath,
  getLibraryRoot
} from '../paths';
import { readProjects } from './projects';
import { pathExists } from './atomic';
import type { LibrarySizeResponse } from '../api-types';

export async function computeLibrarySize(): Promise<LibrarySizeResponse> {
  const byKind: Record<string, number> = {
    deps: 0,
    versions: 0,
    usage: 0,
    reports: 0,
    'deep-reports': 0,
    'file-reviews': 0,
    logs: 0,
    config: 0
  };

  const reg = await readProjects();
  for (const project of reg.projects) {
    byKind.deps! += await sizeOfTree(depsDir(project.slug));
    byKind.versions! += await sizeOfTree(versionsDir(project.slug));
    byKind.usage! += await sizeOfTree(usageDir(project.slug));
    byKind.reports! += await sizeOfTree(reportsDir(project.slug));
    byKind['deep-reports']! += await sizeOfTree(deepReportsDir(project.slug));
    byKind['file-reviews']! += await sizeOfTree(fileReviewsDir(project.slug));
  }
  byKind.logs! += await sizeOfTree(logsDir());

  if (await pathExists(configFilePath())) {
    byKind.config! += (await fs.stat(configFilePath())).size;
  }
  if (await pathExists(projectsFilePath())) {
    byKind.config! += (await fs.stat(projectsFilePath())).size;
  }

  const total = Object.values(byKind).reduce((sum, n) => sum + n, 0);
  return { totalBytes: total, byKind };
}

async function sizeOfTree(root: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    try {
      if (entry.isDirectory()) {
        total += await sizeOfTree(full);
      } else if (entry.isFile()) {
        const stat = await fs.stat(full);
        total += stat.size;
      }
    } catch {
      // skip — file disappeared between readdir and stat
    }
  }
  return total;
}

// Suppress unused import noise when getLibraryRoot is wired in tests.
void getLibraryRoot;
