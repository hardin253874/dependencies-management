'use client';

import { useEffect, useState } from 'react';
import { useAppContext } from './AppContext';
import { useJobStream } from '@/lib/client/sse';
import type { JobProgress, JobRecord } from '@/lib/api-types';
import styles from './StatusBar.module.css';

function pickLiveJob(jobs: JobRecord[]): JobRecord | null {
  return jobs.find((j) => j.state === 'running' || j.state === 'queued') ?? null;
}

/**
 * AI jobs surface in two ways:
 *   - resourceKey starts with `reports:` (View [D] update report) or
 *     `file-reviews:` (View [E] file review). Both are AI surfaces.
 *   - Progress phase === 'ai' (live SSE signal).
 *
 * Either suffices to flag the cost-disclosure copy on the cancel modal.
 */
function isAiJob(job: JobRecord, progress: JobProgress | null): boolean {
  if (progress?.phase === 'ai' || progress?.phase === 'retry') return true;
  if (job.progress?.phase === 'ai' || job.progress?.phase === 'retry') return true;
  const kind = job.resourceKey.split(':')[0];
  return kind === 'reports' || kind === 'file-reviews' || kind === 'deep-reports';
}

/**
 * Spec §11.8: "partial tool-use JSON is never rendered; UI shows only status
 * messages". Defensive guard — if any incoming label looks like JSON (starts
 * with `{` or `[`), replace it with the generic "Generating analysis…" copy.
 */
function aiStatusText(label: string | undefined): string {
  if (!label) return 'Generating analysis…';
  const trimmed = label.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"')) {
    return 'Generating analysis…';
  }
  return label;
}

export function StatusBar(): JSX.Element {
  const { jobs, refreshJobs, activeProjectSlug, refreshActiveProject, requestCancel } = useAppContext();
  const [liveProgress, setLiveProgress] = useState<JobProgress | null>(null);
  const liveJob = pickLiveJob(jobs);

  useJobStream(liveJob?.jobId ?? null, {
    onProgress: (event) => setLiveProgress(event),
    onDone: () => {
      setLiveProgress(null);
      void refreshJobs();
      if (activeProjectSlug) {
        void refreshActiveProject();
      }
    },
    onError: () => {
      setLiveProgress(null);
      void refreshJobs();
    }
  });

  // Periodically refresh jobs so we capture jobs created by other tabs / restarts.
  useEffect(() => {
    const interval = setInterval(() => {
      void refreshJobs();
    }, 10_000);
    return () => clearInterval(interval);
  }, [refreshJobs]);

  if (!liveJob) {
    return (
      <footer role="contentinfo" className={styles.bar} aria-live="polite">
        <span className={styles.idle}>Idle</span>
      </footer>
    );
  }

  const jobProgress = liveJob.progress;
  const progress = {
    current: liveProgress?.current ?? jobProgress?.current,
    total: liveProgress?.total ?? jobProgress?.total,
    label: liveProgress?.label ?? jobProgress?.label,
    phase: liveProgress?.phase ?? jobProgress?.phase,
    attempt: liveProgress?.attempt ?? jobProgress?.attempt,
    maxAttempts: liveProgress?.maxAttempts ?? jobProgress?.maxAttempts
  };

  const isRetry = progress.phase === 'retry';
  const isAi = progress.phase === 'ai';
  // AI + retry phases are inherently unbounded (spec §7.9 + Wireframe 22) — they
  // render the spinner + status text only, never a percentage bar, even when
  // the BE emits zeroed `current/total` placeholders.
  const bounded =
    !isRetry &&
    !isAi &&
    typeof progress.current === 'number' &&
    typeof progress.total === 'number' &&
    progress.total > 0;

  const onCancel = () => {
    requestCancel({
      jobId: liveJob.jobId,
      label: progress.label ?? liveJob.kind,
      isAi: isAiJob(liveJob, liveProgress)
    });
  };

  return (
    <footer
      role="contentinfo"
      className={[styles.bar, isRetry ? styles.retry : ''].filter(Boolean).join(' ')}
      aria-live="polite"
    >
      <div
        role="status"
        className={styles.body}
        aria-label={`Job: ${progress.label ?? liveJob.kind}`}
      >
        <span className={styles.spinner} aria-hidden="true" />
        {bounded ? (
          <span
            role="progressbar"
            aria-valuenow={progress.current}
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-label={progress.label ?? liveJob.kind}
            className={styles.bounded}
          >
            <span className={styles.boundedText}>
              {progress.current!.toLocaleString()} / {progress.total!.toLocaleString()}
              {progress.label ? ` — ${progress.label}` : ''}
            </span>
            <span className={styles.boundedTrack} aria-hidden="true">
              <span
                className={styles.boundedFill}
                style={{ width: `${Math.min(100, (progress.current! / progress.total!) * 100)}%` }}
              />
            </span>
          </span>
        ) : isRetry ? (
          <span className={styles.text}>
            Rate limited, retrying…
            {progress.label ? `  (${progress.label})` : ''}
          </span>
        ) : isAi ? (
          <span className={styles.text} data-testid="status-ai-text">
            {aiStatusText(progress.label)}
          </span>
        ) : (
          <span className={styles.text}>Refreshing…</span>
        )}
      </div>
      <button
        type="button"
        aria-label="Cancel job"
        className={styles.cancel}
        onClick={onCancel}
      >
        <span aria-hidden="true">✕</span>
      </button>
    </footer>
  );
}
