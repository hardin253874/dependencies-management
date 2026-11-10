/**
 * Orchestrator for the CVE impact analysis (v0.6, view [A] "Analyze Usage").
 *
 * Mirrors `relatedUpgradeService.ts` in shape:
 *   1. Build a deterministic skeleton (always runs, always present in the
 *      persisted envelope) — one row per CVE with verdict='inconclusive',
 *      confidence='low'. This is what the FE renders when the LLM call fails.
 *   2. Make one batched LLM call passing CVEs + extracted code windows.
 *   3. Merge the LLM output rows onto the skeleton by `cveId` — defends
 *      against missing or out-of-order rows.
 *   4. Return run metadata (cacheKey, detail, source, cost).
 *
 * The route handler is responsible for fanning out usage cache loading +
 * import-site context extraction; this file is pure orchestration.
 */
import { capSnippet, type SourceSnippet } from '../../core/judge/payload';
import { evidenceCheckJ2, triageCvesJ3, type JudgeContext } from '../../core/judge/uses';
import {
  CVE_IMPACT_TOOL_SCHEMA,
  renderCveImpactPrompt,
  type CveImpactPromptInput,
  type CveImpactToolOutput
} from './prompts/cve-impact';
import { SHARED_SYSTEM_PROMPT } from './prompts/shared';
import { computeCacheKey } from './cacheKey';
import { LLMError, type LLMClient } from './client';
import { VIEW_EFFORT } from './effort';
import { getLogger } from '../logger';
import { loadEnv } from '../config';
import type {
  AiCostFields,
  CveImpactDetail,
  CveImpactRow,
  CveRecord,
  WritableDataSource
} from '../api-types';

export interface RunCveImpactInput {
  /** Active model from `_config.json`. */
  model: string;
  maxOutputTokens?: number;
  maxInputTokens?: number;
  /** Identifying info; persisted on the detail. */
  depName: string;
  installedVersion: string;
  /** CVEs to assess — typically `DepDetail.currentVersionCves`. */
  cves: ReadonlyArray<CveRecord>;
  /** Files + windows from `extractImportSiteContext`. */
  files: ReadonlyArray<{
    relativePath: string;
    windows: ReadonlyArray<{ startLine: number; endLine: number; code: string }>;
  }>;
  /** True when the 30k-token cap dropped some files. Surfaced in the prompt. */
  contextTruncated: boolean;
  /** Approx input-token count from the extractor — persisted as provenance. */
  approxContextTokens: number;
  onPhase?: Parameters<LLMClient['call']>[0]['onPhase'];
  signal?: AbortSignal;
  /**
   * v2 Stage 5b: Jev contexts, each `null`/absent = today's behaviour.
   * `j3` = per-CVE triage used ONLY when the LLM call fails (rows labelled
   * "estimated (Jev)"); `j2` = evidence check of each verdict against its
   * cited files (flags only).
   */
  jev?: { j2?: JudgeContext | null; j3?: JudgeContext | null };
}

/** Snippets for J2/J3 from the extracted windows, greedily under a byte budget (the source payload bound). */
export function snippetsFromFiles(files: RunCveImpactInput['files'], only?: ReadonlySet<string>, budgetBytes = 30_000): SourceSnippet[] {
  const out: SourceSnippet[] = [];
  let used = 0;
  for (const f of files) {
    if (only !== undefined && !only.has(f.relativePath)) continue;
    const w = f.windows[0];
    if (w === undefined) continue;
    const text = capSnippet(w.code);
    const bytes = Buffer.byteLength(text, 'utf8') + f.relativePath.length + 32;
    if (used + bytes > budgetBytes) break;
    out.push({ path: f.relativePath, text });
    used += bytes;
  }
  return out;
}

export interface CveImpactRun {
  cacheKey: string;
  detail: CveImpactDetail;
  source: WritableDataSource;
  llmError?: LLMError;
}

/**
 * Build the deterministic skeleton — one row per CVE, all `inconclusive` /
 * low confidence. Used both as the LLM-fallback persisted shape AND as the
 * merge target the LLM rows are laid on top of (so any missed CVE keeps a
 * sensible default row).
 */
