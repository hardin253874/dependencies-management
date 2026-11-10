/**
 * Deterministic facts for the agent seed prompt and for checking what the
 * agent reports (V2_STAGE4_SPEC 4a.9, §2 eval predicted set). Pure functions
 * over a graph reader; shared by the app services and the eval predictor.
 */
import path from 'path';
import { filesUsingPackage, graphInfo } from '../graph/query';
import type { ApiDiffResult } from '../intel/apiDiff';
import { graphFileSet } from './pathGuard';
import type { GraphDriver } from '../graph/store';
import type { ImpactBaseItem } from './impactBase';

const API_DIFF_NAMES_IN_SEED = 30;

export function graphSummaryLines(graph: GraphDriver): string[] {
  const info = graphInfo(graph);
  const pct = info.counts.edges === 0 ? 0 : Math.round((info.counts.unresolved / info.counts.edges) * 1000) / 10;
  return [
    `files: ${info.counts.files}, packages: ${info.counts.packages}, import edges: ${info.counts.edges}`,
    `unresolved imports: ${info.counts.unresolved} (${pct}% of edges)`,
    `graph built at: ${info.meta.builtAt ?? 'unknown'}`
  ];
}

/** One line per package: file counts by via and by category. */
export function usageLines(graph: GraphDriver, packages: readonly string[]): string[] {
  return packages.map((pkg) => {
    const hits = filesUsingPackage(graph, pkg);
    if (hits.length === 0) return `${pkg}: no file in the graph uses it`;
    const count = (key: 'via' | 'category') => {
      const m = new Map<string, number>();
      for (const h of hits) m.set(h[key], (m.get(h[key]) ?? 0) + 1);
      return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, n]) => `${k} ${n}`).join(', ');
    };
    return `${pkg}: ${hits.length} files (${count('via')}; ${count('category')})`;
  });
}

function countsBy(items: readonly ImpactBaseItem[], key: 'via' | 'kind', order: readonly string[]): string {
  const m = new Map<string, number>();
  for (const it of items) m.set(it[key], (m.get(it[key]) ?? 0) + 1);
  return order.filter((k) => m.has(k)).map((k) => `${k} ${m.get(k)}`).join(', ');
}

/**
 * Base impacted set for the seed (5a.4): counts only, never the file list
 * (superset has 1,352 files). First line = totals by via and kind, then one
 * line per package in the given order.
 */
export function impactBaseLines(base: readonly ImpactBaseItem[], packages: readonly string[]): string[] {
  const via = ['direct', 'reexport', 'wrapper'];
  const kind = ['js', 'style', 'config'];
  if (base.length === 0) return ['0 files: the graph links no file to these packages'];
  const total = `${base.length} files (${countsBy(base, 'via', via)}; ${countsBy(base, 'kind', kind)})`;
  const perPkg = [...new Set(packages)].map((pkg) => {
    const mine = base.filter((b) => b.packages.includes(pkg));
    return mine.length === 0 ? `${pkg}: 0 files` : `${pkg}: ${mine.length} files (${countsBy(mine, 'via', via)}; ${countsBy(mine, 'kind', kind)})`;
  });
  return [total, ...perPkg];
}

export function apiDiffSeedLines(diff: ApiDiffResult | null): string[] {
  if (diff === null || diff.status !== 'ok') return [];
  const names = (xs: Array<{ name: string }>) =>
    xs.length === 0 ? 'none' : xs.slice(0, API_DIFF_NAMES_IN_SEED).map((x) => x.name).join(', ') + (xs.length > API_DIFF_NAMES_IN_SEED ? ` (+${xs.length - API_DIFF_NAMES_IN_SEED} more)` : '');
  return [
    `${diff.pkg} ${diff.from} → ${diff.to} (types from ${diff.sources.from.package}@${diff.sources.from.version} / ${diff.sources.to.package}@${diff.sources.to.version})`,
    `removed exports: ${names(diff.removed)}`,
    `signature-changed exports: ${names(diff.signatureChanged)}`,
    `added exports: ${diff.added.length}`,
    'call api_diff for the usage sites of each removed / changed export'
  ];
}

/**
 * A reported path → the graph's POSIX project-relative form, or null when it
 * cannot be one (absolute outside the root, traversal, empty).
 */
export function normalizeReportedPath(raw: string, workspaceRoot: string): string | null {
  let p = raw.trim().replace(/\\/g, '/');
  if (p === '') return null;
  const root = workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '');
  const lower = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  if (lower(p).startsWith(`${lower(root)}/`)) p = p.slice(root.length + 1);
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null;
  const norm = path.posix.normalize(p).replace(/^\.\//, '');
  if (norm === '.' || norm.startsWith('../') || norm === '..') return null;
  return norm;
}

export interface FilteredPaths<T> {
  kept: T[];
  dropped: string[];
}

/** Keeps entries whose normalized path is a graph file (deduped, first wins); the rest are hallucinated paths. */
export function filterToGraphFiles<T extends { path: string }>(entries: readonly T[], graph: GraphDriver, workspaceRoot: string): FilteredPaths<T> {
  const files = graphFileSet(graph);
  const kept: T[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const p = normalizeReportedPath(e.path, workspaceRoot);
    if (p === null || !files.has(p)) {
      dropped.push(e.path);
      continue;
    }
    if (seen.has(p)) continue;
    seen.add(p);
    kept.push({ ...e, path: p });
  }
  return { kept, dropped };
}
