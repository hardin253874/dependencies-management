'use client';

/**
 * v2 Stage 4a.13: the agent run behind a report — status, cost and the
 * exploration trace (one row per tool call: tool, short input, duration,
 * truncated / error badges). Collapsed by default (right-panel convention).
 * Renders nothing for envelopes without `agentRun` (v1 or pre-Stage-4 caches).
 */
import type { JSX } from 'react';
import type { AgentRunSummary } from '@/lib/api-types';
import { CollapsibleSection } from './CollapsibleSection';
import styles from './ExplorationTrace.module.css';

const STATUS_LABEL: Readonly<Record<AgentRunSummary['status'], string>> = {
  submitted: 'finished',
  'budget-exhausted': 'stopped: budget reached',
  'no-submit': 'stopped: no report submitted',
  cancelled: 'cancelled',
  error: 'failed'
};

export function ExplorationTrace({ run }: { run: AgentRunSummary | undefined | null }): JSX.Element | null {
  if (run === undefined || run === null) return null;
  const calls = run.calls ?? [];
  return (
    <CollapsibleSection title="Agent exploration" count={calls.length} testId="exploration-trace-toggle" sectionClassName={styles.section}>
      <p className={styles.meta} data-testid="exploration-trace-meta">
        Run {STATUS_LABEL[run.status] ?? run.status} · {run.toolCalls ?? calls.length} tool calls · ${(run.costUsd ?? 0).toFixed(4)}
        {(run.droppedPaths ?? 0) > 0 ? ` · ${run.droppedPaths} unknown file path(s) dropped` : ''}
      </p>
      {calls.length === 0 ? (
        <p className={styles.meta}>No tool calls.</p>
      ) : (
        <ol className={styles.list} data-testid="exploration-trace-list">
          {calls.map((c, i) => (
            <li key={`${c.turn}-${i}`} className={styles.row} data-testid="exploration-trace-row">
              <code className={styles.tool}>{c.tool}</code>
              <span className={styles.input} title={c.inputSummary}>
                {c.inputSummary}
              </span>
              <span className={styles.duration}>{c.durationMs} ms</span>
              {c.truncated && <span className={styles.badge}>truncated</span>}
              {c.isError && <span className={`${styles.badge} ${styles.error}`}>error</span>}
            </li>
          ))}
        </ol>
      )}
    </CollapsibleSection>
  );
}
