/**
 * Graph predictor (V2_STAGE3_SPEC 3b-B.2): builds the v2 code graph for each
 * projectDir of a case and answers "files that use package X" from it.
 *
 * - DB location: `<cache>/_graph/<caseId>/<projectDirSlug>.db`, outside the
 *   clone (`<cache>/<caseId>`). Core refuses a dbPath inside the project
 *   (`GraphPathError`); this module also refuses one inside the clone.
 * - Always a full build with a trivial lock: the eval is the only writer.
 * - Read-only use of `src/core/graph` (build + query); the one raw SQL read
 *   below only labels direct hits by edge kind/alias for the scorer.
 */
import path from 'path';
// Relative imports on purpose (not `@/…`): see predict-v1.ts (R1).
import { buildGraph, type GraphLock } from '../../src/core/graph/build';
import { filesUsingPackage, unresolved } from '../../src/core/graph/query';
import { openGraphReader, type GraphDriver } from '../../src/core/graph/store';
import type { UnresolvedSummary } from '../../src/core/graph/types';
import { packageNameOf } from './graph-truth';
import { normalizeRepoPath } from './truth';
import type { CasePrediction, CorpusCase } from './types';

export const GRAPH_JS_EXTS: readonly string[] = Object.freeze(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts']);

/**
 * Edge kinds TypeScript's `preProcessFile` can see; config-ref is invisible to the truth.
 * `module-augmentation` (Stage 3c F4) is listed because preProcessFile reports
 * augmentations in `importedFiles`; a hit through it is an ordinary direct hit (D22).
 */
const TS_VISIBLE_KINDS: ReadonlySet<string> = new Set([
  'static',
  'require',
  'dynamic-literal',
  'type-only',
  'side-effect',
  'export-from',
  'module-augmentation'
]);

const trivialLock: GraphLock = (_key, fn) => fn();

export interface PackageGraphHits {
  /** JS/TS files with a direct edge TypeScript can see (no bundler alias, no config-ref). */
  direct: string[];
  /** JS/TS files that reach the package through a re-export chain. */
  reexport: string[];
  /** Wrapper hits (all file kinds; reported, never scored). */
  wrapper: string[];
  /** Direct JS/TS hits whose every edge to the package went through a bundler alias. */
  aliasOnly: string[];
  /** Direct JS/TS hits that exist only as config references. */
  configRefOnly: string[];
  /** Direct hits in style/config-data files (all kinds; for the impact predictor). */
  nonJs: string[];
  /** The graph knows this name as an npm/yarn workspace of the project (resolved to project files). */
  isWorkspace: boolean;
}

export interface ProjectDirGraph {
  projectDir: string;
  files: number;
  buildMs: number;
  unresolved: UnresolvedSummary;
  /** Most frequent unresolved specifiers (reason, specifier, count), max 15. */
  topUnresolved: Array<{ reason: string; specifier: string; count: number }>;
  packages: Record<string, PackageGraphHits>;
}

export class GraphDbPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphDbPathError';
  }
}

export function projectDirSlug(projectDir: string): string {
  const norm = normalizeRepoPath(projectDir).replace(/\/+$/, '');
  return norm === '' || norm === '.' ? 'root' : norm.replace(/[^A-Za-z0-9._-]+/g, '__');
}

export function graphDbPath(cacheDir: string, caseId: string, projectDir: string): string {
  return path.join(cacheDir, '_graph', caseId, `${projectDirSlug(projectDir)}.db`);
}

