/**
 * App-side application of J2 / J5 to the [D] / [D-Deep] reports (V2_STAGE5_SPEC
 * 5b.11 / 5b.14). Each function takes a judge context (`null` = flag off →
 * returns its input unchanged) and never throws for a Jev reason.
 */
import { coUpgradeJ5, evidenceCheckJ2, renameCandidatesJ4, type JudgeContext } from '@/core/judge/uses';
import type { ApiDiffResult } from '@/core/intel/apiDiff';
import type { SourceSnippet } from '@/core/judge/payload';
import { capSnippet } from '@/core/judge/payload';
import { graphFileSet, normalizeRelPath, pathGuard } from '@/core/agent/pathGuard';
import { getGraphReader } from '@/lib/graph/readerCache';
import { extractImportSiteContext } from '../scanners/importSiteContext';
import type { CoUpgradeOutput } from '../llm/coUpgrade';
import type { CoUpgradeDep, UpdateReportDetail } from '../api-types';

/**
 * J5: adds Jev's "usually upgraded together" suggestions (noul ≥ 0.7) as
 * candidates with source `suggested-jev`. Existing candidates and their
 * semver-derived sources are untouched (hard facts win).
 */
export async function addJevCoUpgrades(
  ctx: JudgeContext | null,
  input: { target: string; from: string; to: string; directDeps: ReadonlyArray<{ name: string; installedVersion: string | null }>; coUpgrade: CoUpgradeOutput }
): Promise<{ coUpgrade: CoUpgradeOutput; suggested: Set<string> }> {
  const suggested = new Set<string>();
  if (ctx === null) return { coUpgrade: input.coUpgrade, suggested };
  const out = await coUpgradeJ5(ctx, { target: input.target, from: input.from, to: input.to, deps: input.directDeps.map((d) => ({ name: d.name, version: d.installedVersion })) });
  if (out === null) return { coUpgrade: input.coUpgrade, suggested };
  const known = new Set(input.coUpgrade.candidates.map((c) => c.name));
  const candidates = [...input.coUpgrade.candidates];
  const sources: Record<string, Array<CoUpgradeOutput['sources'][string][number]>> = { ...input.coUpgrade.sources };
  for (const s of out) {
    if (known.has(s.name)) continue;
    const dep = input.directDeps.find((d) => d.name === s.name);
    candidates.push({ name: s.name, currentVersion: dep?.installedVersion ?? null, declaredPeerDepRange: null });
    sources[s.name] = ['suggested-jev'];
    suggested.add(s.name);
  }
  candidates.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { coUpgrade: { candidates, sources }, suggested };
}

/** Labels the report's co-upgrade rows that only Jev suggested (`reason: 'suggested-jev'`, never required). */
export function markJevCoUpgrades<T extends { coUpgradeDeps: CoUpgradeDep[] }>(detail: T, suggested: ReadonlySet<string>): T {
  if (suggested.size === 0) return detail;
  return {
    ...detail,
    coUpgradeDeps: detail.coUpgradeDeps.map((d) => (suggested.has(d.name) ? { ...d, reason: 'suggested-jev' as const, required: false, explanation: d.explanation === '' ? 'suggested (Jev)' : `suggested (Jev). ${d.explanation}` } : d))
  };
}

/**
 * Keeps only paths our own code knows (graph file set / usage set) that pass
 * the agent path guard: string checks first (absolute, `..`, `.env*`, drive
 * letters refused before any fs call), then realpath containment. With the v1
 * engine `filesToModify[].path` is raw LLM output, so it is never trusted as is.
 */
