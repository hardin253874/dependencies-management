/**
 * Public types of the code graph (V2_STAGE3_SPEC §2, 3a.9). No Next/React
 * types here: this file is shared by the web app, the eval runner and
 * (Stage 4) the MCP server.
 */

/** Same values as `UsageCategory` in src/lib/api-types.ts (kept structural to avoid a lib import). */
export type FileCategory = 'prod' | 'test' | 'story' | 'config';

export type FileKind = 'js' | 'style' | 'config';

export type FileRole =
  | 'page'
  | 'layout'
  | 'route'
  | 'template'
  | 'loading'
  | 'error'
  | 'not-found'
  | 'default'
  | 'api-route'
  | 'middleware'
  | 'entry';

export type SkipReason = 'oversized' | 'minified';

export type EdgeKind =
  | 'static'
  | 'require'
  | 'dynamic-literal'
  | 'dynamic-expr'
  | 'type-only'
  | 'side-effect'
  | 'export-from'
  | 'style-import'
  | 'config-ref';

export type Resolution = 'resolved' | 'external' | 'builtin' | 'unresolved';

export type Confidence = 'high' | 'medium' | 'low';

export type UnresolvedReason =
  | 'dynamic-expression'
  | 'not-found'
  | 'alias-unreadable'
  | 'outside-root'
  | 'parse-error'
  | 'interpolated-style';

export type UsageKind = 'call' | 'new' | 'member' | 'jsx' | 'value';

export type Via = 'direct' | 'reexport' | 'wrapper';

export const CONFIDENCE_RANK: Readonly<Record<Confidence, number>> = Object.freeze({ low: 1, medium: 2, high: 3 });

export function minConfidence(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b;
}

export function confidenceFromRank(rank: number): Confidence {
  if (rank >= 3) return 'high';
  if (rank === 2) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------- query API

export interface FileHit {
  path: string;
  category: FileCategory;
  role: FileRole | null;
  via: Via;
  /** 0 for direct, re-export hop count for reexport, wrapper distance for wrapper. */
  depth: number;
  /** For wrapper hits: the chain of wrapper files from the hit towards the package. Empty otherwise. */
  viaPath: string[];
  confidence: Confidence;
}

export interface FilesUsingPackageOptions {
  /** Include reexport + wrapper hits (default true). */
  transitive?: boolean;
  /** Wrapper distance to follow; 0 disables wrapper hits (default 1). */
  wrapperDepth?: number;
  categories?: FileCategory[];
  /**
   * Restrict direct hits to these edge kinds; wrapper hits then only count
   * through a kind-matching direct file. Re-export hits are not filtered.
   */
  kinds?: EdgeKind[];
}

export interface SymbolUse {
  symbol: string;
  member: string | null;
  count: number;
}

export interface UsageSite {
  path: string;
  line: number;
  col: number;
  kind: UsageKind;
  symbol: string;
  member: string | null;
  snippet: string;
  confidence: Confidence;
}

export interface DependentHit {
  path: string;
  category: FileCategory;
  role: FileRole | null;
  depth: number;
}

export interface EntryPoint {
  path: string;
  role: FileRole;
  depth: number;
}

export interface UnresolvedImport {
  path: string;
  line: number;
  specifier: string;
  kind: EdgeKind;
  reason: UnresolvedReason;
  snippet: string;
}

export interface UnresolvedSummary {
  totalEdges: number;
  unresolved: number;
  /** unresolved / totalEdges (0 when there are no edges). */
  pct: number;
  byReason: Partial<Record<UnresolvedReason, number>>;
}

export interface GraphInfo {
  meta: Record<string, string>;
  counts: {
    files: number;
    packages: number;
    edges: number;
    unresolved: number;
    usages: number;
    reach: number;
  };
}

export interface Page {
  limit?: number;
  offset?: number;
}
