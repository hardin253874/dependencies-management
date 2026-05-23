/**
 * In-memory job queue + event bus (spec §10.10).
 *
 * - Per-slug `p-queue` instances cap concurrent jobs per project at 3 (§10.8).
 *   Jobs without a slug (e.g. CSRF-test, future global operations) use a
 *   shared `__global__` queue keyed under the same map.
 * - Job state is the source of truth; SSE is a live tail of state updates.
 * - Job journal written to library/<slug>/_jobs/<jobId>.json on start and
 *   deleted on completion (used for orphan detection on next boot).
 *
 * Cancel + journal cleanup hygiene (M3 from Stage 1 review):
 *   - `cancel()` on a `queued` job:
 *       - The worker function may not yet have run; `scheduleRun` checks
 *         `state === 'cancelled'` after the slot is acquired and exits
 *         without writing a journal. Safe.
 *   - `cancel()` on a `running` job:
 *       - We `ctrl.abort()`. The worker observes the signal (or finishes
 *         naturally); either way the `finally` block runs and cleans up the
 *         journal exactly once.
 *   - `cancel()` on a terminal job:
 *       - Short-circuits and returns false.
 */
import { promises as fs } from 'fs';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import PQueue from 'p-queue';
import { jobJournalPath, projectJobsDir } from '../paths';
import { atomicWriteJson, pathExists } from '../storage/atomic';
import { getLoggerSync } from '../logger';
import type { JobError, JobProgress, JobRecord } from './types';

const GLOBAL_KEY = '__global__';
const DEFAULT_PER_SLUG_CONCURRENCY = 3;
/**
 * Cadence for the per-job watchdog log line. Surfaces "this job has been
 * running for N seconds with last progress at phase=X" so a hang inside a
 * long-running worker (e.g. a Phase 2 scan that's stuck on flush) is visible
 * in `_logs/server.log` within at most this many seconds, regardless of
 * whether the worker itself logs progress.
 */
const WATCHDOG_INTERVAL_MS = 30_000;

export interface RunJobInput {
  /** Slug for which this job runs, or null for project-add (pre-slug). */
  slug: string | null;
  /** Short identifier — e.g. `scan:phase-2`, `report:react@18→19`. */
  kind: string;
  /** Used to detect dupes; same resourceKey + state `running` returns existing. */
  resourceKey: string;
  /** Worker function. Receives a progress reporter. */
  run: (report: (p: JobProgress) => void, signal: AbortSignal) => Promise<{ resultUrl?: string } | void>;
}

export interface EnqueueResult {
  jobId: string;
  alreadyRunning: boolean;
}

type Listener = (record: JobRecord) => void;

class JobQueue {
  private readonly emitter = new EventEmitter();
  private readonly records = new Map<string, JobRecord>();
  private readonly running = new Map<string, AbortController>();
  /** Map from resourceKey → jobId (only set while job is running). */
  private readonly resourceIndex = new Map<string, string>();
  /** Per-slug queues; each gets its own concurrency cap. */
  private readonly slugQueues = new Map<string, PQueue>();
  private perSlugConcurrency = DEFAULT_PER_SLUG_CONCURRENCY;

  /**
   * Per-slug concurrency cap (spec §10.8 — 3 per project). Affects new and
   * existing queues. Default 3.
   */
  setConcurrency(n: number): void {
    this.perSlugConcurrency = Math.max(1, n);
    for (const q of this.slugQueues.values()) q.concurrency = this.perSlugConcurrency;
  }

