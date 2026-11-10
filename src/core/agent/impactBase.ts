/**
 * Base impacted set (v2 Stage 5a.2, V2_STAGE5_SPEC §2): the files the code
 * graph links to a list of packages, by the v2-graph predictor rule — every
 * `filesUsingPackage(…, { transitive: true, wrapperDepth: 1 })` hit except a
 * non-JS file reached through a re-export chain. The [D] report and the eval
 * `v2-agent` predictor start from this set; the agent only ranks, adds and
 * (with read evidence) excludes on top of it.
 *
 * Pure function over a graph reader, no new SQL. `tests/backend/agent/impact-base.test.ts`
 * proves it equals `eval/lib/predict-graph.ts` `predictV2Graph` on fixtures.
 */
import path from 'path';
import { filesUsingPackage } from '../graph/query';
import type { Confidence, FileKind, Via } from '../graph/types';
import type { GraphDriver } from '../graph/store';
import { graphFileSet } from './pathGuard';

/** Same list as `eval/lib/predict-graph.ts` GRAPH_JS_EXTS (the equality test guards drift). */
const JS_EXTS: readonly string[] = Object.freeze(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts']);

const VIA_RANK: Readonly<Record<Via, number>> = Object.freeze({ direct: 0, reexport: 1, wrapper: 2 });
const CONFIDENCE_RANK: Readonly<Record<Confidence, number>> = Object.freeze({ high: 0, medium: 1, low: 2 });

export interface ImpactBaseItem {
  path: string;
  /** Best via over all packages that reach the file. */
  via: Via;
  kind: FileKind;
  /** Graph confidence of the best-via hit (highest on a tie). */
  confidence: Confidence;
  /** Packages (sorted) whose usage set contains the file. */
  packages: string[];
}

function isJsPath(p: string): boolean {
  return JS_EXTS.includes(path.posix.extname(p.toLowerCase()));
}

function kindFromPath(p: string): FileKind {
  if (isJsPath(p)) return 'js';
  return /\.(css|scss|sass|less)$/i.test(p) ? 'style' : 'config';
}

/**
 * The v2-graph rule for one hit. A non-JS file reached via `reexport` is left
 * out (predict-graph drops it too); today's builder never produces one, since
 * only JS/TS files carry re-export bindings, but the rule stays explicit.
 */
export function isBaseHit(hit: { path: string; via: Via }): boolean {
  return !(hit.via === 'reexport' && !isJsPath(hit.path));
}

export function impactBaseSet(graph: GraphDriver, packages: readonly string[]): ImpactBaseItem[] {
  const files = graphFileSet(graph);
  const byPath = new Map<string, ImpactBaseItem>();
  for (const pkg of [...new Set(packages)].sort()) {
    for (const h of filesUsingPackage(graph, pkg, { transitive: true, wrapperDepth: 1 })) {
      if (!isBaseHit(h)) continue;
      const cur = byPath.get(h.path);
      if (cur === undefined) {
        byPath.set(h.path, { path: h.path, via: h.via, kind: files.get(h.path)?.kind ?? kindFromPath(h.path), confidence: h.confidence, packages: [pkg] });
        continue;
      }
      if (!cur.packages.includes(pkg)) cur.packages.push(pkg);
      const better =
        VIA_RANK[h.via] < VIA_RANK[cur.via] || (h.via === cur.via && CONFIDENCE_RANK[h.confidence] < CONFIDENCE_RANK[cur.confidence]);
      if (better) {
        cur.via = h.via;
        cur.confidence = h.confidence;
      }
    }
  }
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** One row of the [D] impacted-file list (structurally the app's `ImpactedFile`, api-types.ts). */
export interface ImpactRow {
  path: string;
  origin: 'graph' | 'agent';
  via?: Via;
  kind: FileKind;
  confidence?: Confidence;
  agent: 'confirmed' | 'added' | 'excluded' | null;
  rank: number | null;
  evidence: string | null;
  brief: string | null;
  estimatedChangeSize: 'small' | 'medium' | 'large' | null;
}

export interface ImpactCounts {
  base: number;
  confirmed: number;
  added: number;
  excluded: number;
  rejectedExclusions: number;
}

export interface ImpactOverlayInput {
  base: readonly ImpactBaseItem[];
  /** The agent's filesToModify, already normalized, deduplicated and filtered to graph files, in the agent's order. */
  ranked: ReadonlyArray<{ path: string; brief: string; estimatedChangeSize: 'small' | 'medium' | 'large' }>;
  /** `excludeFiles` paths, already normalized (null = not a usable path), with evidence. */
  excludes: ReadonlyArray<{ path: string | null; evidence: string }>;
  /** `readPaths` of the run (5a.3). */
  readPaths: readonly string[];
  /** Graph file kinds (for agent-added files). */
  kindOf(path: string): FileKind;
}

/**
 * Agent overlay on the base set (5a.5, spec §2). Order: agent-ranked rows
 * (confirmed and added, by rank), then untouched base rows (path asc), then
 * excluded rows (path asc) — excluded files stay visible with their evidence.
 * An exclusion is valid only for a base file that was read in the run and is
 * not also ranked; every other exclusion is rejected (file kept, counted).
 */
export function impactOverlay(input: ImpactOverlayInput): { rows: ImpactRow[]; counts: ImpactCounts } {
  const baseByPath = new Map(input.base.map((b) => [b.path, b]));
  const read = new Set(input.readPaths);
  const rankedPaths = new Set(input.ranked.map((r) => r.path));
  const excluded = new Map<string, string>();
  let rejectedExclusions = 0;
  for (const e of input.excludes) {
    const ok = e.path !== null && baseByPath.has(e.path) && read.has(e.path) && !rankedPaths.has(e.path);
    if (!ok) {
      rejectedExclusions += 1;
      continue;
    }
    if (!excluded.has(e.path!)) excluded.set(e.path!, e.evidence);
  }

  const graphRow = (b: ImpactBaseItem): ImpactRow => ({
    path: b.path,
    origin: 'graph',
    via: b.via,
    kind: b.kind,
    confidence: b.confidence,
    agent: null,
    rank: null,
    evidence: null,
    brief: null,
    estimatedChangeSize: null
  });
  const rows: ImpactRow[] = [];
  let confirmed = 0;
  let added = 0;
  input.ranked.forEach((r, i) => {
    const b = baseByPath.get(r.path);
    const common = { rank: i + 1, evidence: null, brief: r.brief, estimatedChangeSize: r.estimatedChangeSize };
    if (b !== undefined) {
      confirmed += 1;
      rows.push({ ...graphRow(b), agent: 'confirmed', ...common });
    } else {
      added += 1;
      rows.push({ path: r.path, origin: 'agent', kind: input.kindOf(r.path), agent: 'added', ...common });
    }
  });
  for (const b of input.base) if (!rankedPaths.has(b.path) && !excluded.has(b.path)) rows.push(graphRow(b));
  for (const b of input.base) {
    const evidence = excluded.get(b.path);
    if (evidence !== undefined) rows.push({ ...graphRow(b), agent: 'excluded', evidence });
  }
  return { rows, counts: { base: input.base.length, confirmed, added, excluded: excluded.size, rejectedExclusions } };
}
