/**
 * v1 predictor: the existing deterministic code scan, no LLM.
 *
 * One scan per projectDir per case, at the base checkout — that is all the
 * agent sees before the upgrade, so every phase is predicted from it. A
 * phase's predicted set is the union of import sites (all categories) of
 * the phase's packages, prefixed with the projectDir.
 */
// Relative import on purpose (not `@/…`): the eval runner must not depend
// on the runner tool's alias support, which may change in Stage 1 (R1).
import { scanCode, type CodeScanResult } from '../../src/lib/scanners/code';
import path from 'path';
import { normalizeRepoPath } from './truth';
import type { CasePrediction, CorpusCase } from './types';

export type ScanFn = (opts: { projectRoot: string }) => Promise<CodeScanResult>;

function prefixed(projectDir: string, rel: string): string {
  const dir = normalizeRepoPath(projectDir).replace(/\/+$/, '');
  return normalizeRepoPath(dir === '' || dir === '.' ? rel : `${dir}/${rel}`);
}

export async function predictV1(
  c: Pick<CorpusCase, 'projectDirs' | 'phases'>,
  cloneDir: string,
  scan: ScanFn = scanCode
): Promise<CasePrediction> {
  const started = Date.now();
  const sitesByPackage = new Map<string, Set<string>>();
  let filesScanned = 0;

  for (const projectDir of c.projectDirs) {
    const result = await scan({ projectRoot: path.join(cloneDir, projectDir) });
    filesScanned += result.totalFilesScanned;
    for (const [pkg, sites] of result.imports) {
      let set = sitesByPackage.get(pkg);
      if (set === undefined) {
        set = new Set();
        sitesByPackage.set(pkg, set);
      }
      for (const site of sites) set.add(prefixed(projectDir, site.path));
    }
  }

  const byPhase = new Map<string, string[]>();
  for (const phase of c.phases) {
    const union = new Set<string>();
    for (const pkg of phase.packages) {
      for (const p of sitesByPackage.get(pkg.name) ?? []) union.add(p);
    }
    byPhase.set(phase.id, Array.from(union).sort());
  }
  return { filesScanned, durationMs: Date.now() - started, byPhase };
}