async function guardedPaths(projectRoot: string, paths: readonly string[], allowed: ReadonlySet<string>): Promise<Map<string, string>> {
  const allowMap = new Map([...allowed].map((p) => [p, true] as const));
  const out = new Map<string, string>();
  for (const raw of paths) {
    let rel: string;
    try {
      rel = normalizeRelPath(raw);
    } catch {
      continue;
    }
    if (!allowed.has(rel) || out.has(raw)) continue;
    try {
      out.set(raw, (await pathGuard(projectRoot, rel, allowMap)).rel);
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * The J2 read allow-list: the project's graph file set (when a completed
 * graph exists) plus the usage-cache paths (written by `usageFromGraph`).
 * The reader is used synchronously only (shared reader cache rule).
 */
export function reportEvidenceAllowedFiles(slug: string, usagePaths: readonly string[]): Set<string> {
  const out = new Set(usagePaths);
  try {
    for (const p of graphFileSet(getGraphReader(slug)).keys()) out.add(p);
  } catch {
    // No completed graph: the usage set alone (possibly empty → nothing is read or sent).
  }
  return out;
}

async function snippetsFor(
  projectRoot: string,
  depName: string,
  guarded: ReadonlyMap<string, string>,
  readFile: ((absPath: string) => Promise<string>) | undefined
): Promise<Map<string, SourceSnippet>> {
  if (guarded.size === 0) return new Map();
  const ctx = await extractImportSiteContext({
    projectRoot,
    depName,
    importingFiles: [...new Set(guarded.values())],
    contextRadius: 10,
    maxTotalChars: 60_000,
    ...(readFile !== undefined ? { readFile } : {})
  });
  const byRel = new Map(ctx.files.map((f) => [f.relativePath, { path: f.relativePath, text: capSnippet(f.windows[0]?.code ?? '') }]));
  const out = new Map<string, SourceSnippet>();
  for (const [raw, rel] of guarded) {
    const s = byRel.get(rel);
    if (s !== undefined) out.set(raw, s);
  }
  return out;
}

/**
 * J2: one Noul per claim — each `filesToModify[]` entry (evidence: its own
 * import-site snippet) and each breaking change with
 * `affectsFilesInProject: true` (evidence: the top 5 files' snippets).
 * Adds `support: 'low' | 'unclear'`; never removes an item.
 *
 * Only files in `allowedFiles` (the graph file set or the usage set, built by
 * our code) are read and claimed; any other `filesToModify` path (v1 engine =
 * raw LLM output: `../x`, absolute, `.env`) is neither read nor sent and gets
 * no badge (review 5b M1).
 */
export async function applyReportEvidenceCheck(
  ctx: JudgeContext | null,
  detail: UpdateReportDetail,
  opts: { projectRoot: string; depName: string; allowedFiles: ReadonlySet<string>; readFile?: (absPath: string) => Promise<string> }
): Promise<UpdateReportDetail> {
  if (ctx === null) return detail;
  const files = detail.filesToModify.slice(0, 50).map((f, i) => ({ f, i }));
  const guarded = await guardedPaths(opts.projectRoot, files.map(({ f }) => f.path), opts.allowedFiles);
  const known = files.filter(({ f }) => guarded.has(f.path));
  const snippets = await snippetsFor(opts.projectRoot, opts.depName, guarded, opts.readFile);
  const top = known.slice(0, 5).map(({ f }) => snippets.get(f.path)).filter((s): s is SourceSnippet => s !== undefined);
  const claims = [
    ...known.map(({ f, i }) => ({ id: `file:${i}`, claim: `${guarded.get(f.path)!} needs a change for this upgrade: ${f.brief}`, evidence: snippets.has(f.path) ? [snippets.get(f.path)!] : [] })),
    ...detail.breakingChanges
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => b.affectsFilesInProject)
      .map(({ b, i }) => ({ id: `bc:${i}`, claim: `${b.title}: ${b.description}. This affects files in the project.`, evidence: top }))
  ];
  if (claims.length === 0) return detail;
  const support = await evidenceCheckJ2(ctx, claims);
  if (support === null) return detail;
  const flag = <T extends object>(item: T, id: string): T => {
    const s = support.get(id)?.support ?? null;
    return s === null ? item : { ...item, support: s };
  };
  return {
    ...detail,
    filesToModify: detail.filesToModify.map((f, i) => flag(f, `file:${i}`)),
    breakingChanges: detail.breakingChanges.map((b, i) => flag(b, `bc:${i}`))
  };
}

/**
 * J4: Jev rename candidates for removed exports the exact-signature
 * heuristic did not match (the heuristic wins on conflict). Returns the diff
 * unchanged when J4 is off / refused / unavailable.
 */
export async function applyJevRenames(ctx: JudgeContext | null, diff: ApiDiffResult | null): Promise<ApiDiffResult | null> {
  if (ctx === null || diff === null || diff.status !== 'ok') return diff;
  const matched = new Set(diff.renamedCandidate.map((c) => c.from));
  const removed = diff.removed.filter((r) => !matched.has(r.name));
  const out = await renameCandidatesJ4(ctx, { pkg: diff.pkg, removed, added: diff.added });
  if (out === null || out.length === 0) return diff;
  return { ...diff, renamedCandidate: [...diff.renamedCandidate, ...out] };
}
