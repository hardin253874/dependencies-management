/**
 * Mock judge (V2_STAGE5_SPEC 5b.2): answers from a programmatic responder or
 * from `test-fixtures/judge/<use>.json`, records every request, and can
 * simulate an outage. Never touches the network or the Jev ledger.
 *
 * Fixture shape: `{ "answers": { "<question name>": <answer> }, "fallback":
 * { "choice": { "choice": "...", "confidence": 0.9 }, "score": { "score": 2 },
 * "noul": { "noul": 0.8 } } }`. A question with no named answer gets the
 * fallback for its type; a choice fallback whose label is not in the
 * question's criteria picks the first label.
 */
import { readFileSync } from 'fs';
import path from 'path';
import type { ChoiceQuestion, Question, ScoreQuestion } from '@typesafe-ai/sdk';
import { JudgeUnavailableError, type JudgeAnswer, type JudgeUnavailableReason } from './types';
import type { JudgeAskInput, JudgeAskOutput, JudgeClient } from './client';
import { JEV_MODEL } from './client';
import { requestBoundTokens } from './payload';

export type MockFailure = 'timeout' | '429' | '529' | '401' | 'connection';

const FAILURE_REASON: Readonly<Record<MockFailure, JudgeUnavailableReason>> = {
  timeout: 'timeout',
  '429': 'rate-limit',
  '529': 'overloaded',
  '401': 'auth',
  connection: 'connection'
};

export interface MockFixture {
  answers?: Record<string, Partial<JudgeAnswer>>;
  fallback?: { choice?: { choice: string; confidence?: number }; score?: { score: number; confidence?: number }; noul?: { noul: number } };
}

export type MockResponder = (input: JudgeAskInput) => Record<string, Partial<JudgeAnswer> | undefined> | undefined;

function choiceAnswer(q: ChoiceQuestion, label: string | undefined, confidence = 0.9): JudgeAnswer {
  const labels = Object.keys(q.criteria);
  const chosen = label !== undefined && labels.includes(label) ? label : labels[0]!;
  const rest = labels.length > 1 ? (1 - confidence) / (labels.length - 1) : 0;
  const probabilities = Object.fromEntries(labels.map((l) => [l, l === chosen ? (labels.length > 1 ? confidence : 1) : rest]));
  return { type: 'choice', choice: chosen, confidence, probabilities };
}

function scoreAnswer(q: ScoreQuestion, score: number, confidence = 0.8): JudgeAnswer {
  // Plain arrays on purpose: mapping over the SDK's recursive `EntryType` tuple trips TS2589.
  const criteria = q.criteria as readonly unknown[];
  const legend: Record<string, string> = {};
  const probabilities: Record<string, number> = {};
  criteria.forEach((c, i) => {
    legend[String(i)] = typeof c === 'string' ? c : JSON.stringify(c);
    probabilities[String(i)] = i === Math.round(score) ? 1 : 0;
  });
  return { type: 'score', score, confidence, legend, probabilities };
}

function complete(q: Question, partial: Partial<JudgeAnswer> | undefined, fx: MockFixture): JudgeAnswer {
  if (q.type === 'choice') {
    const p = partial as { choice?: string; confidence?: number; probabilities?: Record<string, number> } | undefined;
    if (p?.probabilities !== undefined && p.choice !== undefined) return { type: 'choice', choice: p.choice, confidence: p.confidence ?? 0.9, probabilities: p.probabilities };
    return choiceAnswer(q, p?.choice ?? fx.fallback?.choice?.choice, p?.confidence ?? fx.fallback?.choice?.confidence);
  }
  if (q.type === 'score') {
    const p = partial as { score?: number; confidence?: number } | undefined;
    return scoreAnswer(q, p?.score ?? fx.fallback?.score?.score ?? 0, p?.confidence ?? fx.fallback?.score?.confidence);
  }
  if (q.type === 'noul') {
    const p = partial as { noul?: number } | undefined;
    return { type: 'noul', noul: p?.noul ?? fx.fallback?.noul?.noul ?? 0.5 };
  }
  throw new Error('mock judge: box questions are not used');
}

export class MockJudgeClient implements JudgeClient {
  readonly kind = 'mock' as const;
  readonly requests: JudgeAskInput[] = [];
  /** Simulated outage for every following call; `hang` never answers (until the signal aborts). */
  failure: MockFailure | 'hang' | null = null;
  latencyMs = 1;
  answeringModel = JEV_MODEL;
  inputTokensPerByte = 0.25;

  constructor(private readonly opts: { responder?: MockResponder; fixtures?: Partial<Record<string, MockFixture>>; fixtureDir?: string } = {}) {}

  private fixtureFor(use: string): MockFixture {
    const inline = this.opts.fixtures?.[use];
    if (inline !== undefined) return inline;
    if (this.opts.fixtureDir === undefined) return {};
    try {
      return JSON.parse(readFileSync(path.join(this.opts.fixtureDir, `${use}.json`), 'utf8')) as MockFixture;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
  }

  async ask(input: JudgeAskInput): Promise<JudgeAskOutput> {
    this.requests.push(structuredClone({ ...input, signal: undefined }));
    if (this.failure === 'hang') {
      await new Promise<never>((_, reject) => {
        input.signal?.addEventListener('abort', () => reject(new JudgeUnavailableError('aborted', 'mock judge aborted')), { once: true });
      });
    }
    if (this.failure !== null && this.failure !== 'hang') {
      throw new JudgeUnavailableError(FAILURE_REASON[this.failure], `mock judge: simulated ${this.failure}`);
    }
    const fx = this.fixtureFor(input.use);
    const scripted = this.opts.responder?.(input) ?? {};
    const answers: Record<string, JudgeAnswer> = {};
    for (const [name, q] of Object.entries(input.questions)) {
      answers[name] = complete(q, scripted[name] ?? fx.answers?.[name], fx);
    }
    const bytes = requestBoundTokens(this.answeringModel, input.state, input.questions);
    return { answers, model: this.answeringModel, usage: { inputTokens: Math.ceil(bytes * this.inputTokensPerByte) }, latencyMs: this.latencyMs };
  }
}
