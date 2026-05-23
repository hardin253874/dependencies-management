/**
 * LLM client factory + per-provider concurrency.
 *
 * Spec §5.4: API keys can change at runtime via `POST /api/config/api-key`.
 * The factory exposes `resetLlmClient()` so the route handler can drop the
 * cached instance and force a fresh build on the next call.
 *
 * Spec §10.8: max 2 concurrent calls per provider. Each provider gets its own
 * `p-limit` instance; callers wrap their request via `withLlmLimit`.
 *
 * Spec §11.12: when `MOCK_LLM=true` we always return a `MockLLMClient`,
 * regardless of provider. Tests seed fixtures via the singleton.
 */
import pLimit from 'p-limit';
import type { LlmProvider } from '../api-types';
import { loadEnv } from '../config';
import { readConfig } from '../storage/config';
import { LLMError, type LLMClient } from './client';
import { AnthropicAdapter } from './anthropic';
import { OpenAIAdapter } from './openai';
import { MockLLMClient } from './mock';

const LLM_CONCURRENCY_PER_PROVIDER = 2;

const limits: Map<LlmProvider, ReturnType<typeof pLimit>> = new Map();

function limitFor(provider: LlmProvider): ReturnType<typeof pLimit> {
  let l = limits.get(provider);
  if (l === undefined) {
    l = pLimit(LLM_CONCURRENCY_PER_PROVIDER);
    limits.set(provider, l);
  }
  return l;
}

export function withLlmLimit<T>(provider: LlmProvider, fn: () => Promise<T>): Promise<T> {
  return limitFor(provider)(fn);
}

// Stash the cached client + signature on `globalThis` so all route bundles
// share a single LLM client (same pattern as queue / csrf / logger — Next.js
// dev evaluates this module per-route bundle and a module-scoped `let`
// would otherwise produce a separate client per route).
declare global {
  // eslint-disable-next-line no-var
  var __DEP_AGENT_LLM_CLIENT__: LLMClient | undefined;
  // eslint-disable-next-line no-var
  var __DEP_AGENT_LLM_SIGNATURE__: string | undefined;
}

/**
 * Build (or return cached) `LLMClient` for the configured provider. The cache
 * key is `provider + key-presence` so toggling a key triggers a rebuild.
 *
 * When MOCK_LLM=true, a `MockLLMClient` is returned and the cache holds it.
 * Tests that need to seed fixtures should call `getMockLlmClient()` (which
 * returns the same cached instance) or pass their own client via `setLlmClient`.
 */
export async function getLlmClient(): Promise<LLMClient> {
  const env = loadEnv();
  const cfg = await readConfig();
  const provider = cfg.llm.provider;
  const apiKey = provider === 'anthropic' ? env.anthropicApiKey : env.openaiApiKey;
  const signature = `${env.mockLlm ? 'mock' : provider}::${apiKey === null ? 'no-key' : 'has-key'}`;
  if (
    globalThis.__DEP_AGENT_LLM_CLIENT__ !== undefined &&
    globalThis.__DEP_AGENT_LLM_SIGNATURE__ === signature
  ) {
    return globalThis.__DEP_AGENT_LLM_CLIENT__;
  }

  let client: LLMClient;
  if (env.mockLlm) {
    client = new MockLLMClient({ provider });
  } else if (provider === 'anthropic') {
    if (apiKey === null) throw new LLMError('LLM_NO_API_KEY', 'Anthropic API key not configured.');
    client = new AnthropicAdapter({ apiKey });
  } else if (provider === 'openai') {
    if (apiKey === null) throw new LLMError('LLM_NO_API_KEY', 'OpenAI API key not configured.');
    client = new OpenAIAdapter({ apiKey });
  } else {
    throw new LLMError('LLM_UNSUPPORTED_PROVIDER', `Unknown provider: ${provider as string}`);
  }
  globalThis.__DEP_AGENT_LLM_CLIENT__ = client;
  globalThis.__DEP_AGENT_LLM_SIGNATURE__ = signature;
  return client;
}

/** Spec §5.4: route handler calls this after rewriting `.env`. */
export function resetLlmClient(): void {
  globalThis.__DEP_AGENT_LLM_CLIENT__ = undefined;
  globalThis.__DEP_AGENT_LLM_SIGNATURE__ = undefined;
}

/**
 * Tests inject a specific client.
 *
 * **Cache-reset convention (Stage 3 review M4):** Integration tests that mutate
 * the singleton via `setLlmClient` MUST call `setLlmClient(null)` in `afterEach`.
 * Otherwise a downstream test that calls `getLlmClient()` will reuse the
 * previous test's mock and silently pick up stale fixtures. Direct construction
 * of a `MockLLMClient` (e.g. `new MockLLMClient(...)`) does NOT touch the
 * factory cache and is the preferred pattern for tests that don't need to
 * exercise the factory codepath.
 */
export function setLlmClient(client: LLMClient | null): void {
  globalThis.__DEP_AGENT_LLM_CLIENT__ = client ?? undefined;
  globalThis.__DEP_AGENT_LLM_SIGNATURE__ = client === null ? undefined : '__test__';
}

/** Tests retrieve the current mock client to seed fixtures. */
export function getMockLlmClient(): MockLLMClient | null {
  const c = globalThis.__DEP_AGENT_LLM_CLIENT__;
  return c instanceof MockLLMClient ? c : null;
}
