/**
 * View [E] orchestrator (spec §11 + §11.4 truncation).
 *
 * Workflow:
 *   1. Load file content (or surface "file missing" up to the route handler).
 *   2. Compute file hash (sha256) at review time.
 *   3. Apply §11.4 truncation strategy (strip → smart slice → hard truncate).
 *   4. Build the file-review prompt input contract.
 *   5. Render the prompt + compute cache key.
 *   6. Call the LLM (or mock) — no graceful-partial fallback for [E] per §11.9.
 *   7. Persist envelope with file hash + truncated flag + cost fields.
 */
import { promises as fs } from 'fs';
import crypto from 'crypto';
import path from 'path';
import {
  FILE_REVIEW_TOOL_SCHEMA,
  renderFileReviewPrompt,
  type FileReviewPromptInput,
  type FileReviewToolOutput
} from './prompts/file-review';
import { SHARED_SYSTEM_PROMPT } from './prompts/shared';
import { computeCacheKey } from './cacheKey';
import { LLMError, type LLMClient, type LlmPhaseEvent } from './client';
import { truncateFileContent } from './prompts/truncate';
import { loadEnv } from '../config';
import type { AiCostFields, DataSource, FileReviewDetail, ReviewFinding } from '../api-types';

export interface RunFileReviewInput {
  /** Relative POSIX path from project root. */
  relativePath: string;
  /** Absolute path on disk (used to load content + compute hash). */
  absolutePath: string;
  depName: string;
  installedVersion: string | null;
  latestVersion: string | null;
  deprecation: { message: string } | null;
  currentCves: FileReviewPromptInput['dep']['currentCves'];
  /** Static import statements pre-extracted by the code scanner. */
  importStatements: string[];
  /**
   * Symbol-bearing line heuristic. v0: just the dep name itself. v0.x may
   * extend to known exports.
   */
  knownSymbols?: string[];
  model: string;
  onPhase?: (e: LlmPhaseEvent) => void;
  signal?: AbortSignal;
}

export interface FileReviewRun {
  cacheKey: string;
  detail: FileReviewDetail;
  source: DataSource;
}

export async function loadFileForReview(absPath: string): Promise<{ content: string; hash: string }> {
  const content = await fs.readFile(absPath, 'utf8');
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  return { content, hash };
}

export async function runFileReview(client: LLMClient, input: RunFileReviewInput): Promise<FileReviewRun> {
  const { content, hash } = await loadFileForReview(input.absolutePath);
  const env = loadEnv();

  const truncated = truncateFileContent({
    content,
    maxInputTokens: env.budgets.fileReview.input,
    // Conservative reservation for the prompt boilerplate, tool schema, and dep metadata.
    reservedTokens: 1200,
    knownSymbols: input.knownSymbols ?? [input.depName]
  });

  const extension = inferExtension(input.relativePath);
  const promptInput: FileReviewPromptInput = {
    dep: {
      name: input.depName,
      installedVersion: input.installedVersion,
      latestVersion: input.latestVersion,
      deprecation: input.deprecation,
      currentCves: input.currentCves
    },
    file: {
      path: input.relativePath,
      content: truncated.content,
      truncated: truncated.truncated,
      importStatements: [...input.importStatements],
      extension
    }
  };

  const userPrompt = renderFileReviewPrompt(promptInput);
  const cacheKey = computeCacheKey({
    systemPrompt: SHARED_SYSTEM_PROMPT,
    userPrompt,
    tool: FILE_REVIEW_TOOL_SCHEMA,
    model: input.model
  });

  const call = await client.call<FileReviewToolOutput>({
    model: input.model,
    systemPrompt: SHARED_SYSTEM_PROMPT,
    userPrompt,
    tool: FILE_REVIEW_TOOL_SCHEMA,
    maxOutputTokens: env.budgets.fileReview.output,
    maxInputTokens: env.budgets.fileReview.input,
    onPhase: input.onPhase,
    signal: input.signal
  });

  // Reject the call if the output doesn't match a basic shape sanity check.
  if (typeof call.output !== 'object' || call.output === null) {
    throw new LLMError('LLM_TOOL_USE_INVALID', 'File review output was not an object.');
  }

  const cost: AiCostFields = {
    inputTokens: call.inputTokens,
    outputTokens: call.outputTokens,
    model: call.model,
    costEstimateUsd: call.costEstimateUsd
  };

  const pathHash = sha1PathHash(input.relativePath);

  const detail: FileReviewDetail = {
    filePath: input.relativePath,
    pathHash,
    fileHashAtReview: hash,
    lastReviewedAt: new Date().toISOString(),
    stale: false,
    summary: String(call.output.summary ?? ''),
    depUsageQuality: normalizeQuality(call.output.depUsageQuality),
    findings: normalizeFindings(call.output.findings),
    cost
  };
  return { cacheKey, detail, source: `${call.provider}:${call.model}` as DataSource };
}

export function sha1PathHash(relativePath: string): string {
  return crypto.createHash('sha1').update(relativePath).digest('hex').slice(0, 12);
}

export async function computeCurrentFileHash(absPath: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(absPath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

export function inferExtension(relPath: string): string {
  const ext = path.extname(relPath).replace(/^\./, '');
  if (ext === '' ) return '';
  // Normalize the small set we care about; pass-through unknown extensions
  // (Markdown/Mustache code fences just use them as a hint).
  return ext;
}

function normalizeQuality(value: unknown): FileReviewDetail['depUsageQuality'] {
  const allowed: ReadonlyArray<FileReviewDetail['depUsageQuality']> = ['good', 'outdated', 'incorrect', 'risky', 'unknown'];
  return allowed.includes(value as FileReviewDetail['depUsageQuality'])
    ? (value as FileReviewDetail['depUsageQuality'])
    : 'unknown';
}

function normalizeFindings(value: unknown): ReviewFinding[] {
  if (!Array.isArray(value)) return [];
  const kinds: ReadonlyArray<ReviewFinding['kind']> = [
    'outdated-pattern',
    'incorrect-usage',
    'security-risk',
    'deprecation-warning',
    'performance',
    'info'
  ];
  const sevs: ReadonlyArray<ReviewFinding['severity']> = ['info', 'low', 'medium', 'high', 'critical'];
  const confs: ReadonlyArray<NonNullable<ReviewFinding['confidence']>> = ['low', 'medium', 'high'];
  return value
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map((e) => {
      const kind = kinds.includes(e.kind as ReviewFinding['kind']) ? (e.kind as ReviewFinding['kind']) : 'info';
      const severity = sevs.includes(e.severity as ReviewFinding['severity']) ? (e.severity as ReviewFinding['severity']) : 'info';
      const conf = confs.includes(e.confidence as NonNullable<ReviewFinding['confidence']>)
        ? (e.confidence as NonNullable<ReviewFinding['confidence']>)
        : 'high';
      const message = String(e.message ?? '');
      const line = typeof e.line === 'number' && Number.isInteger(e.line) && e.line > 0 ? e.line : undefined;
      const suggestion = typeof e.suggestion === 'string' && e.suggestion !== '' ? e.suggestion : undefined;
      return { kind, severity, message, line, suggestion, confidence: conf } satisfies ReviewFinding;
    })
    .filter((e) => e.message !== '');
}