export function buildCveImpactSkeleton(input: {
  depName: string;
  installedVersion: string;
  cves: ReadonlyArray<CveRecord>;
  contextTruncated: boolean;
  approxContextTokens: number;
  filesAnalyzed: number;
}): CveImpactDetail {
  const rows: CveImpactRow[] = input.cves.map((cve) => ({
    cveId: cve.id,
    severity: cve.severity,
    summary: cve.summary,
    verdict: 'inconclusive',
    confidence: 'low',
    reasoning: '',
    citedFiles: []
  }));
  return {
    depName: input.depName,
    installedVersion: input.installedVersion,
    rows,
    globalNotes: '',
    inputs: {
      filesAnalyzed: input.filesAnalyzed,
      cveCount: input.cves.length,
      contextTokensUsed: input.approxContextTokens,
      contextTruncated: input.contextTruncated
    }
  };
}

export async function runCveImpact(
  client: LLMClient,
  input: RunCveImpactInput
): Promise<CveImpactRun> {
  const env = loadEnv();
  const maxOutput = input.maxOutputTokens ?? env.budgets.updateReport.output;
  const maxInput = input.maxInputTokens ?? env.budgets.updateReport.input;

  const skeleton = buildCveImpactSkeleton({
    depName: input.depName,
    installedVersion: input.installedVersion,
    cves: input.cves,
    contextTruncated: input.contextTruncated,
    approxContextTokens: input.approxContextTokens,
    filesAnalyzed: input.files.length
  });

  const promptInput: CveImpactPromptInput = {
    dep: { name: input.depName, installedVersion: input.installedVersion },
    cves: input.cves.map((c) => ({ id: c.id, severity: c.severity, summary: c.summary })),
    files: input.files.map((f) => ({
      relativePath: f.relativePath,
      windows: f.windows.map((w) => ({ startLine: w.startLine, endLine: w.endLine, code: w.code }))
    })),
    contextTruncated: input.contextTruncated
  };
  const userPrompt = renderCveImpactPrompt(promptInput);
  const cacheKey = computeCacheKey({
    systemPrompt: SHARED_SYSTEM_PROMPT,
    userPrompt,
    tool: CVE_IMPACT_TOOL_SCHEMA,
    model: input.model
  });

  // 0-CVE short-circuit — should be filtered by the route, but defend here.
  if (input.cves.length === 0) {
    return {
      cacheKey,
      detail: { ...skeleton, globalNotes: 'No CVEs to analyze.' },
      source: 'deterministic-partial'
    };
  }

  let llmResult: { output: CveImpactToolOutput; tokens: AiCostFields; source: WritableDataSource } | null = null;
  let llmError: LLMError | undefined;
  try {
    const call = await client.call<CveImpactToolOutput>({
      model: input.model,
      systemPrompt: SHARED_SYSTEM_PROMPT,
      userPrompt,
      tool: CVE_IMPACT_TOOL_SCHEMA,
      maxOutputTokens: maxOutput,
      effort: VIEW_EFFORT.cveImpact,
      maxInputTokens: maxInput,
      onPhase: input.onPhase,
      signal: input.signal
    });
    llmResult = {
      output: call.output,
      tokens: {
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        cacheReadInputTokens: call.cacheReadInputTokens,
        cacheCreationInputTokens: call.cacheCreationInputTokens,
        model: call.model,
        costEstimateUsd: call.costEstimateUsd
      },
      source: `${call.provider}:${call.model}` as WritableDataSource
    };
  } catch (err) {
    llmError = err instanceof LLMError ? err : new LLMError('LLM_NETWORK', (err as Error).message, false);
    const log = await getLogger();
    log.warn({ err: llmError.message, code: llmError.code }, 'CVE impact LLM call failed');
  }

  if (llmResult !== null) {
    // Merge LLM rows onto the skeleton by cveId — any CVE the model skipped
    // keeps its skeleton (inconclusive/low) row. Out-of-order responses
    // re-sort to input order via the skeleton iteration.
    const byCveId = new Map<string, CveImpactToolOutput['rows'][number]>();
    for (const r of llmResult.output.rows ?? []) {
      if (typeof r?.cveId === 'string') byCveId.set(r.cveId, r);
    }
    const rows: CveImpactRow[] = skeleton.rows.map((s) => {
      const llm = byCveId.get(s.cveId);
      if (llm === undefined) return s;
      return {
        ...s,
        verdict: cleanVerdict(llm.verdict) ?? s.verdict,
        confidence: cleanConfidence(llm.confidence) ?? s.confidence,
        reasoning: typeof llm.reasoning === 'string' ? llm.reasoning : '',
        citedFiles: Array.isArray(llm.citedFiles)
          ? llm.citedFiles.filter((p): p is string => typeof p === 'string')
          : []
      };
    });
    const checked = input.jev?.j2 ? await flagRowSupport(input.jev.j2, rows, input.files) : rows;
    return {
      cacheKey,
      detail: {
        ...skeleton,
        rows: checked,
        globalNotes:
          typeof llmResult.output.globalNotes === 'string' ? llmResult.output.globalNotes : '',
        cost: llmResult.tokens
      },
      source: llmResult.source
    };
  }

  // J3 (5b.12): a better fallback than "all inconclusive", only when the LLM failed.
  if (input.jev?.j3) {
    const triage = await triageCvesJ3(input.jev.j3, {
      cves: input.cves.map((c) => ({ id: c.id, advisory: c.summary })),
      snippets: snippetsFromFiles(input.files)
    });
    if (triage !== null) {
      const rows = skeleton.rows.map((r) => {
        const t = triage.get(r.cveId);
        return t === undefined ? r : { ...r, verdict: t.verdict, confidence: 'low' as const, reasoning: `estimated (Jev), confidence ${t.confidence.toFixed(2)}`, estimatedBy: 'jev' as const };
      });
      return {
        cacheKey,
        detail: { ...skeleton, rows, globalNotes: 'AI analysis unavailable. Verdicts are estimated (Jev). Click Re-analyze to retry.' },
        source: 'deterministic-partial',
        llmError
      };
    }
  }

  // Deterministic-partial fallback.
  return {
    cacheKey,
    detail: {
      ...skeleton,
      globalNotes:
        'AI analysis unavailable. Showing CVE list with no verdicts. Click Re-analyze to retry.'
    },
    source: 'deterministic-partial',
    llmError
  };
}

