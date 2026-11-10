/**
 * Real-API mode of the eval (V2_STAGE4_SPEC 4c.2 / 4c.3). The ONLY place eval
 * code reads a real API key or builds a real Anthropic client.
 *
 * Privacy (4c.2): a private case can never reach a real API. A case is
 * refused (`PrivateCaseError`, before any client exists) when ANY of these
 * holds: the loader marked it `visibility: 'private'`; its id is listed in
 * the private corpus file (`eval/corpus.local.json`, untracked — the private
 * ids never appear in tracked code); its repo is a local path (only private
 * cases may use one).
 *
 * Key (4c.3): read from `<repo>/.env` by code only, with `util.parseEnv`
 * on the file text, picking `ANTHROPIC_API_KEY` and nothing else. Deviation
 * from the spec's `process.loadEnvFile`: that would copy every `.env` entry
 * into `process.env` (e.g. `TOKEN_BUDGET_*`, which the v1 services read) and
 * change what the eval measures. A key already in the environment wins.
 * The key is never logged, printed or persisted; errors name the variable,
 * never its value.
 *
 * Every real client goes through the spend gate and has `maxRetries: 0`.
 */
import { promises as fs } from 'fs';
import { parseEnv } from 'util';
import Anthropic from '@anthropic-ai/sdk';
// Relative imports on purpose (not `@/…`): vite-node has no alias (see predict-v1.ts, R1).
import { AnthropicAdapter, ANTHROPIC_TIMEOUT_MS, buildRequestParams, type AnthropicLike } from '../../src/lib/llm/anthropic';
import { AnthropicAgentModel, buildAgentRequestParams } from '../../src/lib/llm/agentAnthropic';
import type { LLMClient, LlmCallRequest } from '../../src/lib/llm/client';
import type { AgentModel, AgentTurnRequest } from '../../src/core/agent/model';
import type { SpendGate } from '../../src/core/agent/loop';
import { SpendGuard } from '../../src/core/spend/gate';
import { SpendLedger } from '../../src/core/spend/ledger';
import { isLocalPath } from './corpus';
import type { LoadedCase, SpendInfo } from './types';

export const API_KEY_VAR = 'ANTHROPIC_API_KEY';
/** `count_tokens` is a separate, free endpoint; a short timeout keeps a stall from blocking the run (fallback = local bound). */
export const COUNT_TOKENS_TIMEOUT_MS = 30_000;

export class PrivateCaseError extends Error {
  constructor(caseId: string, why: string) {
    // The id is the one the caller passed; the message never adds case details.
    super(`refusing real API for case "${caseId}": ${why}. Private cases run only with the mock or the deterministic predictors.`);
    this.name = 'PrivateCaseError';
  }
}

export class MissingApiKeyError extends Error {
  constructor(where: string) {
    super(`${API_KEY_VAR} is not set (looked in the environment and ${where}); real runs need it`);
    this.name = 'MissingApiKeyError';
  }
}

