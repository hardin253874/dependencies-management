/**
 * Eval real-API mode (V2_STAGE4_SPEC 4c.2 privacy refusal + 4c.3 wiring).
 * Fake keys and a fake SDK transport only; no request leaves the process.
 * Case ids here are synthetic stand-ins (no private id in tracked files).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import type Anthropic from '@anthropic-ai/sdk';
import { createSandbox, type Sandbox } from '../helpers/sandbox';
import { parseArgs } from '../../../eval/lib/args';
import {
  assertPublicCase,
  createRealEvalClient,
  KEY_SHAPE_RE,
  loadApiKey,
  loadPrivateIds,
  MissingApiKeyError,
  PrivateCaseError,
  startRealSession,
  type RealSdkLike
} from '../../../eval/lib/real';
import { SpendLedger } from '@/core/spend/ledger';
import { SpendGuard } from '@/core/spend/gate';
import { SHARED_SYSTEM_PROMPT } from '@/lib/llm/prompts/shared';
import { UPDATE_REPORT_TOOL_SCHEMA } from '@/lib/llm/prompts/update-report';

const FAKE_KEY = 'sk-ant-test-FAKEFAKEFAKEFAKE0000';
const PUBLIC = { id: 'public-a', repo: 'https://github.com/example/a', visibility: 'public' as const };

let sandbox: Sandbox;
let ledgerPath: string;

function fakeSdk(): RealSdkLike & { streamed: Anthropic.MessageStreamParams[]; counted: Anthropic.MessageCountTokensParams[] } {
  const streamed: Anthropic.MessageStreamParams[] = [];
  const counted: Anthropic.MessageCountTokensParams[] = [];
  return {
    streamed,
    counted,
    messages: {
      stream(params) {
        streamed.push(params);
        const msg = {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: params.model,
          content: [{ type: 'tool_use', id: 'toolu_1', name: UPDATE_REPORT_TOOL_SCHEMA.name, input: { summary: 's' }, caller: { type: 'direct' } }],
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: { input_tokens: 800, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 1200 }
        } as unknown as Anthropic.Message;
        return { on: () => undefined, finalMessage: async () => msg };
      },
      async countTokens(params) {
        counted.push(params);
        return { input_tokens: 2100 };
      }
    }
  };
}

beforeEach(async () => {
  sandbox = await createSandbox('eval-real');
  ledgerPath = path.join(sandbox.scratchRoot, '_spend', 'stage4-round1.json');
});

afterEach(async () => {
  await sandbox.dispose();
});

describe('privacy refusal (4c.2)', () => {
  it('refuses a private case, a listed private id and a local repo path', () => {
    expect(() => assertPublicCase({ ...PUBLIC, visibility: 'private' }, new Set())).toThrow(PrivateCaseError);
    expect(() => assertPublicCase(PUBLIC, new Set(['public-a']))).toThrow(/private corpus/);
    expect(() => assertPublicCase({ ...PUBLIC, repo: 'C:\\work\\client-repo' }, new Set())).toThrow(/local path/);
    expect(() => assertPublicCase(PUBLIC, new Set(['other']))).not.toThrow();
  });

  it('throws before any client is constructed for a private case', async () => {
    const ledger = await SpendLedger.open(ledgerPath);
    try {
      let built = 0;
      expect(() =>
        createRealEvalClient({
          evalCase: { ...PUBLIC, id: 'secret-stand-in', visibility: 'private' },
          privateIds: new Set(),
          guard: new SpendGuard({ ledger, step: 't' }),
          apiKey: FAKE_KEY,
          sdkFactory: () => {
            built += 1;
            return fakeSdk();
          }
        })
      ).toThrow(PrivateCaseError);
      expect(built).toBe(0);
    } finally {
      await ledger.close();
    }
  });

  it('reads private ids from the private corpus file (missing file → none)', async () => {
    const file = path.join(sandbox.scratchRoot, 'corpus.local.json');
    expect(await loadPrivateIds(file)).toEqual(new Set());
    await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, cases: [{ id: 'secret-stand-in' }] }), 'utf8');
    expect(await loadPrivateIds(file)).toEqual(new Set(['secret-stand-in']));
  });

  it('`--real --local` is a usage error; --real replaces the mock flags', () => {
    expect(() => parseArgs(['run', '--label', 'a', '--predictor', 'v1-ai', '--real', '--local', 'x.json'])).toThrow(/--local/);
    expect(() => parseArgs(['run', '--label', 'a', '--predictor', 'v1-ai', '--real', '--mock-llm'])).toThrow(/cannot be combined/);
    expect(() => parseArgs(['run', '--label', 'a', '--predictor', 'v2-agent', '--real', '--mock-script', 's'])).toThrow(/cannot be combined/);
    expect(parseArgs(['run', '--label', 'a', '--predictor', 'v2-agent', '--real'])).toMatchObject({ ai: { real: true, mock: false } });
    expect(parseArgs(['run', '--label', 'a', '--predictor', 'v1-ai', '--real', '--stop-at-usd', '2'])).toMatchObject({ ai: { real: true, stopAtUsd: 2 } });
    expect(() => parseArgs(['run', '--label', 'a', '--predictor', 'v1-ai', '--mock-llm', '--stop-at-usd', '2'])).toThrow(/only applies with --real/);
    expect(() => parseArgs(['run', '--label', 'a', '--predictor', 'v1-ai', '--real', '--stop-at-usd', '-1'])).toThrow(/invalid --stop-at-usd/);
    expect(() => parseArgs(['run', '--label', 'a', '--real'])).toThrow(/only applies to --predictor/);
  });
});

describe('key loading (4c.3)', () => {
  it('prefers the environment, else parses only the key out of the env file', async () => {
    const envFile = path.join(sandbox.scratchRoot, 'fake.env');
    await fs.writeFile(envFile, `OTHER=1\nANTHROPIC_API_KEY=${FAKE_KEY}\n`, 'utf8');
    const env: Record<string, string | undefined> = {};
    expect(await loadApiKey(envFile, env)).toBe(FAKE_KEY);
    expect(env.OTHER).toBeUndefined();
    expect(await loadApiKey(envFile, { ANTHROPIC_API_KEY: 'sk-ant-from-env-XXXXXXXX' })).toBe('sk-ant-from-env-XXXXXXXX');
  });

  it('refuses without a key and never puts a key in the message', async () => {
    const envFile = path.join(sandbox.scratchRoot, 'nokey.env');
    await fs.writeFile(envFile, 'OTHER=1\n', 'utf8');
    await expect(loadApiKey(envFile, {})).rejects.toThrow(MissingApiKeyError);
    await expect(loadApiKey(path.join(sandbox.scratchRoot, 'missing.env'), {})).rejects.toThrow(/not found/);
  });
});

describe('real session wiring (4c.3)', () => {
  async function session(over: { envFile?: string; cases?: Array<typeof PUBLIC> } = {}) {
    const envFile = over.envFile ?? path.join(sandbox.scratchRoot, 'fake.env');
    if (over.envFile === undefined) await fs.writeFile(envFile, `ANTHROPIC_API_KEY=${FAKE_KEY}\n`, 'utf8');
    const lines: string[] = [];
    const sdk = fakeSdk();
    const s = await startRealSession({
      cases: over.cases ?? [PUBLIC],
      privateIds: new Set(),
      envFile,
      env: {},
      ledgerPath,
      step: 'test',
      ceilingUsd: 2,
      log: (l) => lines.push(l),
      sdkFactory: (key) => {
        expect(key).toBe(FAKE_KEY);
        return sdk;
      }
    });
    return { s, lines, sdk };
  }

  it('sends a public request through the gate (count → reserve → send → settle) and prints the ledger at start and end', async () => {
    const { s, lines, sdk } = await session();
    const rc = s.clientFor(PUBLIC);
    const res = await rc.llm.call({ model: 'claude-sonnet-5-5', systemPrompt: SHARED_SYSTEM_PROMPT, userPrompt: 'u', tool: UPDATE_REPORT_TOOL_SCHEMA, maxOutputTokens: 6000, effort: 'medium' });
    expect(res.output).toEqual({ summary: 's' });
    expect(sdk.counted).toHaveLength(1);
    expect(sdk.counted[0]).not.toHaveProperty('max_tokens');
    expect(sdk.streamed).toHaveLength(1);
    const info = s.spendInfo();
    expect(info).toMatchObject({ roundId: 'stage4-round1', capUsd: 10, spentBefore: 0, refusals: 0, requests: 1, reservedAfter: 0 });
    expect(info.spentAfter).toBeGreaterThan(0);
    await s.close();
    expect(lines[0]).toMatch(/spend ledger stage4-round1 \(start\): spent \$0\.0000/);
    expect(lines.some((l) => /\(end\): spent \$0\.0/.test(l))).toBe(true);
    for (const l of lines) expect(l).not.toMatch(KEY_SHAPE_RE);
  });

  it('stops after a refusal: the ceiling is hit, nothing is sent, STOPPED_AT_CAP is printed', async () => {
    const { s, lines, sdk } = await session();
    const rc = s.clientFor(PUBLIC);
    await expect(
      rc.llm.call({ model: 'claude-opus-5-5', systemPrompt: 's', userPrompt: 'u', tool: UPDATE_REPORT_TOOL_SCHEMA, maxOutputTokens: 200_000, effort: 'medium' })
    ).rejects.toThrow(/spend cap/);
    expect(sdk.streamed).toHaveLength(0);
    expect(s.stopped()).toBe(true);
    await s.close();
    expect(lines.some((l) => l.startsWith('STOPPED_AT_CAP'))).toBe(true);
  });

  it('refuses to start without a key, before the ledger is created', async () => {
    const envFile = path.join(sandbox.scratchRoot, 'nokey.env');
    await fs.writeFile(envFile, 'X=1\n', 'utf8');
    await expect(session({ envFile })).rejects.toThrow(MissingApiKeyError);
    await expect(fs.access(ledgerPath)).rejects.toThrow();
  });

  it('refuses a private case before the key or the ledger are touched', async () => {
    await expect(session({ cases: [{ ...PUBLIC, visibility: 'private' as never }] })).rejects.toThrow(PrivateCaseError);
    await expect(fs.access(ledgerPath)).rejects.toThrow();
  });

  it('the agent model and gate of a real client share the ledger', async () => {
    const { s, sdk } = await session();
    const rc = s.clientFor(PUBLIC);
    const request = { model: 'claude-sonnet-5-5', system: 'sys', tools: [], messages: [{ role: 'user' as const, content: 'go' }], maxTokens: 1000, effort: 'medium' as const };
    const verdict = await rc.agentGate.beforeRequest({ model: request.model, inputTokensUpperBound: 10, maxTokens: 1000, projectedUsd: 0, request });
    expect(verdict.allowed).toBe(true);
    const out = await rc.agentModel.turn(request);
    await rc.agentGate.afterResponse({ model: out.model, usage: out.usage });
    expect(sdk.counted).toHaveLength(1);
    expect(s.spendInfo()).toMatchObject({ requests: 1, reservedAfter: 0 });
    await s.close();
  });
});
