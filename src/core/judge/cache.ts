/**
 * Judge cache by payload hash (V2_STAGE5_SPEC 5b.4): the same question is
 * never paid twice.
 *
 * Key = sha256 of canonical JSON `{ use, model, state, questions,
 * JUDGE_PROMPT_VERSION }` (keys sorted at every level). Files are envelopes
 * under `<dir>/<key>.json` (app `library/_judge`, eval `<evalCache>/_judge`),
 * atomic writes, `ttlHours: null`. Errors are never cached.
 *
 * In-flight dedupe: concurrent calls with the same key share one request.
 * The map lives on the cache instance (core keeps no module state; the app
 * pins its one cache instance on `globalThis`).
 */
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { atomicWriteJson } from '../../lib/storage/atomic';
import type { JudgeAnswer, JudgeUse } from './types';

/** Bump when any question text / criteria / payload builder output changes for the same input. */
export const JUDGE_PROMPT_VERSION = 'judge-v1';

export interface CachedJudgeAnswer {
  answers: Record<string, JudgeAnswer>;
  model: string;
  usage: { inputTokens: number | null };
  latencyMs: number;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])])
    );
  }
  return value;
}

export function judgeCacheKey(k: { use: JudgeUse; model: string; state: unknown; questions: unknown; promptVersion?: string }): string {
  const body = JSON.stringify(canonical({ use: k.use, model: k.model, state: k.state, questions: k.questions, v: k.promptVersion ?? JUDGE_PROMPT_VERSION }));
  return crypto.createHash('sha256').update(body).digest('hex');
}

export class JudgeCache {
  private readonly inflight = new Map<string, Promise<CachedJudgeAnswer>>();

  constructor(readonly dir: string) {}

  private fileFor(key: string): string {
    return path.join(this.dir, `${key}.json`);
  }

  async get(key: string): Promise<CachedJudgeAnswer | null> {
    try {
      const env = JSON.parse(await fs.readFile(this.fileFor(key), 'utf8')) as { data?: CachedJudgeAnswer };
      return env.data ?? null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      // A corrupt entry is a miss (it is re-asked and overwritten), never a crash.
      return null;
    }
  }

  async put(key: string, value: CachedJudgeAnswer): Promise<void> {
    await atomicWriteJson(this.fileFor(key), {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      source: `jev:${value.model}`,
      ttlHours: null,
      data: value
    });
  }

  /** Hit → `{ value, cached: true }`; miss → runs `fetch` once per key (concurrent callers share it), stores a success only. */
  async getOrFetch(key: string, fetch: () => Promise<CachedJudgeAnswer>): Promise<{ value: CachedJudgeAnswer; cached: boolean }> {
    const hit = await this.get(key);
    if (hit !== null) return { value: hit, cached: true };
    const running = this.inflight.get(key);
    if (running !== undefined) return { value: await running, cached: true };
    const p = (async () => {
      const v = await fetch();
      await this.put(key, v);
      return v;
    })();
    this.inflight.set(key, p);
    try {
      return { value: await p, cached: false };
    } finally {
      this.inflight.delete(key);
    }
  }
}
