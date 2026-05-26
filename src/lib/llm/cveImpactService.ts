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
import {
  CVE_IMPACT_TOOL_SCHEMA,
  renderCveImpactPrompt,
  type CveImpactPromptInput,
  type CveImpactToolOutput
} from './prompts/cve-impact';
import { SHARED_SYSTEM_PROMPT } from './prompts/shared';
import { computeCacheKey } from './cacheKey';
import { LLMError, type LLMClient } from './client';
import { getLogger } from '../logger';
import { loadEnv } from '../config';
import type {
  AiCostFields,
  CveImpactDetail,
  CveImpactRow,
  CveRecord,
  DataSource
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
}

export interface CveImpactRun {
  cacheKey: string;
  detail: CveImpactDetail;
  source: DataSource;
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

  let llmResult: { output: CveImpactToolOutput; tokens: AiCostFields; source: DataSource } | null = null;
  let llmError: LLMError | undefined;
  try {
    const call = await client.call<CveImpactToolOutput>({
      model: input.model,
      systemPrompt: SHARED_SYSTEM_PROMPT,
      userPrompt,
      tool: CVE_IMPACT_TOOL_SCHEMA,
      maxOutputTokens: maxOutput,
      maxInputTokens: maxInput,
      onPhase: input.onPhase,
      signal: input.signal
    });
    llmResult = {
      output: call.output,
      tokens: {
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        model: call.model,
        costEstimateUsd: call.costEstimateUsd
      },
      source: `${call.provider}:${call.model}` as DataSource
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
    return {
      cacheKey,
      detail: {
        ...skeleton,
        rows,
        globalNotes:
          typeof llmResult.output.globalNotes === 'string' ? llmResult.output.globalNotes : '',
        cost: llmResult.tokens
      },
      source: llmResult.source
    };
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
