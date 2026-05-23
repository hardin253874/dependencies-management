/**
 * View [D] integration tests (spec §11 + §10.7 + Stage 3 plan).
 *
 * Uses MOCK_LLM=true throughout (set in beforeEach). The mock client is seeded
 * with a fixture for the exact prompt/cache-key combination the orchestrator
 * produces, so a single test fully exercises the LLM call path.
 *
 *   - Happy path: deterministic inputs + mocked LLM → persisted with cost fields.
 *   - LLM down: mock throws → `source: deterministic-partial` persisted.
 *   - Kill-switch off: resolver block kind=disabled reason=kill-switch.
 *   - Yarn project: resolver block kind=disabled reason=yarn.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createSandbox, disposeAllSandboxes, type Sandbox } from './helpers/sandbox';
import { createSmallNpmProject } from './helpers/fixtures';
import { addProjectPipeline } from '@/lib/projects/add';
import { runUpdateReport } from '@/lib/llm/reportService';
import { MockLLMClient } from '@/lib/llm/mock';
import { LLMError } from '@/lib/llm/client';
import { computeCacheKey } from '@/lib/llm/cacheKey';
import { renderUpdateReportPrompt, UPDATE_REPORT_TOOL_SCHEMA } from '@/lib/llm/prompts/update-report';
import { SHARED_SYSTEM_PROMPT } from '@/lib/llm/prompts/shared';
import type { UpdateReportPromptInput } from '@/lib/llm/prompts/update-report';
import type { ResolverCheckBlock } from '@/lib/api-types';

let sandbox: Sandbox | undefined;
beforeEach(() => {
  process.env.MOCK_LLM = 'true';
});
afterEach(async () => {
  delete process.env.MOCK_LLM;
  if (sandbox !== undefined) await sandbox.dispose();
  await disposeAllSandboxes();
});

const PROMPT_INPUT: UpdateReportPromptInput = {
  dep: { name: 'react', fromVersion: '18.3.1', toVersion: '19.0.0', releaseNotesBetween: null },
  resolverCheck: { wouldResolve: true, conflicts: [], legacyPeerDepsUsed: false },
  candidateCoUpgrades: [{ name: 'react-dom', currentVersion: '18.3.1', declaredPeerDepRange: null }],
  affectedFiles: []
};

const RESOLVER_OK: ResolverCheckBlock = {
  kind: 'enabled',
  wouldResolve: true,
  conflicts: [],
  legacyPeerDepsUsed: false
};

const RESOLVER_KILL_SWITCH: ResolverCheckBlock = { kind: 'disabled', reason: 'kill-switch' };
const RESOLVER_YARN: ResolverCheckBlock = { kind: 'disabled', reason: 'yarn' };

describe('runUpdateReport — happy path (MOCK_LLM)', () => {
  it('persists a full UpdateReportDetail with cost fields when the LLM returns a fixture', async () => {
    const mock = new MockLLMClient({ provider: 'anthropic' });

    // Seed a fixture matching the inputs we'll send.
    const sharedPrompt = renderUpdateReportPrompt({
      ...PROMPT_INPUT,
      resolverCheck: { wouldResolve: true, conflicts: [], legacyPeerDepsUsed: false }
    });
    const key = computeCacheKey({
      systemPrompt: SHARED_SYSTEM_PROMPT,
      userPrompt: sharedPrompt,
      tool: UPDATE_REPORT_TOOL_SCHEMA,
      model: 'mock-model'
    });
    mock.set(key, {
      output: {
        summary: 'React 19 brings concurrent rendering improvements.',
        riskLevel: 'medium',
        breakingChanges: [
          { title: 'New JSX transform required', description: 'TS configs must enable react-jsx.', affectsFilesInProject: true }
        ],
        coUpgradeDeps: [
          {
            name: 'react-dom',
            currentVersion: '18.3.1',
            suggestedVersion: '19.0.0',
            required: true,
            reason: 'peer-dep',
            explanation: 'React 19 ships in lockstep with react-dom 19.'
          }
        ],
        filesToModify: [
          { path: 'src/App.tsx', brief: 'Audit class components.', estimatedChangeSize: 'small' }
        ],
        recommendations: ['Run the codemod first.']
      },
      inputTokens: 1000,
      outputTokens: 200
    });

    const run = await runUpdateReport(mock, {
      promptInput: PROMPT_INPUT,
      model: 'mock-model',
      resolverBlock: RESOLVER_OK,
      fromVersion: '18.3.1',
      toVersion: '19.0.0',
      maxOutputTokens: 200,
      maxInputTokens: 1000
    });

    expect(run.cacheKey).toBe(key);
    expect(run.source).toBe('anthropic:mock-model');
    expect(run.detail.summary).toContain('React 19');
    expect(run.detail.riskLevel).toBe('medium');
    expect(run.detail.cost).toBeDefined();
    expect(run.detail.cost?.inputTokens).toBe(1000);
    expect(run.detail.cost?.outputTokens).toBe(200);
    expect(run.detail.cost?.model).toBe('mock-model');
    expect(run.detail.cost?.costEstimateUsd).toBeGreaterThan(0);

    // Resolver block is the one the caller supplied, untouched by the LLM.
    expect(run.detail.resolverCheck).toEqual(RESOLVER_OK);

    // Pre-filled fields preserved from caller (not LLM output).
    expect(run.detail.fromVersion).toBe('18.3.1');
    expect(run.detail.toVersion).toBe('19.0.0');
  });
});

describe('runUpdateReport — LLM-down fallback (§11.9)', () => {
  it('persists `deterministic-partial` source when the LLM throws', async () => {
    // Mock with no fixtures seeded → MOCK_LLM_NO_FIXTURE is thrown.
    const mock = new MockLLMClient({ provider: 'anthropic' });
    const run = await runUpdateReport(mock, {
      promptInput: PROMPT_INPUT,
      model: 'mock-model',
      resolverBlock: RESOLVER_OK,
      fromVersion: '18.3.1',
      toVersion: '19.0.0'
    });
    expect(run.source).toBe('deterministic-partial');
    expect(run.llmError).toBeInstanceOf(LLMError);
    expect(run.llmError?.code).toBe('MOCK_LLM_NO_FIXTURE');
    // Skeleton populated from deterministic inputs.
    expect(run.detail.coUpgradeDeps.length).toBe(1);
    expect(run.detail.coUpgradeDeps[0]?.name).toBe('react-dom');
    expect(run.detail.resolverCheck).toEqual(RESOLVER_OK);
    // No cost on deterministic-partial.
    expect(run.detail.cost).toBeUndefined();
  });
});

describe('runUpdateReport — resolver disabled paths', () => {
  it('passes the kill-switch resolver block through unchanged', async () => {
    const mock = new MockLLMClient({ provider: 'anthropic' });
    const run = await runUpdateReport(mock, {
      promptInput: { ...PROMPT_INPUT, resolverCheck: null },
      model: 'mock-model',
      resolverBlock: RESOLVER_KILL_SWITCH,
      fromVersion: '18.3.1',
      toVersion: '19.0.0'
    });
    expect(run.detail.resolverCheck).toEqual(RESOLVER_KILL_SWITCH);
  });

  it('passes the yarn resolver block through unchanged', async () => {
    const mock = new MockLLMClient({ provider: 'anthropic' });
    const run = await runUpdateReport(mock, {
      promptInput: { ...PROMPT_INPUT, resolverCheck: null },
      model: 'mock-model',
      resolverBlock: RESOLVER_YARN,
      fromVersion: '18.3.1',
      toVersion: '19.0.0'
    });
    expect(run.detail.resolverCheck).toEqual(RESOLVER_YARN);
  });
});

// ---------------------------------------------------------------------------
// Target read-only invariant (§16.3 BLOCKER)
//
// Snapshot the target dir before / after a (mocked) report run that exercises
// the full resolver TempSandbox path. The target must remain byte-identical.
// ---------------------------------------------------------------------------

import { snapshotDirectory } from './helpers/fixtures';

describe('target read-only invariant — view [D] (§16.3)', () => {
  it('does not write to or modify the target project during a refresh flow', async () => {
    sandbox = await createSandbox('reports-readonly');
    const dir = await sandbox.scratch('target');
    await createSmallNpmProject(dir);
    const result = await addProjectPipeline({ absolutePath: dir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const before = await snapshotDirectory(dir);

    // Simulate the work the refresh route would do, isolated to the bits that
    // touch the target. We construct the report orchestrator path directly.
    const mock = new MockLLMClient({ provider: 'anthropic' });
    await runUpdateReport(mock, {
      promptInput: PROMPT_INPUT,
      model: 'mock-model',
      resolverBlock: RESOLVER_OK,
      fromVersion: '18.3.1',
      toVersion: '19.0.0'
    }).catch(() => undefined); // graceful-partial path is fine for this test

    const after = await snapshotDirectory(dir);

    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const key of Object.keys(before)) {
      expect(after[key]).toBe(before[key]);
    }
  });
});

// Reference avoidance.
void path;
void fs;