/** J2 (5b.11): one Noul per row with cited files; low / unclear support is flagged, nothing removed. */
async function flagRowSupport(ctx: JudgeContext, rows: CveImpactRow[], files: RunCveImpactInput['files']): Promise<CveImpactRow[]> {
  const claims = rows
    .filter((r) => r.citedFiles.length > 0)
    .map((r) => ({ id: r.cveId, claim: `${r.cveId}: ${r.verdict}. ${r.reasoning}`, evidence: snippetsFromFiles(files, new Set(r.citedFiles), 12_000) }));
  if (claims.length === 0) return rows;
  const support = await evidenceCheckJ2(ctx, claims);
  if (support === null) return rows;
  return rows.map((r) => {
    const s = support.get(r.cveId)?.support ?? null;
    return s === null ? r : { ...r, support: s };
  });
}

function cleanVerdict(value: unknown): CveImpactRow['verdict'] | null {
  const allowed: ReadonlyArray<CveImpactRow['verdict']> = [
    'not-affected',
    'likely-affected',
    'inconclusive'
  ];
  return allowed.includes(value as CveImpactRow['verdict'])
    ? (value as CveImpactRow['verdict'])
    : null;
}

function cleanConfidence(value: unknown): CveImpactRow['confidence'] | null {
  const allowed: ReadonlyArray<CveImpactRow['confidence']> = ['high', 'medium', 'low'];
  return allowed.includes(value as CveImpactRow['confidence'])
    ? (value as CveImpactRow['confidence'])
    : null;
}