function isSameOrInside(child: string, parent: string): boolean {
  const key = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const rel = path.relative(key(parent), key(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isJsPath(p: string): boolean {
  return GRAPH_JS_EXTS.includes(path.posix.extname(p.toLowerCase()));
}

interface EdgeFacts {
  visible: boolean;
  alias: boolean;
  configRef: boolean;
}

/** Per file: what kinds of edges point at `pkg` (labels direct hits for scoring). */
function edgeFactsByFile(db: GraphDriver, pkg: string): Map<string, EdgeFacts> {
  const out = new Map<string, EdgeFacts>();
  const rows = db
    .prepare(
      `SELECT f.path AS path, e.kind AS kind, e.alias AS alias, e.specifier AS specifier
         FROM import_edge e JOIN file f ON f.id = e.from_file JOIN package p ON p.id = e.to_package
        WHERE p.name = ?`
    )
    .all(pkg);
  for (const r of rows) {
    const p = String(r.path);
    const kind = String(r.kind);
    // An alias only hides the package from TS when it rewrites to a DIFFERENT
    // name (`@ui` -> antd); `react` -> node_modules/react is still visible.
    const hasAlias = r.alias !== null && r.alias !== undefined && packageNameOf(String(r.specifier)) !== pkg;
    const cur = out.get(p) ?? { visible: false, alias: false, configRef: false };
    if (kind === 'config-ref') cur.configRef = true;
    else if (hasAlias) cur.alias = true;
    else if (TS_VISIBLE_KINDS.has(kind)) cur.visible = true;
    out.set(p, cur);
  }
  return out;
}

function topUnresolved(db: GraphDriver): ProjectDirGraph['topUnresolved'] {
  return db
    .prepare(
      `SELECT unresolved_reason AS reason, specifier, count(*) AS n FROM import_edge
        WHERE resolution = 'unresolved' GROUP BY unresolved_reason, specifier
        ORDER BY n DESC, specifier LIMIT 15`
    )
    .all()
    .map((r) => ({ reason: String(r.reason), specifier: String(r.specifier), count: Number(r.n) }));
}

export function hitsForPackage(db: GraphDriver, pkg: string): PackageGraphHits {
  const hits = filesUsingPackage(db, pkg, { transitive: true, wrapperDepth: 1 });
  const facts = edgeFactsByFile(db, pkg);
  const ws = db.prepare('SELECT is_workspace FROM package WHERE name = ?').get(pkg);
  const out: PackageGraphHits = {
    direct: [],
    reexport: [],
    wrapper: [],
    aliasOnly: [],
    configRefOnly: [],
    nonJs: [],
    isWorkspace: ws !== undefined && Number(ws.is_workspace) === 1
  };
  for (const h of hits) {
    if (h.via === 'wrapper') {
      out.wrapper.push(h.path);
      continue;
    }
    if (!isJsPath(h.path)) {
      if (h.via === 'direct') out.nonJs.push(h.path);
      continue;
    }
    if (h.via === 'reexport') {
      out.reexport.push(h.path);
      continue;
    }
    const f = facts.get(h.path);
    if (f === undefined || f.visible) out.direct.push(h.path);
    else if (f.alias) out.aliasOnly.push(h.path);
    else if (f.configRef) out.configRefOnly.push(h.path);
    else out.direct.push(h.path);
  }
  return out;
}

export interface GraphForCaseOptions {
  cacheDir: string;
  cloneDir: string;
  caseId: string;
  projectDirs: readonly string[];
  /** Packages to query per projectDir. */
  packagesFor(projectDir: string): readonly string[];
  /** Injected for tests; defaults to core `buildGraph`. */
  build?: typeof buildGraph;
}

export async function graphForProjectDir(opts: GraphForCaseOptions, projectDir: string): Promise<ProjectDirGraph> {
  const projectRoot = path.join(opts.cloneDir, projectDir);
  const dbPath = graphDbPath(opts.cacheDir, opts.caseId, projectDir);
  if (isSameOrInside(dbPath, opts.cloneDir)) {
    throw new GraphDbPathError(`graph DB for ${opts.caseId} would lie inside the clone; refusing`);
  }
  const started = Date.now();
  const result = await (opts.build ?? buildGraph)({ projectRoot, dbPath, mode: 'full', lock: trivialLock });
  const buildMs = Date.now() - started;
  const db = openGraphReader(dbPath);
  try {
    const packages: Record<string, PackageGraphHits> = {};
    for (const pkg of [...new Set(opts.packagesFor(projectDir))].sort()) packages[pkg] = hitsForPackage(db, pkg);
    return {
      projectDir,
      files: result.files,
      buildMs,
      unresolved: unresolved(db, { limit: 0 }).summary,
      topUnresolved: topUnresolved(db),
      packages
    };
  } finally {
    db.close();
  }
}

export async function graphForCase(opts: GraphForCaseOptions): Promise<ProjectDirGraph[]> {
  const out: ProjectDirGraph[] = [];
  for (const projectDir of opts.projectDirs) out.push(await graphForProjectDir(opts, projectDir));
  return out;
}

export function prefixed(projectDir: string, rel: string): string {
  const dir = normalizeRepoPath(projectDir).replace(/\/+$/, '');
  return normalizeRepoPath(dir === '' || dir === '.' ? rel : `${dir}/${rel}`);
}

/**
 * `run --predictor v2-graph`: a phase's predicted set is every file the graph
 * links to the phase's packages (direct, reexport, wrapper, alias, config-ref,
 * style/config files), prefixed with the projectDir, same shape as predictV1.
 */
export async function predictV2Graph(
  c: Pick<CorpusCase, 'id' | 'projectDirs' | 'phases'>,
  cloneDir: string,
  cacheDir: string,
  build?: typeof buildGraph
): Promise<CasePrediction> {
  const started = Date.now();
  const names = [...new Set(c.phases.flatMap((p) => p.packages.map((x) => x.name)))];
  const graphs = await graphForCase({
    cacheDir,
    cloneDir,
    caseId: c.id,
    projectDirs: c.projectDirs,
    packagesFor: () => names,
    ...(build !== undefined ? { build } : {})
  });
  const byPhase = new Map<string, string[]>();
  for (const phase of c.phases) {
    const union = new Set<string>();
    for (const g of graphs) {
      for (const pkg of phase.packages) {
        const h = g.packages[pkg.name];
        if (h === undefined) continue;
        for (const p of [...h.direct, ...h.reexport, ...h.wrapper, ...h.aliasOnly, ...h.configRefOnly, ...h.nonJs]) {
          union.add(prefixed(g.projectDir, p));
        }
      }
    }
    byPhase.set(phase.id, [...union].sort());
  }
  return { filesScanned: graphs.reduce((s, g) => s + g.files, 0), durationMs: Date.now() - started, byPhase };
}
