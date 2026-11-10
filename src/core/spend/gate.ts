/**
 * Spend gate (V2_STAGE4_SPEC 4c.1): every real request passes here BEFORE it
 * is sent and again after it returns.
 *
 * before: estimate = input tokens (`countTokens` for the exact request when a
 *   counter is given and answers, else the local bound `ceil(bytes / 2)`)
 *   × the WORST input price of the model (5-minute cache write, 1.25× the
 *   uncached price; Haiku 5.5 switches to the > 100k tier when the estimate
 *   passes 100k) + `max_tokens` × output price, all × 1.10. The ledger
 *   refuses (`SpendCapError`, nothing sent) when spent + reserved + estimate
 *   would pass the cap, else it writes a `reserve` entry first.
 *   Deviation from the spec text ("uncached input price"): the first request
 *   of a run writes the cache at 1.25× input, which the 1.10 margin does not
 *   cover; the cache-write price is the true upper bound.
 * after: cost from the API-reported usage (`costEstimateUsd`) settles the
 *   reservation. A request that throws keeps its reservation (the SDK errors
 *   carry no usage), so an unknown spend is counted at its upper bound.
 *
 * Models without a pricing row are refused: the cost table's fallback price
 * is for display, never for a hard cap.
 *
 * Clients behind the gate must be built with `maxRetries: 0` so every attempt
 * passes the gate (an SDK retry would send a request nobody reserved).
 */
// Relative imports: src/core has no `@/` alias (D23).
import { costEstimateUsd, knownModels, pricingFor, type TokenUsage } from '../../lib/llm/cost';
import type { LLMClient, LlmCallRequest, LlmCallResult } from '../../lib/llm/client';
import type { AgentTurnRequest } from '../agent/model';
import type { RequestEstimate, SpendGate } from '../agent/loop';
import { SpendCapError, type SpendLedger } from './ledger';

export const SAFETY_MARGIN = 1.1;

/** Input tokens of one request, from the API's token counter. */
export type CountTokens<R> = (req: R) => Promise<number>;

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

export function isPricedModel(model: string): boolean {
  return knownModels().includes(model);
}

/** Worst-case cost of one request (see the file header). Throws `SpendCapError` for an unpriced model. */
export function estimateRequestUsd(model: string, inputTokens: number, maxTokens: number): number {
  if (!isPricedModel(model)) throw new SpendCapError(`spend gate: model "${model}" has no pricing row; refusing (no fallback price under a hard cap)`);
  const p = pricingFor(model, { inputTokens, outputTokens: 0 });
  const inPrice = Math.max(p.inputPerMillion, p.cacheWrite5mPerMillion);
  return round6(((inputTokens * inPrice + maxTokens * p.outputPerMillion) / 1_000_000) * SAFETY_MARGIN);
}

export function localTokenBound(...parts: readonly string[]): number {
  let bytes = 0;
  for (const p of parts) bytes += Buffer.byteLength(p, 'utf8');
  return Math.ceil(bytes / 2);
}

export interface SpendGuardOptions {
  ledger: SpendLedger;
  /** Ledger `step` label (e.g. `4c.5-v1ai`). */
  step: string;
  /** Optional lower limit for this step; never raises `CAP_USD`. */
  ceilingUsd?: number;
}

/**
 * One guard per real run. `caseId` is set by the caller before each case so
 * ledger entries say what they paid for (public case ids only).
 */
export class SpendGuard {
  caseId: string | undefined;
  refusals = 0;
  lastRefusal: string | undefined;
  /** Requests that passed the gate (reserved). */
  sent = 0;
  countFailures = 0;

  constructor(private readonly opts: SpendGuardOptions) {}

  get ledger(): SpendLedger {
    return this.opts.ledger;
  }

  /** Reserves the worst-case cost or throws `SpendCapError`. */
  async reserve(model: string, inputTokens: number, maxTokens: number): Promise<string> {
    try {
      const usd = estimateRequestUsd(model, inputTokens, maxTokens);
      const id = await this.opts.ledger.reserve({
        step: this.opts.step,
        ...(this.caseId !== undefined ? { caseId: this.caseId } : {}),
        model,
        usd,
        ...(this.opts.ceilingUsd !== undefined ? { ceilingUsd: this.opts.ceilingUsd } : {})
      });
      this.sent += 1;
      return id;
    } catch (err) {
      if (err instanceof SpendCapError) {
        this.refusals += 1;
        this.lastRefusal = err.message;
      }
      throw err;
    }
  }

  async settle(id: string, requestedModel: string, responseModel: string, usage: Required<TokenUsage>): Promise<void> {
    // A response model id without a row (e.g. a dated alias) is priced as the requested model, never the fallback.
    const model = isPricedModel(responseModel) ? responseModel : requestedModel;
    await this.opts.ledger.settle(id, { model, usd: costEstimateUsd(model, usage), usage });
  }

  /** Input-token estimate: the counter when it answers, else the local bound (never less conservative). */
  async inputEstimate<R>(req: R, bound: number, count: CountTokens<R> | undefined): Promise<number> {
    if (count === undefined) return bound;
    try {
      const n = await count(req);
      if (Number.isFinite(n) && n > 0) return n;
    } catch {
      // count_tokens is rate-limited separately; a failure falls back to the local bound.
    }
    this.countFailures += 1;
    return bound;
  }

  /** `SpendGate` for the agent loop (`runAgent`). One run at a time per gate. */
  agentGate(count?: CountTokens<AgentTurnRequest>): SpendGate {
    let pending: { id: string; model: string } | null = null;
    return {
      beforeRequest: async (estimate: RequestEstimate) => {
        // A pending reservation here means the previous request threw: it stays reserved.
        pending = null;
        const tokens = await this.inputEstimate(estimate.request, estimate.inputTokensUpperBound, count);
        try {
          pending = { id: await this.reserve(estimate.model, tokens, estimate.maxTokens), model: estimate.model };
          return { allowed: true };
        } catch (err) {
          if (err instanceof SpendCapError) return { allowed: false, reason: err.message };
          throw err;
        }
      },
      afterResponse: async (r) => {
        const p = pending;
        pending = null;
        if (p === null) throw new Error('spend gate: response without a reservation');
        await this.settle(p.id, p.model, r.model, r.usage);
      }
    };
  }

  /** Wraps a v1 single-shot client: reserve → call → settle (an error keeps the reservation). */
  wrapLlmClient(inner: LLMClient, count?: CountTokens<LlmCallRequest>): LLMClient {
    return {
      provider: inner.provider,
      call: async <T = unknown>(req: LlmCallRequest): Promise<LlmCallResult<T>> => {
        const bound = localTokenBound(req.systemPrompt, req.userPrompt, JSON.stringify(req.tool));
        const tokens = await this.inputEstimate(req, bound, count);
        const id = await this.reserve(req.model, tokens, req.maxOutputTokens);
        const res = await inner.call<T>(req);
        await this.settle(id, req.model, res.model, {
          inputTokens: res.inputTokens,
          outputTokens: res.outputTokens,
          cacheReadInputTokens: res.cacheReadInputTokens,
          cacheCreationInputTokens: res.cacheCreationInputTokens
        });
        return res;
      }
    };
  }
}
