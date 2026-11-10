/**
 * 5b.1 smoke (installed @typesafe-ai/sdk 0.7.0 against a fake fetch) and
 * 5b.2 client options: every option explicit, env vars cannot redirect the
 * key, dump bodies or change the model. No network: every request goes to
 * the fake fetch.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { TypeSafeClient, noul, choice, score, VERSION } from '@typesafe-ai/sdk';
import { buildTypeSafeConfig, JEV_BASE_URL, JEV_MODEL, JEV_TIMEOUT_MS, TypeSafeJudgeClient } from '@/core/judge/client';
import { JudgeUnavailableError } from '@/core/judge/types';
import type { JevSpendGate } from '@/core/judge/ledger';

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeFetch(seen: Seen[], response: () => Response = () => okBody()): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    seen.push({ url: input, headers, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    return response();
  };
}

function okBody(model = JEV_MODEL, inputTokens: number | null = 120): Response {
  return new Response(JSON.stringify({ model, answers: { billing: { type: 'noul', noul: 0.98 } }, usage: { input_tokens: inputTokens, output_tokens: 12 } }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

function gate(): JevSpendGate & { reserved: number; settled: Array<{ id: string; inputTokens: number }> } {
  const g = {
    reserved: 0,
    settled: [] as Array<{ id: string; inputTokens: number }>,
    reserve: async () => {
      g.reserved += 1;
      return `r${g.reserved}`;
    },
    settle: async (id: string, s: { inputTokens: number }) => {
      g.settled.push({ id, inputTokens: s.inputTokens });
    }
  };
  return g;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('5b.1 installed SDK smoke', () => {
  it('is 0.7.0 and posts to /v1/systemone with a bearer key (fake fetch)', async () => {
    expect(VERSION).toBe('0.7.0');
    const seen: Seen[] = [];
    const client = new TypeSafeClient({ apiKey: 'test', fetch: fakeFetch(seen), compression: false, logLevel: 'off' });
    const res = await client.systemOne({ state: 'I was charged twice.', questions: { billing: noul('Is this about billing?') } });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(seen[0]!.headers.authorization).toBe('Bearer test');
    expect(res.answers.billing.noul).toBe(0.98);
    expect(res.usage.input_tokens).toBe(120);
  });

  it('helper shapes: choice criteria map, score criteria list, noul instructions', () => {
    expect(choice('q', { a: null, b: 'B' })).toEqual({ type: 'choice', instructions: 'q', criteria: { a: null, b: 'B' } });
    expect(score('q', ['lo', 'hi'])).toEqual({ type: 'score', instructions: 'q', criteria: ['lo', 'hi'] });
    expect(noul('q')).toMatchObject({ type: 'noul', instructions: 'q' });
  });
});

describe('5b.2 TypeSafe judge client options', () => {
  it('passes every security-relevant option explicitly', () => {
    const cfg = buildTypeSafeConfig({ apiKey: 'k' });
    expect({ ...cfg, logger: typeof cfg.logger }).toEqual({
      apiKey: 'k',
      baseURL: JEV_BASE_URL,
      defaultModel: JEV_MODEL,
      logLevel: 'error',
      logger: 'object',
      retry: { maxRetries: 0 },
      timeout: JEV_TIMEOUT_MS,
      compression: false,
      defaultHeaders: {}
    });
    expect(JEV_MODEL).toBe('jev-1.14.0');
  });

  it('TYPESAFE_* env vars do not change URL, model or key, and no body reaches the logger', async () => {
    vi.stubEnv('TYPESAFE_BASE_URL', 'https://evil.example');
    vi.stubEnv('TYPESAFE_LOG_LEVEL', 'debug');
    vi.stubEnv('TYPESAFE_DEFAULT_MODEL', 'jev-latest');
    vi.stubEnv('TYPESAFE_API_KEY', 'env-key-should-not-be-used');
    const seen: Seen[] = [];
    const logged: string[] = [];
    const g = gate();
    const client = new TypeSafeJudgeClient({ apiKey: 'explicit', gate: g, fetch: fakeFetch(seen), log: { error: (_f, m) => logged.push(m) } });
    const out = await client.ask({ use: 'router', state: { view: 'agent', marker: 'BODY-MARKER-xyz' }, questions: { billing: noul('q?') } });
    expect(seen[0]!.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(seen[0]!.headers.authorization).toBe('Bearer explicit');
    expect(seen[0]!.body.model).toBe('jev-1.14.0');
    expect(seen[0]!.headers['content-encoding']).toBeUndefined();
    expect(logged.join('\n')).not.toContain('BODY-MARKER');
    expect(out.model).toBe('jev-1.14.0');
    expect(g.reserved).toBe(1);
    expect(g.settled).toEqual([{ id: 'r1', inputTokens: 120 }]);
  });

  it('no retries: a 529 is one fetch, mapped to JudgeUnavailableError(overloaded); the reservation stays (no settle)', async () => {
    const seen: Seen[] = [];
    const g = gate();
    const client = new TypeSafeJudgeClient({ apiKey: 'k', gate: g, fetch: fakeFetch(seen, () => new Response('{"error":"busy"}', { status: 529 })) });
    const err = await client.ask({ use: 'J5', state: { a: 1 }, questions: { x: noul('q?') } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JudgeUnavailableError);
    expect((err as JudgeUnavailableError).reason).toBe('overloaded');
    expect(seen).toHaveLength(1);
    expect(g.settled).toHaveLength(0);
  });

  it.each([
    [429, 'rate-limit'],
    [401, 'auth'],
    [400, 'bad-request'],
    [500, 'server']
  ])('HTTP %i → %s', async (status, reason) => {
    const g = gate();
    const client = new TypeSafeJudgeClient({ apiKey: 'k', gate: g, fetch: fakeFetch([], () => new Response('{}', { status })) });
    const err = (await client.ask({ use: 'J5', state: { a: 1 }, questions: { x: noul('q?') } }).catch((e: unknown) => e)) as JudgeUnavailableError;
    expect(err.reason).toBe(reason);
  });

  it('null usage keeps the reservation (no settle)', async () => {
    const g = gate();
    const client = new TypeSafeJudgeClient({ apiKey: 'k', gate: g, fetch: fakeFetch([], () => okBody(JEV_MODEL, null)) });
    await client.ask({ use: 'J5', state: { a: 1 }, questions: { billing: noul('q?') } });
    expect(g.reserved).toBe(1);
    expect(g.settled).toHaveLength(0);
  });

  it('an unpriced model is refused before any fetch', async () => {
    const seen: Seen[] = [];
    const g = gate();
    const client = new TypeSafeJudgeClient({ apiKey: 'k', gate: g, fetch: fakeFetch(seen), model: 'jev-latest' });
    const err = (await client.ask({ use: 'J5', state: { a: 1 }, questions: { x: noul('q?') } }).catch((e: unknown) => e)) as JudgeUnavailableError;
    expect(err.reason).toBe('ledger');
    expect(seen).toHaveLength(0);
    expect(g.reserved).toBe(0);
  });
});
