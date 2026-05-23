/**
 * View [D-Deep] integration tests (Stage 4 / spec §11.6, §7.6).
 *
 * Uses MOCK_LLM=true throughout. Seeds fixtures keyed on the rendered prompt
 * so the orchestrator exercises every code path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runDeepUpdateReport } from '@/lib/llm/deepReportService';
import { MockLLMClient } from '@/lib/llm/mock';
import { LLMError } from '@/lib/llm/client';
import { computeCacheKey } from '@/lib/llm/cacheKey';
import {
  renderDeepUpdateReportPrompt,
  DEEP_UPDATE_REPORT_TOOL_SCHEMA
} from '@/lib/llm/prompts/deep-update-report';
import { SHARED_SYSTEM_PROMPT } from '@/lib/llm/prompts/shared';
import type { DeepUpdateReportPromptInput } from '@/lib/llm/prompts/deep-update-report';
import type {
  CveDelta,
  LockfileSummary,
  ResolverCheckBlock,
  TransitiveDelta
} from '@/lib/api-types';

beforeEach(() => {
  process.env.MOCK_LLM = 'true';
});
afterEach(() => {
  delete process.env.MOCK_LLM;
});

const PROMPT_INPUT: DeepUpdateReportPromptInput = {
  dep: { name: 'react', fromVersion: '17.0.2', toVersion: '19.0.0' },
  lockfileSummary: {
    totalPackages: 1500,
    packagesByDirectDep: { react: 1 },
    peerDepsOnTarget: [
      {
        package: 'react-router',
        version: '6.0.0',
        peerRange: '^17.0.0',
        satisfiedByCandidate: false
      }
    ]
  },
  transitiveDelta: { packagesAdded: [], packagesRemoved: [], packagesUpgraded: [] },
  cveDelta: { newCves: [], resolvedCves: [] },
  resolverCheckSummary: null,
  coUpgradeNames: ['react-dom']
};

const LOCKFILE_SUMMARY: LockfileSummary = PROMPT_INPUT.lockfileSummary;
const TRANSITIVE_DELTA: TransitiveDelta = PROMPT_INPUT.transitiveDelta;
const CVE_DELTA: CveDelta = PROMPT_INPUT.cveDelta;
const RESOLVER_BLOCK: ResolverCheckBlock = {
  kind: 'enabled',
  wouldResolve: true,
  conflicts: [],
  legacyPeerDepsUsed: false
};

describe('runDeepUpdateReport — happy path (MOCK_LLM)', () => {
  it('persists a full DeepUpdateReportDetail with cost + AI fields when fixture matches', async () => {
    const mock = new MockLLMClient({ provider: 'anthropic' });
    const sharedPrompt = renderDeepUpdateReportPrompt(PROMPT_INPUT);
    const key = computeCacheKey({
      systemPrompt: SHARED_SYSTEM_PROMPT,
      userPrompt: sharedPrompt,
      tool: DEEP_UPDATE_REPORT_TOOL_SCHEMA,
      model: 'mock-model'
    });
    mock.set(key, {
      output: {
        summary: 'React 17 → 19 introduces concurrent rendering plus new JSX transform.',
        riskLevel: 'high',
        narrative:
          'First paragraph of narrative.\n\nSecond paragraph with deeper context.',
        estimatedEffort: 'large',
        criticalBlockers: [
          {
            title: 'react-router peer conflict',
            description: 'react-router@6 requires react ^17',
            package: 'react-router'
          }
        ],
        suggestedUpgradeOrder: [
          { step: 1, action: 'Upgrade react-router', rationale: 'Resolves peer constraint.' },
          { step: 2, action: 'Upgrade react', rationale: 'Target dep.' }
        ]
      },
      inputTokens: 12000,
      outputTokens: 800
    });

    const run = await runDeepUpdateReport(mock, {
      promptInput: PROMPT_INPUT,
      model: 'mock-model',
      fromVersion: '17.0.2',
      toVersion: '19.0.0',
      lockfileStateHashShort: 'abc12',
      resolverBlock: RESOLVER_BLOCK,
      coUpgradeDeps: [],
      lockfileSummary: LOCKFILE_SUMMARY,
      transitiveDelta: TRANSITIVE_DELTA,
      cveDelta: CVE_DELTA,
      maxInputTokens: 100_000,
      maxOutputTokens: 8000
    });

    expect(run.cacheKey).toBe(key);
    expect(run.source).toBe('anthropic:mock-model');
    expect(run.detail.summary).toContain('React 17');
    expect(run.detail.riskLevel).toBe('high');
    expect(run.detail.narrative).toContain('First paragraph');
    expect(run.detail.estimatedEffort).toBe('large');
    expect(run.detail.criticalBlockers.length).toBe(1);
    expect(run.detail.suggestedUpgradeOrder.length).toBe(2);
    expect(run.detail.cost?.inputTokens).toBe(12000);
    expect(run.detail.cost?.outputTokens).toBe(800);
    expect(run.detail.cost?.costEstimateUsd).toBeGreaterThan(0);
    // Deterministic carry-over fields preserved.
    expect(run.detail.lockfileSummary).toEqual(LOCKFILE_SUMMARY);
    expect(run.detail.resolverCheck).toEqual(RESOLVER_BLOCK);
    expect(run.detail.lockfileStateHashShort).toBe('abc12');
  });
});

describe('runDeepUpdateReport — LLM-down fallback (§11.9)', () => {
  it('persists deterministic-partial when the LLM throws (no fixture)', async () => {
    const mock = new MockLLMClient({ provider: 'anthropic' });
    const run = await runDeepUpdateReport(mock, {
      promptInput: PROMPT_INPUT,
      model: 'mock-model',
      fromVersion: '17.0.2',
      toVersion: '19.0.0',
      lockfileStateHashShort: 'abc12',
      resolverBlock: RESOLVER_BLOCK,
      coUpgradeDeps: [],
      lockfileSummary: LOCKFILE_SUMMARY,
      transitiveDelta: TRANSITIVE_DELTA,
      cveDelta: CVE_DELTA
    });
    expect(run.source).toBe('deterministic-partial');
    expect(run.llmError).toBeInstanceOf(LLMError);
    expect(run.llmError?.code).toBe('MOCK_LLM_NO_FIXTURE');
    // Skeleton risk level should be elevated to 'high' because we have an
    // unsatisfied peer-dep on the target (deterministic signal).
    expect(run.detail.riskLevel).toBe('high');
    expect(run.detail.lockfileSummary).toEqual(LOCKFILE_SUMMARY);
    expect(run.detail.cost).toBeUndefined();
  });

  it('elevates risk to critical when both unsatisfied peer AND new CVE exist', async () => {
    const mock = new MockLLMClient({ provider: 'anthropic' });
    const cveDeltaWithNew: CveDelta = {
      newCves: [
        { id: 'CVE-2026-0001', package: 'react', severity: 'high', summary: 'XSS' }
      ],
      resolvedCves: []
    };
    const run = await runDeepUpdateReport(mock, {
      promptInput: { ...PROMPT_INPUT, cveDelta: cveDeltaWithNew },
      model: 'mock-model',
      fromVersion: '17.0.2',
      toVersion: '19.0.0',
      lockfileStateHashShort: 'abc12',
      resolverBlock: RESOLVER_BLOCK,
      coUpgradeDeps: [],
      lockfileSummary: LOCKFILE_SUMMARY,
      transitiveDelta: TRANSITIVE_DELTA,
      cveDelta: cveDeltaWithNew
    });
    expect(run.source).toBe('deterministic-partial');
    expect(run.detail.riskLevel).toBe('critical');
  });
});