/** Ids of the private corpus file. Missing file → empty set; unreadable JSON → error (never silently "public"). */
export async function loadPrivateIds(localFile: string): Promise<Set<string>> {
  let text: string;
  try {
    text = await fs.readFile(localFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw err;
  }
  const parsed = JSON.parse(text) as { cases?: Array<{ id?: unknown }> };
  return new Set((parsed.cases ?? []).map((c) => c.id).filter((id): id is string => typeof id === 'string'));
}

type PrivacyView = Pick<LoadedCase, 'id' | 'repo' | 'visibility'>;

export function assertPublicCase(c: PrivacyView, privateIds: ReadonlySet<string>): void {
  if (c.visibility === 'private') throw new PrivateCaseError(c.id, 'the case is private');
  if (privateIds.has(c.id)) throw new PrivateCaseError(c.id, 'the id is in the private corpus');
  if (isLocalPath(c.repo)) throw new PrivateCaseError(c.id, 'the repo is a local path');
}

export function assertPublicCases(cases: readonly PrivacyView[], privateIds: ReadonlySet<string>): void {
  for (const c of cases) assertPublicCase(c, privateIds);
}

/** The key from the environment, else from `envFile` (parsed in code). Throws `MissingApiKeyError`. */
export async function loadApiKey(envFile: string, env: Readonly<Record<string, string | undefined>> = process.env): Promise<string> {
  const fromEnv = env[API_KEY_VAR];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  let text: string;
  try {
    text = await fs.readFile(envFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new MissingApiKeyError('the .env file (not found)');
    throw new MissingApiKeyError('the .env file (unreadable)');
  }
  const value = parseEnv(text)[API_KEY_VAR];
  if (typeof value !== 'string' || value.trim() === '') throw new MissingApiKeyError('the .env file');
  return value.trim();
}

/** The slice of the SDK a real eval client needs (messages + count_tokens); the real `Anthropic` satisfies it. */
export interface RealSdkLike extends AnthropicLike {
  messages: AnthropicLike['messages'] & {
    countTokens(params: Anthropic.MessageCountTokensParams, options?: Anthropic.RequestOptions): PromiseLike<Anthropic.MessageTokensCount>;
  };
}

export function createRealSdk(apiKey: string): RealSdkLike {
  return new Anthropic({ apiKey, timeout: ANTHROPIC_TIMEOUT_MS, maxRetries: 0 });
}

function countParams(p: Anthropic.MessageStreamParams): Anthropic.MessageCountTokensParams {
  return {
    model: p.model,
    messages: p.messages,
    ...(p.system !== undefined ? { system: p.system } : {}),
    ...(p.tools !== undefined ? { tools: p.tools } : {}),
    ...(p.tool_choice !== undefined ? { tool_choice: p.tool_choice } : {}),
    // Our requests only set `effort` (no output format), so only that is counted.
    ...(p.output_config?.effort != null ? { output_config: { effort: p.output_config.effort } } : {})
  };
}

export interface RealEvalClient {
  llm: LLMClient;
  agentModel: AgentModel;
  agentGate: SpendGate;
}

/**
 * Real, gated clients for ONE case. Throws `PrivateCaseError` before anything
 * is constructed when the case is private.
 */
export function createRealEvalClient(opts: {
  evalCase: PrivacyView;
  privateIds: ReadonlySet<string>;
  guard: SpendGuard;
  apiKey: string;
  /** Test seam: a fake SDK (fake transport). */
  sdkFactory?: (apiKey: string) => RealSdkLike;
}): RealEvalClient {
  assertPublicCase(opts.evalCase, opts.privateIds);
  const sdk = (opts.sdkFactory ?? createRealSdk)(opts.apiKey);
  const count = async (params: Anthropic.MessageStreamParams): Promise<number> =>
    (await sdk.messages.countTokens(countParams(params), { timeout: COUNT_TOKENS_TIMEOUT_MS, maxRetries: 0 })).input_tokens;
  opts.guard.caseId = opts.evalCase.id;
  const adapter = new AnthropicAdapter({ apiKey: opts.apiKey, client: sdk });
  return {
    llm: opts.guard.wrapLlmClient(adapter, (req: LlmCallRequest) => count(buildRequestParams(req))),
    agentModel: new AnthropicAgentModel({ apiKey: opts.apiKey, client: sdk, maxRetries: 0 }),
    agentGate: opts.guard.agentGate((req: AgentTurnRequest) => count(buildAgentRequestParams(req)))
  };
}

/** Matches strings shaped like an Anthropic key, for output scans in tests. */
export const KEY_SHAPE_RE = /sk-ant-[A-Za-z0-9_-]{8,}/;

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

export interface RealSession {
  guard: SpendGuard;
  ledger: SpendLedger;
  /** Gated real clients for one case (privacy re-checked per case). */
  clientFor(c: PrivacyView): RealEvalClient;
  /** True once the gate refused a request: later cases are not run. */
  stopped(): boolean;
  spendInfo(): SpendInfo;
  /** Prints the end state and releases the ledger lock. */
  close(): Promise<void>;
}

/**
 * Starts a `--real` run: privacy check of every selected case, key, ledger
 * lock, start-state print. Order matters: privacy and key are checked before
 * the ledger is opened, so a refused run leaves no trace and sends nothing.
 */
export async function startRealSession(opts: {
  cases: readonly PrivacyView[];
  privateIds: ReadonlySet<string>;
  envFile: string;
  env?: Readonly<Record<string, string | undefined>>;
  ledgerPath: string;
  step: string;
  ceilingUsd?: number;
  log: (line: string) => void;
  sdkFactory?: (apiKey: string) => RealSdkLike;
}): Promise<RealSession> {
  assertPublicCases(opts.cases, opts.privateIds);
  const apiKey = await loadApiKey(opts.envFile, opts.env);
  const ledger = await SpendLedger.open(opts.ledgerPath);
  const guard = new SpendGuard({ ledger, step: opts.step, ...(opts.ceilingUsd !== undefined ? { ceilingUsd: opts.ceilingUsd } : {}) });
  const before = ledger.state();
  const print = (when: string) => {
    const s = ledger.state();
    opts.log(
      `spend ledger ${s.roundId} (${when}): spent ${usd(s.spentUsd)} · reserved ${usd(s.reservedUsd)} · remaining ${usd(s.remainingUsd)} of $${s.capUsd}` +
        (opts.ceilingUsd !== undefined ? ` · step ceiling $${Math.min(opts.ceilingUsd, s.capUsd)}` : '')
    );
  };
  print('start');
  let closed = false;
  return {
    guard,
    ledger,
    clientFor: (c) =>
      createRealEvalClient({ evalCase: c, privateIds: opts.privateIds, guard, apiKey, ...(opts.sdkFactory !== undefined ? { sdkFactory: opts.sdkFactory } : {}) }),
    stopped: () => guard.refusals > 0,
    spendInfo: () => {
      const s = ledger.state();
      return {
        roundId: s.roundId,
        capUsd: s.capUsd,
        spentBefore: before.spentUsd,
        spentAfter: s.spentUsd,
        reservedAfter: s.reservedUsd,
        refusals: guard.refusals,
        requests: guard.sent
      };
    },
    close: async () => {
      if (closed) return;
      closed = true;
      print('end');
      if (guard.refusals > 0) opts.log(`STOPPED_AT_CAP: the gate refused ${guard.refusals} request(s): ${guard.lastRefusal ?? ''}`);
      if (guard.countFailures > 0) opts.log(`count_tokens failed ${guard.countFailures} time(s); the local upper bound was used`);
      await ledger.close();
    }
  };
}
