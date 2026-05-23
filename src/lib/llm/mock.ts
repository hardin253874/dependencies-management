/**
 * Mock LLM client (spec §11.12).
 *
 * When `MOCK_LLM=true`:
 *   - Every call's prompt-hash is computed (sha256 of system + user + tool + model).
 *   - The mock looks up `test-fixtures/llm/<hash>.json` (or the override dir).
 *   - On hit: returns the fixture's `output` + token counts + cost estimate.
 *   - On miss: throws `MOCK_LLM_NO_FIXTURE` with the missing key logged so a
 *     developer can regenerate fixtures (or write one by hand for a new test).
 *
 * Fixtures are tiny JSON files — see `test-fixtures/llm/README.md` for the
 * shape. The `npm run record-llm-fixtures` script (Stage 4 deliverable) will
 * automate capture against a real provider.
 *
 * Phase events are still emitted so tests can assert that the SSE plumbing
 * sees them — but they fire synchronously from the in-memory mock with no
 * real network latency.
 */
import path from 'path';
import { promises as fs } from 'fs';
import { LLMError, type LLMClient, type LlmCallRequest, type LlmCallResult } from './client';
import { computeCacheKey } from './cacheKey';
import { costEstimateUsd } from './cost';
import { getLogger } from '../logger';
import type { LlmProvider } from '../api-types';

export interface MockFixture<T = unknown> {
  output: T;
  inputTokens: number;
  outputTokens: number;
}

export interface MockLLMOptions {
  /** Provider identity surfaced via `client.provider`; defaults to 'anthropic'. */
  provider?: LlmProvider;
  /** Override the fixture directory (default: <cwd>/test-fixtures/llm/). */
  fixtureDir?: string;
  /** Optional in-memory fixtures, keyed by cache-key hash. */
  inMemory?: Map<string, MockFixture>;
}

export class MockLLMClient implements LLMClient {
  readonly provider: LlmProvider;
  private readonly fixtureDir: string;
  private readonly inMemory: Map<string, MockFixture>;

  constructor(opts: MockLLMOptions = {}) {
    this.provider = opts.provider ?? 'anthropic';
    this.fixtureDir = opts.fixtureDir ?? path.resolve(process.cwd(), 'test-fixtures', 'llm');
    this.inMemory = opts.inMemory ?? new Map<string, MockFixture>();
  }

  /** Programmatically seed a fixture by hash (used by tests). */
  set<T>(hash: string, fixture: MockFixture<T>): void {
    this.inMemory.set(hash, fixture as MockFixture);
  }

  /** Programmatically seed a fixture by input (computes hash for you). */
  setByInput<T>(input: { systemPrompt: string; userPrompt: string; tool: LlmCallRequest['tool']; model: string }, fixture: MockFixture<T>): string {
    const key = computeCacheKey({
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      tool: input.tool,
      model: input.model
    });
    this.inMemory.set(key, fixture as MockFixture);
    return key;
  }

  async call<T = unknown>(req: LlmCallRequest): Promise<LlmCallResult<T>> {
    const key = computeCacheKey({
      systemPrompt: req.systemPrompt,
      userPrompt: req.userPrompt,
      tool: req.tool,
      model: req.model
    });

    req.onPhase?.({ phase: 'calling', message: 'Calling MOCK LLM…' });
    if (req.signal?.aborted) throw new LLMError('LLM_CANCELLED', 'Cancelled before mock dispatch');

    // 1. In-memory takes priority (tests use this).
    const inMem = this.inMemory.get(key) as MockFixture<T> | undefined;
    if (inMem !== undefined) {
      return this.toResult(inMem, req);
    }

    // 2. File-system fixture lookup.
    const file = path.join(this.fixtureDir, `${key}.json`);
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      const message = `MOCK_LLM fixture missing for key ${key}. ` +
        `Add a JSON file at: ${file}\n` +
        `Or seed via client.set('${key}', { output, inputTokens, outputTokens }).`;
      const log = await getLogger();
      log.warn({ key, file }, 'MOCK_LLM fixture not found');
      throw new LLMError('MOCK_LLM_NO_FIXTURE', message);
    }
    let parsed: MockFixture<T>;
    try {
      parsed = JSON.parse(raw) as MockFixture<T>;
    } catch (err) {
      throw new LLMError(
        'LLM_INVALID_RESPONSE',
        `MOCK_LLM fixture at ${file} is not valid JSON: ${(err as Error).message}`
      );
    }
    return this.toResult(parsed, req);
  }

  private toResult<T>(fixture: MockFixture<T>, req: LlmCallRequest): LlmCallResult<T> {
    req.onPhase?.({ phase: 'streaming', message: 'Streaming MOCK response…' });
    req.onPhase?.({ phase: 'finalizing', message: 'Finalizing structured output…' });
    const cost = costEstimateUsd(this.provider, req.model, fixture.inputTokens, fixture.outputTokens);
    return {
      output: fixture.output,
      inputTokens: fixture.inputTokens,
      outputTokens: fixture.outputTokens,
      model: req.model,
      provider: this.provider,
      costEstimateUsd: cost
    };
  }
}
