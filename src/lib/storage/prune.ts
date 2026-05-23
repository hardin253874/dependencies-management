/**
 * Cache pruning (spec §7.7 Settings → Cache, §9.3).
 *
 * Walks `library/<slug>/{deps,versions,usage,reports,deep-reports,file-reviews}/`
 * and deletes envelope files whose `generatedAt` is older than the requested
 * threshold. Dry-run mode reports counts only.
 *
 * Per-category counts surface in the response so the UI can render a useful
 * preview ("12 reports, 4 deep reports").
 */
import { promises as fs } from 'fs';
import path from 'path';
import { readJson } from './atomic';
import {
  depsDir,
  versionsDir,
  usageDir,
  reportsDir,
  deepReportsDir,
  fileReviewsDir
} from '../paths';
import { readProjects } from './projects';
import type { CachePruneResponse, PruneCount, PruneKind } from '../api-types';

interface MinEnvelope {
  generatedAt?: string;
  ttlHours?: number | null;
}

const KINDS: { kind: PruneKind; dir: (slug: string) => string }[] = [
  { kind: 'deps', dir: depsDir },
  { kind: 'versions', dir: versionsDir },
  { kind: 'usage', dir: usageDir },
  { kind: 'reports', dir: reportsDir },
  { kind: 'deep-reports', dir: deepReportsDir },
  { kind: 'file-reviews', dir: fileReviewsDir }
];

export interface PruneOptions {
  olderThanDays: number;
  dryRun: boolean;
}

export async function pruneCache(opts: PruneOptions): Promise<CachePruneResponse> {
  const cutoffMs = Date.now() - opts.olderThanDays * 86_400_000;
  const result: CachePruneResponse = {
    dryRun: opts.dryRun,
    olderThanDays: opts.olderThanDays,
    pruned: { files: 0, bytes: 0 },
    byKind: {
      deps: { files: 0, bytes: 0 },
      versions: { files: 0, bytes: 0 },
      usage: { files: 0, bytes: 0 },
      reports: { files: 0, bytes: 0 },
      'deep-reports': { files: 0, bytes: 0 },
      'file-reviews': { files: 0, bytes: 0 }
    }
  };

  const reg = await readProjects();
  for (const project of reg.projects) {
    for (const { kind, dir } of KINDS) {
      const root = dir(project.slug);
      await walkAndPrune(root, cutoffMs, opts.dryRun, result.byKind[kind]);
    }
  }
  for (const counts of Object.values(result.byKind)) {
    result.pruned.files += counts.files;
    result.pruned.bytes += counts.bytes;
  }
  return result;
}

async function walkAndPrune(
  root: string,
  cutoffMs: number,
  dryRun: boolean,
  counts: PruneCount
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walkAndPrune(full, cutoffMs, dryRun, counts);
      continue;
    }
    if (!entry.isFile() || !full.endsWith('.json')) continue;
    let envelope: MinEnvelope;
    try {
      envelope = await readJson<MinEnvelope>(full);
    } catch {
      continue;
    }
    const generated = envelope.generatedAt;
    if (typeof generated !== 'string') continue;
    const ts = Date.parse(generated);
    if (Number.isNaN(ts) || ts > cutoffMs) continue;

    let size = 0;
    try {
      const stat = await fs.stat(full);
      size = stat.size;
    } catch {
      // ignore — file may have been deleted between read and stat
    }
    counts.files += 1;
    counts.bytes += size;
    if (!dryRun) {
      await fs.unlink(full).catch(() => undefined);
    }
  }
}
