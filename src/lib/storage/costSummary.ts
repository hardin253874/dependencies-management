/**
 * Per-project cost summary (spec §7.7 → Cost, §11.11).
 *
 * Walks every persisted AI envelope under a project (`reports/`, `deep-reports/`,
 * `file-reviews/`) and aggregates the `cost` fields. Deterministic-partial
 * envelopes (LLM-down fallback) have no cost entry — they're counted but
 * contribute 0 USD.
 *
 * Designed to be cheap on a 150-dep / 30-report project: O(n) file reads with
 * an early `cost` field check.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { readJson } from './atomic';
import { reportsDir, deepReportsDir, fileReviewsDir } from '../paths';
import type { AiCostFields, CostSummaryResponse, LlmProvider } from '../api-types';

type Kind = 'reports' | 'deep-reports' | 'file-reviews';

interface EnvelopeShape {
  source?: string;
  data?: { cost?: AiCostFields };
}

const KINDS: ReadonlyArray<{ kind: Kind; dir: (slug: string) => string }> = [
  { kind: 'reports', dir: reportsDir },
  { kind: 'deep-reports', dir: deepReportsDir },
  { kind: 'file-reviews', dir: fileReviewsDir }
];

export async function computeCostSummary(slug: string): Promise<CostSummaryResponse> {
  const byProvider: Record<LlmProvider, Map<string, AggrEntry>> = {
    anthropic: new Map(),
    openai: new Map()
  };
  const byKind: Record<string, { count: number; costUsd: number }> = {
    reports: { count: 0, costUsd: 0 },
    'deep-reports': { count: 0, costUsd: 0 },
    'file-reviews': { count: 0, costUsd: 0 }
  };
  let totalUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCount = 0;

  for (const { kind, dir } of KINDS) {
    const root = dir(slug);
    await walk(root, async (file) => {
      let env: EnvelopeShape;
      try {
        env = await readJson<EnvelopeShape>(file);
      } catch {
        return;
      }
      const source = env.source ?? '';
      const cost = env.data?.cost;
      const provider = providerFromSource(source);
      byKind[kind]!.count += 1;
      totalCount += 1;
      if (cost === undefined || provider === null) {
        return; // deterministic-partial / non-AI sources
      }
      byKind[kind]!.costUsd += cost.costEstimateUsd;
      totalUsd += cost.costEstimateUsd;
      totalInputTokens += cost.inputTokens;
      totalOutputTokens += cost.outputTokens;
      const map = byProvider[provider];
      const aggrKey = cost.model;
      const existing = map.get(aggrKey);
      if (existing === undefined) {
        map.set(aggrKey, {
          model: cost.model,
          count: 1,
          inputTokens: cost.inputTokens,
          outputTokens: cost.outputTokens,
          costUsd: cost.costEstimateUsd
        });
      } else {
        existing.count += 1;
        existing.inputTokens += cost.inputTokens;
        existing.outputTokens += cost.outputTokens;
        existing.costUsd += cost.costEstimateUsd;
      }
    });
  }

  return {
    slug,
    totalUsd: round6(totalUsd),
    totalInputTokens,
    totalOutputTokens,
    count: totalCount,
    byProvider: {
      anthropic: Array.from(byProvider.anthropic.values()).map((e) => ({
        provider: 'anthropic',
        model: e.model,
        count: e.count,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        costUsd: round6(e.costUsd)
      })),
      openai: Array.from(byProvider.openai.values()).map((e) => ({
        provider: 'openai',
        model: e.model,
        count: e.count,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        costUsd: round6(e.costUsd)
      }))
    },
    byKind: Object.fromEntries(
      Object.entries(byKind).map(([k, v]) => [k, { count: v.count, costUsd: round6(v.costUsd) }])
    )
  };
}

interface AggrEntry {
  model: string;
  count: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

function providerFromSource(source: string): LlmProvider | null {
  if (source.startsWith('anthropic:')) return 'anthropic';
  if (source.startsWith('openai:')) return 'openai';
  return null;
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

async function walk(root: string, onFile: (file: string) => Promise<void>): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walk(full, onFile);
      continue;
    }
    if (entry.isFile() && full.endsWith('.json')) {
      await onFile(full);
    }
  }
}
