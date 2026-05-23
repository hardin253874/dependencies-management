/**
 * Job types + state machine for the in-memory queue (spec §10.10).
 */

export type JobPhase = 'registry' | 'cve' | 'ai' | 'retry' | 'scan' | 'resolver';

export type JobState = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface JobProgress {
  current: number;
  total: number;
  label: string;
  phase: JobPhase;
  attempt?: number;
  maxAttempts?: number;
}

export interface JobError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface JobRecord {
  jobId: string;
  /** Slug of the project this job belongs to. `null` for non-project jobs. */
  slug: string | null;
  /** A free-form resource key used to detect duplicate in-flight jobs. */
  resourceKey: string;
  kind: string;
  state: JobState;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress: JobProgress | null;
  error: JobError | null;
  /** When state is `done`, the URL the UI should navigate to. */
  resultUrl: string | null;
}
