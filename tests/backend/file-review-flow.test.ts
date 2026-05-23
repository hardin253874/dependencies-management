/**
 * View [E] integration tests (spec §11 + Stage 3 plan).
 *
 *  - Happy path: file content read → truncate → mocked LLM → persisted with
 *    file hash + cost fields.
 *  - Stale check: modify the fixture file; computeCurrentFileHash differs from
 *    the persisted fileHashAtReview.
 *  - LLM down: no graceful fallback (§11.9) — error propagates.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createSandbox, disposeAllSandboxes, type Sandbox } from './helpers/sandbox';
import {
  runFileReview,
  loadFileForReview,
  computeCurrentFileHash,
  sha1PathHash
} from '@/lib/llm/fileReviewService';
import { MockLLMClient } from '@/lib/llm/mock';
import { LLMError } from '@/lib/llm/client';
import { computeCacheKey } from '@/lib/llm/cacheKey';
import {
  renderFileReviewPrompt,
  FILE_REVIEW_TOOL_SCHEMA
} from '@/lib/llm/prompts/file-review';
import { SHARED_SYSTEM_PROMPT } from '@/lib/llm/prompts/shared';
import { loadEnv, resetEnvCache } from '@/lib/config';
import { truncateFileContent } from '@/lib/llm/prompts/truncate';

let sandbox: Sandbox | undefined;
beforeEach(() => {
  process.env.MOCK_LLM = 'true';
  resetEnvCache();
});
afterEach(async () => {
  delete process.env.MOCK_LLM;
  resetEnvCache();
  if (sandbox !== undefined) await sandbox.dispose();
  await disposeAllSandboxes();
});

async function makeFile(dir: string, name: string, content: string): Promise<string> {
  const fp = path.join(dir, name);
  await fs.writeFile(fp, content);
  return fp;
}

describe('runFileReview — happy path (MOCK_LLM)', () => {
  it('persists a FileReviewDetail with fileHashAtReview and cost fields', async () => {
    sandbox = await createSandbox('file-review-happy');
    const dir = await sandbox.scratch('proj');
    const absPath = await makeFile(
      dir,
      'src-App.tsx',
      "import React from 'react';\nexport default function App() { return null; }\n"
    );
    const relPath = 'src/App.tsx';

    const mock = new MockLLMClient({ provider: 'anthropic' });

    // Pre-compute the same cache key our service will compute.
    const { content } = await loadFileForReview(absPath);
    const env = loadEnv();
    const truncated = truncateFileContent({
      content,
      maxInputTokens: env.budgets.fileReview.input,
      reservedTokens: 1200,
      knownSymbols: ['react']
    });
    const prompt = renderFileReviewPrompt({
      dep: {
        name: 'react',
        installedVersion: '18.3.1',
        latestVersion: '19.0.0',
        deprecation: null,
        currentCves: []
      },
      file: {
        path: relPath,
        content: truncated.content,
        truncated: truncated.truncated,
        importStatements: ["import React from 'react';"],
        extension: 'tsx'
      }
    });
    const key = computeCacheKey({
      systemPrompt: SHARED_SYSTEM_PROMPT,
      userPrompt: prompt,
      tool: FILE_REVIEW_TOOL_SCHEMA,
      model: 'mock-model'
    });

    mock.set(key, {
      output: {
        summary: 'Uses React in a clean, modern way.',
        depUsageQuality: 'good',
        findings: []
      },
      inputTokens: 800,
      outputTokens: 100
    });

    const run = await runFileReview(mock, {
      relativePath: relPath,
      absolutePath: absPath,
      depName: 'react',
      installedVersion: '18.3.1',
      latestVersion: '19.0.0',
      deprecation: null,
      currentCves: [],
      importStatements: ["import React from 'react';"],
      knownSymbols: ['react'],
      model: 'mock-model'
    });

    expect(run.cacheKey).toBe(key);
    expect(run.detail.depUsageQuality).toBe('good');
    expect(run.detail.findings).toEqual([]);
    expect(run.detail.filePath).toBe(relPath);
    expect(run.detail.pathHash).toBe(sha1PathHash(relPath));
    expect(run.detail.fileHashAtReview).toMatch(/^[0-9a-f]{64}$/);
    expect(run.detail.stale).toBe(false);
    expect(run.detail.cost).toBeDefined();
    expect(run.detail.cost?.inputTokens).toBe(800);
    expect(run.detail.cost?.outputTokens).toBe(100);
    expect(run.detail.cost?.costEstimateUsd).toBeGreaterThan(0);
  });
});

describe('computeCurrentFileHash — stale detection input', () => {
  it('returns a different hash when the file content changes', async () => {
    sandbox = await createSandbox('file-review-stale');
    const dir = await sandbox.scratch('proj');
    const fp = await makeFile(dir, 'App.tsx', 'const a = 1;\n');
    const h1 = await computeCurrentFileHash(fp);
    await fs.writeFile(fp, 'const a = 2;\n');
    const h2 = await computeCurrentFileHash(fp);
    expect(h1).not.toBeNull();
    expect(h2).not.toBeNull();
    expect(h1).not.toBe(h2);
  });

  it('returns null when the file is missing', async () => {
    sandbox = await createSandbox('file-review-missing');
    const dir = await sandbox.scratch('proj');
    const h = await computeCurrentFileHash(path.join(dir, 'gone.tsx'));
    expect(h).toBeNull();
  });
});

describe('runFileReview — LLM down (no graceful fallback per §11.9)', () => {
  it('propagates LLMError when the mock has no fixture', async () => {
    sandbox = await createSandbox('file-review-llm-down');
    const dir = await sandbox.scratch('proj');
    const absPath = await makeFile(dir, 'App.tsx', "import 'react';");
    const mock = new MockLLMClient({ provider: 'anthropic' });

    await expect(
      runFileReview(mock, {
        relativePath: 'App.tsx',
        absolutePath: absPath,
        depName: 'react',
        installedVersion: '18.3.1',
        latestVersion: null,
        deprecation: null,
        currentCves: [],
        importStatements: ["import 'react';"],
        knownSymbols: ['react'],
        model: 'mock-model'
      })
    ).rejects.toBeInstanceOf(LLMError);
  });
});
