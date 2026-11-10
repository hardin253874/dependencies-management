/**
 * Judge client seam (V2_STAGE5_SPEC 5b.2): one `JudgeClient` interface, a
 * TypeSafe implementation (`@typesafe-ai/sdk` 0.7.0) and a mock (`mock.ts`).
 *
 * The TypeSafe client is built with EVERY security-relevant option passed
 * explicitly (D31, proposed). The SDK reads `TYPESAFE_API_KEY`,
 * `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL` and `TYPESAFE_LOG_LEVEL` only
 * when an option is omitted (verified in the installed `dist/index.mjs`:
 * `fromCodeOrEnv(config.x, ENV.x)` = `config.x ?? env`), so no env var can
 * redirect the key, log request bodies (`debug` logs them unredacted) or
 * change the model. Also explicit:
 * - `retry.maxRetries: 0`: every attempt must pass the Jev ledger;
 * - `compression: false`: the SDK zstd-compresses bodies ≥ 1 KiB on Node ≥
 *   22.15; uncompressed keeps the ledger's byte estimate = the bytes sent and
 *   lets a fake fetch inspect the body in tests (Jev prices input tokens, not
 *   bytes, so this costs nothing).
 */
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  RateLimitError,
  TypeSafeClient,
  type Fetch,
  type Logger,
  type Question,
  type TypeSafeClientConfig
} from '@typesafe-ai/sdk';
import { JudgeUnavailableError, type JudgeAnswer, type JudgeUse, type JudgeUnavailableReason } from './types';
import { requestBoundTokens } from './payload';
import { JevSpendCapError, isJevPriced, type JevSpendGate } from './ledger';

import { JEV_BASE_URL, JEV_MODEL, JEV_TIMEOUT_MS } from './constants';

export { JEV_BASE_URL, JEV_MODEL, JEV_TIMEOUT_MS, ROUTER_TIMEOUT_MS } from './constants';

export interface JudgeAskInput {
  use: JudgeUse;
  state: Record<string, unknown>;
  questions: Record<string, Question>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface JudgeAskOutput {
  answers: Record<string, JudgeAnswer>;
  model: string;
  usage: { inputTokens: number | null };
  latencyMs: number;
}

export interface JudgeClient {
  readonly kind: 'typesafe' | 'mock';
  ask(input: JudgeAskInput): Promise<JudgeAskOutput>;
}

/** Log sink that never sees bodies: the SDK only logs bodies at `debug`, and we run at `error`. */
export interface JudgeLogSink {
  error(fields: Record<string, unknown>, message: string): void;
}

export function buildTypeSafeConfig(opts: { apiKey: string; log?: JudgeLogSink; fetch?: Fetch }): TypeSafeClientConfig {
  const sink = opts.log;
  // Only the message string is forwarded; structured args (which could carry a body at debug) are dropped.
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (message: string) => sink?.error({ scope: 'jev' }, String(message).slice(0, 300))
  };
  return {
    apiKey: opts.apiKey,
    baseURL: JEV_BASE_URL,
    defaultModel: JEV_MODEL,
    logLevel: 'error',
    logger,
    retry: { maxRetries: 0 },
    timeout: JEV_TIMEOUT_MS,
    compression: false,
    defaultHeaders: {},
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {})
  };
}

export function unavailableFrom(err: unknown): JudgeUnavailableError {
  if (err instanceof JudgeUnavailableError) return err;
  let reason: JudgeUnavailableReason = 'other';
  if (err instanceof JevSpendCapError) reason = 'ledger';
  else if (err instanceof APIUserAbortError) reason = 'aborted';
  else if (err instanceof APITimeoutError) reason = 'timeout';
  else if (err instanceof APIConnectionError) reason = 'connection';
  else if (err instanceof RateLimitError) reason = 'rate-limit';
  else if (err instanceof AuthenticationError) reason = 'auth';
  else if (err instanceof APIError) reason = err.status === 529 ? 'overloaded' : err.status >= 500 ? 'server' : err.status === 400 || err.status === 413 || err.status === 422 ? 'bad-request' : 'other';
  else if (err instanceof Error && err.name === 'JevLedgerLockError') reason = 'ledger';
  // Message names the class only: an SDK error message may quote a response body.
  const name = err instanceof Error ? err.name : typeof err;
  return new JudgeUnavailableError(reason, `Jev unavailable (${reason}: ${name})`, { cause: err });
}

export class TypeSafeJudgeClient implements JudgeClient {
  readonly kind = 'typesafe' as const;
  private readonly client: TypeSafeClient;

  constructor(private readonly opts: { apiKey: string; gate: JevSpendGate; log?: JudgeLogSink; fetch?: Fetch; model?: string }) {
    this.client = new TypeSafeClient(buildTypeSafeConfig(opts));
  }

  get model(): string {
    return this.opts.model ?? JEV_MODEL;
  }

  async ask(input: JudgeAskInput): Promise<JudgeAskOutput> {
    const model = this.model;
    if (!isJevPriced(model)) throw new JudgeUnavailableError('ledger', `unpriced Jev model ${model}: refused`);
    let reservation: string;
    try {
      reservation = await this.opts.gate.reserve({ use: input.use, model, boundTokens: requestBoundTokens(model, input.state, input.questions) });
    } catch (err) {
      throw unavailableFrom(err);
    }
    const started = Date.now();
    let result;
    try {
      result = await this.client.systemOne(
        { state: input.state as never, questions: input.questions, model },
        { ...(input.signal !== undefined ? { signal: input.signal } : {}), timeout: input.timeoutMs ?? JEV_TIMEOUT_MS, retry: { maxRetries: 0 } }
      );
    } catch (err) {
      // No usage on an error: the reservation stays counted.
      throw unavailableFrom(err);
    }
    const latencyMs = Date.now() - started;
    const inputTokens = result.usage?.input_tokens ?? null;
    if (inputTokens !== null) await this.opts.gate.settle(reservation, { model: result.model, inputTokens });
    return { answers: result.answers as Record<string, JudgeAnswer>, model: result.model, usage: { inputTokens }, latencyMs };
  }
}
