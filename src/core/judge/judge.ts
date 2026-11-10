/**
 * The judge facade: the ONE path from a J use / the router to TypeSafe.
 *
 *   privacy guard (switches, project, payload class) → no client? → cache
 *   → client (TypeSafe: Jev ledger reserve → request → settle) with a timeout
 *
 * `tryAsk` never throws: a refusal or an outage returns `{ ok: false }` and
 * the caller keeps today's behaviour (spec §0.11: a Jev failure never
 * blocks a view).
 */
import { assertAllowed } from './privacy';
import { JudgeCache, judgeCacheKey, type CachedJudgeAnswer } from './cache';
import { JEV_MODEL, JEV_TIMEOUT_MS, unavailableFrom, type JudgeClient } from './client';
import { JudgePrivacyError, JudgeUnavailableError, type JudgeRequest, type JudgeResult, type JudgeSubject, type JudgeSwitches } from './types';

export interface JudgeDeps {
  /** `null` = no key: every ask is `JudgeUnavailableError('no-key')` after the guard. */
  client: JudgeClient | null;
  cache: JudgeCache | null;
  switches: JudgeSwitches;
  model?: string;
}

export type TryAskResult = { ok: true; result: JudgeResult } | { ok: false; reason: string; kind: 'refused' | 'unavailable' };

async function withTimeout<T>(ms: number, outer: AbortSignal | undefined, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(outer?.reason);
  if (outer?.aborted) controller.abort(outer.reason);
  outer?.addEventListener('abort', onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new JudgeUnavailableError('timeout', `Jev timed out after ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  }
}

export class Judge {
  constructor(private readonly deps: JudgeDeps) {}

  get switches(): JudgeSwitches {
    return this.deps.switches;
  }

  get model(): string {
    return this.deps.model ?? JEV_MODEL;
  }

  get hasClient(): boolean {
    return this.deps.client !== null;
  }

  /** Throws `JudgePrivacyError` (refused) or `JudgeUnavailableError` (no key / outage). */
  async ask(req: JudgeRequest & { subject: JudgeSubject }): Promise<JudgeResult> {
    assertAllowed({ use: req.use, payloadClass: req.payload.payloadClass, subject: req.subject, switches: this.deps.switches });
    const client = this.deps.client;
    if (client === null) throw new JudgeUnavailableError('no-key', 'no TypeSafe key configured');
    const timeoutMs = req.timeoutMs ?? JEV_TIMEOUT_MS;
    const fetch = async (): Promise<CachedJudgeAnswer> => {
      try {
        const out = await withTimeout(timeoutMs, req.signal, (signal) =>
          client.ask({ use: req.use, state: req.payload.state, questions: req.questions, signal, timeoutMs })
        );
        return { answers: out.answers, model: out.model, usage: out.usage, latencyMs: out.latencyMs };
      } catch (err) {
        throw unavailableFrom(err);
      }
    };
    const started = Date.now();
    if (this.deps.cache === null) {
      const v = await fetch();
      return { ...v, cached: false };
    }
    const key = judgeCacheKey({ use: req.use, model: this.model, state: req.payload.state, questions: req.questions });
    const { value, cached } = await this.deps.cache.getOrFetch(key, fetch);
    return { ...value, latencyMs: cached ? Date.now() - started : value.latencyMs, cached };
  }

  async tryAsk(req: JudgeRequest & { subject: JudgeSubject }): Promise<TryAskResult> {
    try {
      return { ok: true, result: await this.ask(req) };
    } catch (err) {
      if (err instanceof JudgePrivacyError) return { ok: false, kind: 'refused', reason: err.message };
      const u = unavailableFrom(err);
      return { ok: false, kind: 'unavailable', reason: u.reason };
    }
  }
}

/** A judge that refuses everything (no switches on, no client). */
export function disabledJudge(): Judge {
  return new Judge({ client: null, cache: null, switches: { enabled: false, router: false, flags: { J1: false, J2: false, J3: false, J4: false, J5: false, J6: false, J7: false, J8: false } } });
}