  list(): JobRecord[] {
    return Array.from(this.records.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(jobId: string): JobRecord | null {
    return this.records.get(jobId) ?? null;
  }

  subscribe(jobId: string, listener: Listener): () => void {
    this.emitter.on(`job:${jobId}`, listener);
    // Replay the current state immediately so a subscriber that attaches
    // after a job has already reached a terminal state still receives an
    // event. The SSE route depends on this behaviour, and tests that
    // subscribe-after-enqueue would race without it.
    const current = this.records.get(jobId);
    if (current !== undefined) {
      const snapshot: JobRecord = JSON.parse(JSON.stringify(current));
      // Defer to the next tick so `subscribe()` callers can attach listeners
      // and use the returned unsubscribe handle before the first emit lands.
      setImmediate(() => this.emitter.emit(`job:${jobId}`, snapshot));
    }
    return () => this.emitter.off(`job:${jobId}`, listener);
  }

  cancel(jobId: string): boolean {
    const rec = this.records.get(jobId);
    if (rec === undefined) return false;
    if (rec.state === 'done' || rec.state === 'error' || rec.state === 'cancelled') return false;
    const ctrl = this.running.get(jobId);
    if (ctrl !== undefined) ctrl.abort();
    // For queued (not-yet-running) jobs the scheduleRun loop will observe
    // `state === 'cancelled'` after acquiring its slot and short-circuit. The
    // journal hasn't been written yet, so there's nothing to clean up.
    this.transition(rec, 'cancelled');
    return true;
  }

  async enqueue(input: RunJobInput): Promise<EnqueueResult> {
    const existingJobId = this.resourceIndex.get(input.resourceKey);
    if (existingJobId !== undefined) {
      const existing = this.records.get(existingJobId);
      if (existing !== undefined && (existing.state === 'queued' || existing.state === 'running')) {
        return { jobId: existing.jobId, alreadyRunning: true };
      }
    }

    const jobId = crypto.randomBytes(12).toString('hex');
    const record: JobRecord = {
      jobId,
      slug: input.slug,
      resourceKey: input.resourceKey,
      kind: input.kind,
      state: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      progress: null,
      error: null,
      resultUrl: null
    };
    this.records.set(jobId, record);
    this.resourceIndex.set(input.resourceKey, jobId);
    this.emit(record);

    // Add to the slug's queue. p-queue itself enforces the per-slug cap.
    const queue = this.queueFor(input.slug);
    void queue.add(() => this.runOne(record, input));

    return { jobId, alreadyRunning: false };
  }

  /**
   * Test hook: lookup the underlying p-queue size for assertions about
   * per-slug concurrency caps.
   */
  inspectSlugQueue(slug: string | null): { pending: number; size: number; concurrency: number } {
    const q = this.slugQueues.get(slug ?? GLOBAL_KEY);
    if (q === undefined) return { pending: 0, size: 0, concurrency: this.perSlugConcurrency };
    return { pending: q.pending, size: q.size, concurrency: q.concurrency };
  }

  private queueFor(slug: string | null): PQueue {
    const key = slug ?? GLOBAL_KEY;
    let q = this.slugQueues.get(key);
    if (q === undefined) {
      q = new PQueue({ concurrency: this.perSlugConcurrency });
      this.slugQueues.set(key, q);
    }
    return q;
  }

  private async runOne(record: JobRecord, input: RunJobInput): Promise<void> {
    if (record.state === 'cancelled') {
      // Cancelled while queued — nothing to do.
      return;
    }
    const ctrl = new AbortController();
    this.running.set(record.jobId, ctrl);
    record.startedAt = new Date().toISOString();
    this.transition(record, 'running');

    // Write job journal (deleted on completion).
    if (record.slug !== null) {
      try {
        await fs.mkdir(projectJobsDir(record.slug), { recursive: true });
        await atomicWriteJson(jobJournalPath(record.slug, record.jobId), record);
      } catch {
        // Journal failure is non-fatal; callers may still observe via SSE.
      }
    }

    // Watchdog: if the worker is alive but not progressing, surface that
    // explicitly in the log every WATCHDOG_INTERVAL_MS. This is the
    // last-resort signal for "the job is silently stuck" — any stall longer
    // than 30 s now shows up as a structured warning in `_logs/server.log`
    // with `lastProgress` reflecting the most recent `report()` payload.
    const startedAtMs = Date.now();
    const watchdog = setInterval(() => {
      const log = getLoggerSync();
      if (log === null) return;
      log.warn(
        {
          jobId: record.jobId,
          kind: record.kind,
          slug: record.slug,
          runningForMs: Date.now() - startedAtMs,
          lastProgress: record.progress
        },
        `job watchdog: ${record.kind} still running after ${Math.round((Date.now() - startedAtMs) / 1000)}s`
      );
    }, WATCHDOG_INTERVAL_MS);

    try {
      const result = await input.run((p) => {
        record.progress = p;
        this.emit(record);
      }, ctrl.signal);
      record.resultUrl = result?.resultUrl ?? null;
      record.finishedAt = new Date().toISOString();
      this.transition(record, ctrl.signal.aborted ? 'cancelled' : 'done');
    } catch (err) {
      const e = err as Error;
      const error: JobError = {
        code: (err as { code?: string }).code ?? 'INTERNAL_ERROR',
        message: e.message,
        retryable: false
      };
      record.error = error;
      record.finishedAt = new Date().toISOString();
      this.transition(record, ctrl.signal.aborted ? 'cancelled' : 'error');
      // Surface worker exceptions in the log. Without this, a thrown error
      // inside the worker only reaches the UI via the job record — the log
      // file shows nothing, making post-mortem investigation impossible.
      const log = getLoggerSync();
      log?.error(
        {
          jobId: record.jobId,
          kind: record.kind,
          slug: record.slug,
          err: e.message,
          stack: e.stack
        },
        `job ${record.kind} threw: ${e.message}`
      );
    } finally {
      clearInterval(watchdog);
      this.running.delete(record.jobId);
      this.resourceIndex.delete(input.resourceKey);
      if (record.slug !== null) {
        const fp = jobJournalPath(record.slug, record.jobId);
        if (await pathExists(fp)) {
          await fs.unlink(fp).catch(() => undefined);
        }
      }
    }
  }

  private transition(record: JobRecord, next: JobRecord['state']): void {
    record.state = next;
    this.emit(record);
  }

  private emit(record: JobRecord): void {
    const snapshot: JobRecord = JSON.parse(JSON.stringify(record));
    this.emitter.emit(`job:${record.jobId}`, snapshot);
  }
}

// Stash the singleton on `globalThis` (same pattern as `csrf.ts` and
// `logger.ts`). Next.js dev mode evaluates this module per-route bundle, so
// a plain `let singleton` would mean each route handler creates its OWN
// JobQueue: POST `/refresh` enqueues a job in queue A, but GET `/jobs/:id`
// reads from a brand new queue B that doesn't know about it → 404
// JOB_NOT_FOUND → the right-panel awaitJob loop bails with "Job no longer
// tracked by the server." Pinning on globalThis keeps a single queue across
// every module instance within the same Node process.
declare global {
  // eslint-disable-next-line no-var
  var __DEP_AGENT_JOB_QUEUE__: JobQueue | undefined;
}

export function getJobQueue(): JobQueue {
  if (globalThis.__DEP_AGENT_JOB_QUEUE__ === undefined) {
    globalThis.__DEP_AGENT_JOB_QUEUE__ = new JobQueue();
  }
  return globalThis.__DEP_AGENT_JOB_QUEUE__;
}

/** Test hook — reset the singleton between tests. */
export function resetJobQueue(): void {
  globalThis.__DEP_AGENT_JOB_QUEUE__ = undefined;
}
