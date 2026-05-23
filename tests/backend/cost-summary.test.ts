/**
 * Cost summary integration test (Stage 4, spec §7.7 Cost, §11.11).
 *
 * Seeds report + deep-report + file-review envelopes with synthetic `cost`
 * fields, then asserts `computeCostSummary` aggregates them correctly across
 * categories + providers + models.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { createSandbox, disposeAllSandboxes, type Sandbox } from './helpers/sandbox';
import { createSmallNpmProject } from './helpers/fixtures';
import { addProjectPipeline } from '@/lib/projects/add';
import { writeEnvelope } from '@/lib/storage/envelope';
import {
  reportFilePath,
  deepReportFilePath,
  fileReviewFilePath
} from '@/lib/paths';
import { computeCostSummary } from '@/lib/storage/costSummary';
import type {
  DeepUpdateReportDetail,
  FileReviewDetail,
  UpdateReportDetail
} from '@/lib/api-types';

let sandbox: Sandbox | undefined;
afterEach(async () => {
  if (sandbox !== undefined) await sandbox.dispose();
  await disposeAllSandboxes();
  sandbox = undefined;
});

const RESOLVER_OK = {
  kind: 'enabled' as const,
  wouldResolve: true,
  conflicts: [],
  legacyPeerDepsUsed: false
};

describe('computeCostSummary', () => {
  it('returns all zeros for a project with no AI envelopes', async () => {
    sandbox = await createSandbox('cost-empty');
    const proj = path.join(sandbox.scratchRoot, 'p');
    await createSmallNpmProject(proj);
    const result = await addProjectPipeline({ absolutePath: proj });
    if (!result.ok) throw new Error('Add failed');
    const summary = await computeCostSummary(result.slug);
    expect(summary.totalUsd).toBe(0);
    expect(summary.count).toBe(0);
    expect(summary.byProvider.anthropic).toEqual([]);
    expect(summary.byProvider.openai).toEqual([]);
  });

  it('aggregates costs across reports + deep-reports + file-reviews by provider', async () => {
    sandbox = await createSandbox('cost-aggregation');
    const proj = path.join(sandbox.scratchRoot, 'p');
    await createSmallNpmProject(proj);
    const result = await addProjectPipeline({ absolutePath: proj });
    if (!result.ok) throw new Error('Add failed');

    // Persist 2 reports (anthropic), 1 deep-report (anthropic), 1 file-review (openai).
    const report1: UpdateReportDetail = {
      fromVersion: '18.3.1',
      toVersion: '19.0.0',
      summary: 'x',
      riskLevel: 'medium',
      resolverCheck: RESOLVER_OK,
      coUpgradeDeps: [],
      breakingChanges: [],
      filesToModify: [],
      recommendations: [],
      cost: {
        inputTokens: 1000,
        outputTokens: 200,
        model: 'claude-opus-4-7',
        costEstimateUsd: 0.05
      }
    };
    const report2: UpdateReportDetail = {
      ...report1,
      cost: {
        inputTokens: 500,
        outputTokens: 100,
        model: 'claude-opus-4-7',
        costEstimateUsd: 0.025
      }
    };
    await writeEnvelope<UpdateReportDetail>(
      reportFilePath(result.slug, 'react', '18.3.1', '19.0.0'),
      { source: 'anthropic:claude-opus-4-7', ttlHours: null, data: report1 }
    );
    await writeEnvelope<UpdateReportDetail>(
      reportFilePath(result.slug, 'react-dom', '18.3.1', '19.0.0'),
      { source: 'anthropic:claude-opus-4-7', ttlHours: null, data: report2 }
    );

    const deep: DeepUpdateReportDetail = {
      fromVersion: '17.0.2',
      toVersion: '19.0.0',
      lockfileStateHashShort: 'abc12',
      summary: 'x',
      riskLevel: 'high',
      narrative: 'n',
      estimatedEffort: 'large',
      lockfileSummary: { totalPackages: 100, packagesByDirectDep: {}, peerDepsOnTarget: [] },
      transitiveDelta: { packagesAdded: [], packagesRemoved: [], packagesUpgraded: [] },
      cveDelta: { newCves: [], resolvedCves: [] },
      criticalBlockers: [],
      suggestedUpgradeOrder: [],
      resolverCheck: RESOLVER_OK,
      coUpgradeDeps: [],
      cost: {
        inputTokens: 5000,
        outputTokens: 800,
        model: 'claude-opus-4-7',
        costEstimateUsd: 0.2
      }
    };
    await writeEnvelope<DeepUpdateReportDetail>(
      deepReportFilePath(result.slug, 'react', '17.0.2', '19.0.0', 'abc12'),
      { source: 'anthropic:claude-opus-4-7', ttlHours: null, data: deep }
    );

    const review: FileReviewDetail = {
      filePath: 'src/App.tsx',
      pathHash: 'abcdef123456',
      fileHashAtReview: 'hash1',
      lastReviewedAt: new Date().toISOString(),
      stale: false,
      summary: 'x',
      depUsageQuality: 'good',
      findings: [],
      cost: {
        inputTokens: 800,
        outputTokens: 300,
        model: 'gpt-4o',
        costEstimateUsd: 0.012
      }
    };
    await writeEnvelope<FileReviewDetail>(
      fileReviewFilePath(result.slug, 'react', 'abcdef123456'),
      { source: 'openai:gpt-4o', ttlHours: null, data: review }
    );

    const summary = await computeCostSummary(result.slug);

    expect(summary.count).toBe(4);
    expect(summary.totalInputTokens).toBe(1000 + 500 + 5000 + 800);
    expect(summary.totalOutputTokens).toBe(200 + 100 + 800 + 300);
    expect(summary.totalUsd).toBeCloseTo(0.05 + 0.025 + 0.2 + 0.012, 6);

    expect(summary.byProvider.anthropic.length).toBe(1);
    expect(summary.byProvider.anthropic[0]!.model).toBe('claude-opus-4-7');
    expect(summary.byProvider.anthropic[0]!.count).toBe(3); // 2 reports + 1 deep
    expect(summary.byProvider.openai.length).toBe(1);
    expect(summary.byProvider.openai[0]!.model).toBe('gpt-4o');
    expect(summary.byProvider.openai[0]!.count).toBe(1);

    expect(summary.byKind.reports?.count).toBe(2);
    expect(summary.byKind['deep-reports']?.count).toBe(1);
    expect(summary.byKind['file-reviews']?.count).toBe(1);
  });

  it('skips deterministic-partial envelopes (no cost field)', async () => {
    sandbox = await createSandbox('cost-skip-partial');
    const proj = path.join(sandbox.scratchRoot, 'p');
    await createSmallNpmProject(proj);
    const result = await addProjectPipeline({ absolutePath: proj });
    if (!result.ok) throw new Error('Add failed');
    const partialReport: UpdateReportDetail = {
      fromVersion: '18.3.1',
      toVersion: '19.0.0',
      summary: '',
      riskLevel: 'medium',
      resolverCheck: RESOLVER_OK,
      coUpgradeDeps: [],
      breakingChanges: [],
      filesToModify: [],
      recommendations: []
      // no cost field
    };
    await writeEnvelope<UpdateReportDetail>(
      reportFilePath(result.slug, 'react', '18.3.1', '19.0.0'),
      { source: 'deterministic-partial', ttlHours: null, data: partialReport }
    );
    const summary = await computeCostSummary(result.slug);
    expect(summary.totalUsd).toBe(0);
    expect(summary.byKind.reports?.count).toBe(1); // still counted
    expect(summary.byProvider.anthropic).toEqual([]);
  });
});
