/**
 * MOCK_LLM client unit test (spec §11.12, plan Stage 3).
 *
 *  - In-memory fixture hit returns the seeded output + tokens + cost.
 *  - File-based fixture hit reads from `test-fixtures/llm/<hash>.json`.
 *  - Missing fixture → `MOCK_LLM_NO_FIXTURE` error with the key printed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import { MockLLMClient } from '@/lib/llm/mock';
import { computeCacheKey } from '@/lib/llm/cacheKey';
import { LLMError } from '@/lib/llm/client';
import type { ToolSchema } from '@/lib/llm/client';

const TOOL: ToolSchema = {
  name: 'submit_test',
  description: 'desc',
  inputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
};

const TEMP_DIRS: string[] = [];
afterEach(async () => {
  while (TEMP_DIRS.length > 0) {
    const d = TEMP_DIRS.pop();
    if (d !== undefined) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function makeFixtureDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `mockllm-${crypto.randomBytes(4).toString('hex')}`);
  await fs.mkdir(dir, { recursive: true });
  TEMP_DIRS.push(dir);
  return dir;
}

describe('MockLLMClient — in-memory fixture', () => {
  it('returns the seeded fixture when the key matches', async () => {
    const client = new MockLLMClient({ provider: 'anthropic', fixtureDir: await makeFixtureDir() });
    const key = client.setByInput<{ ok: boolean }>(
      { systemPrompt: 'sys', userPrompt: 'u', tool: TOOL, model: 'm1' },
      { output: { ok: true }, inputTokens: 100, outputTokens: 20 }
    );
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const r = await client.call<{ ok: boolean }>({
      model: 'm1',
      systemPrompt: 'sys',
      userPrompt: 'u',
      tool: TOOL,
      maxOutputTokens: 100
    });
    expect(r.output).toEqual({ ok: true });
    expect(r.inputTokens).toBe(100);
    expect(r.outputTokens).toBe(20);
    expect(r.provider).toBe('anthropic');
    expect(r.costEstimateUsd).toBeGreaterThan(0);
  });
});

describe('MockLLMClient — file fixture', () => {
  it('reads a fixture JSON keyed by prompt-hash', async () => {
    const dir = await makeFixtureDir();
    const key = computeCacheKey({ systemPrompt: 's', userPrompt: 'u', tool: TOOL, model: 'm1' });
    await fs.writeFile(
      path.join(dir, `${key}.json`),
      JSON.stringify({ output: { ok: true }, inputTokens: 50, outputTokens: 10 })
    );
    const client = new MockLLMClient({ provider: 'openai', fixtureDir: dir });
    const r = await client.call<{ ok: boolean }>({
      model: 'm1',
      systemPrompt: 's',
      userPrompt: 'u',
      tool: TOOL,
      maxOutputTokens: 100
    });
    expect(r.output).toEqual({ ok: true });
    expect(r.inputTokens).toBe(50);
    expect(r.outputTokens).toBe(10);
    expect(r.provider).toBe('openai');
  });
});

describe('MockLLMClient — missing fixture', () => {
  it('throws MOCK_LLM_NO_FIXTURE with the missing key in the message', async () => {
    const client = new MockLLMClient({ provider: 'anthropic', fixtureDir: await makeFixtureDir() });
    const expectedKey = computeCacheKey({
      systemPrompt: 'sys',
      userPrompt: 'no-fixture',
      tool: TOOL,
      model: 'm1'
    });
    await expect(
      client.call({
        model: 'm1',
        systemPrompt: 'sys',
        userPrompt: 'no-fixture',
        tool: TOOL,
        maxOutputTokens: 100
      })
    ).rejects.toMatchObject({
      name: 'LLMError',
      code: 'MOCK_LLM_NO_FIXTURE'
    });

    // Verify the missing key is surfaced (so the dev can seed it).
    try {
      await client.call({
        model: 'm1',
        systemPrompt: 'sys',
        userPrompt: 'no-fixture',
        tool: TOOL,
        maxOutputTokens: 100
      });
    } catch (err) {
      const e = err as LLMError;
      expect(e.message).toContain(expectedKey);
    }
  });

  it('throws LLMError with retryable=false', async () => {
    const client = new MockLLMClient({ provider: 'anthropic', fixtureDir: await makeFixtureDir() });
    try {
      await client.call({
        model: 'm1',
        systemPrompt: 'x',
        userPrompt: 'y',
        tool: TOOL,
        maxOutputTokens: 100
      });
      expect.fail('Expected an LLMError');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMError);
      expect((err as LLMError).retryable).toBe(false);
    }
  });
});

describe('MockLLMClient — abort signal honored', () => {
  it('throws LLM_CANCELLED when aborted before dispatch', async () => {
    const client = new MockLLMClient({ provider: 'anthropic', fixtureDir: await makeFixtureDir() });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      client.call({
        model: 'm1',
        systemPrompt: 's',
        userPrompt: 'u',
        tool: TOOL,
        maxOutputTokens: 100,
        signal: ctrl.signal
      })
    ).rejects.toMatchObject({ code: 'LLM_CANCELLED' });
  });
});
