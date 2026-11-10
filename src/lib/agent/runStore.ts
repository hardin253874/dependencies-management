/**
 * Agent run records (V2_STAGE4_SPEC 4a.8, design §8 seam).
 *
 * One envelope per run at `library/<slug>/runs/<runId>.json` (atomic write):
 * goal (view/dep/from/to), budgets, status, usage, cost, exploration trace and
 * a reference to the report envelope it produced. L3/L4 runs reuse the same
 * record; `trigger` is the L4 seam and only accepts `'user'` in v2.
 *
 * Runs are not pruned with per-dep caches; they are counted by
 * `storage/size.ts` and removed with the project directory. The name
 * `library/<slug>/memory/` is reserved for L4 project memory and never created.
 */
import crypto from 'crypto';
import { runFilePath } from '../paths';
import { readEnvelope, writeEnvelope, type Envelope } from '../storage/envelope';
import type { AgentBudgets, AgentRunStatus, AgentTrace, AgentUsage, BudgetName, StopDetail } from '../../core/agent/loop';
import type { LlmEffort } from '../llm/effort';
import type { ImpactSummary } from '../api-types';

export const RUN_TRIGGERS = ['user'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];
export type RunView = 'update-report' | 'deep-report';

export interface AgentRunRecord {
  runId: string;
  trigger: RunTrigger;
  view: RunView;
  dep: string;
  from: string | null;
  to: string | null;
  model: string;
  effort: LlmEffort;
  budgets: AgentBudgets;
  status: AgentRunStatus;
  stopDetail: StopDetail;
  finalTurnReason: BudgetName | null;
  startedAt: string;
  durationMs: number;
  usage: AgentUsage;
  costUsd: number;
  trace: AgentTrace;
  /** `meta.builtAt` of the graph the run explored. */
  graphBuiltAt: string | null;
  /** Library-relative path of the report envelope this run produced (null when none was written). */
  resultRef: string | null;
  /** `filesToModify` entries dropped because the path is not in the graph. */
  droppedPaths: number;
  /** v2 Stage 5a.3: paths of successful `read_file` calls (evidence for exclusions). Optional: older records lack it. */
  readPaths?: string[];
  /** v2 Stage 5a.5: base impacted set + agent overlay counts ([D] only). Optional: older records lack it. */
  impactSummary?: ImpactSummary;
}

const RUN_ID_RE = /^[a-z0-9][a-z0-9-]{5,63}$/;

export class RunRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunRecordError';
  }
}

export function newRunId(now: Date = new Date()): string {
  return `${now.getTime().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
}

export function validateRunRecord(r: AgentRunRecord): void {
  if (!RUN_ID_RE.test(r.runId)) throw new RunRecordError(`invalid runId "${r.runId}"`);
  if (!(RUN_TRIGGERS as readonly string[]).includes(r.trigger)) {
    throw new RunRecordError(`trigger "${String(r.trigger)}" is not supported in v2 (only "user")`);
  }
  if (r.view !== 'update-report' && r.view !== 'deep-report') throw new RunRecordError(`invalid view "${String(r.view)}"`);
}

export async function writeRunRecord(slug: string, record: AgentRunRecord): Promise<Envelope<AgentRunRecord>> {
  validateRunRecord(record);
  return writeEnvelope(runFilePath(slug, record.runId), { source: `anthropic:${record.model}`, ttlHours: null, data: record });
}

export async function readRunRecord(slug: string, runId: string): Promise<Envelope<AgentRunRecord>> {
  if (!RUN_ID_RE.test(runId)) throw new RunRecordError(`invalid runId "${runId}"`);
  const env = await readEnvelope<AgentRunRecord>(runFilePath(slug, runId));
  validateRunRecord(env.data);
  return env;
}
