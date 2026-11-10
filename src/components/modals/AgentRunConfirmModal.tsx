'use client';

import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { getApiClient } from '@/lib/client/api-client';
import type { DeepReportEstimateResponse } from '@/lib/api-types';
import { Modal } from './Modal';
import { Button } from './Button';
import styles from './DeepAnalyzeConfirmModal.module.css';

interface Props {
  open: boolean;
  /** Which report the run produces (picks the estimate route). */
  view: 'update-report' | 'deep-report';
  slug: string;
  depName: string;
  fromVersion: string;
  toVersion: string;
  onContinue: () => void;
  onCancel: () => void;
}

/**
 * v2 Stage 4a.13: confirm before every [D] / [D-Deep] Generate / Regenerate.
 * Built on the `DeepAnalyzeConfirmModal` pattern: fetch the BE estimate
 * (GET …/cost-estimate, which never starts a run), show expected and maximum
 * USD, the model and the budgets, then Continue / Cancel. Cancel never POSTs.
 * A v1-engine estimate (no `maxUsd`) shows only the single-call estimate.
 */
export function AgentRunConfirmModal({ open, view, slug, depName, fromVersion, toVersion, onContinue, onCancel }: Props): JSX.Element | null {
  const [estimate, setEstimate] = useState<DeepReportEstimateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setEstimate(null);
    setError(null);
    setLoading(true);
    const controller = new AbortController();
    (async () => {
      try {
        const api = getApiClient();
        const res =
          view === 'update-report'
            ? await api.getUpdateReportCostEstimate(slug, depName, fromVersion, toVersion, { signal: controller.signal })
            : await api.getDeepReportCostEstimate(slug, depName, fromVersion, toVersion, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setEstimate(res);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to load estimate.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [open, view, slug, depName, fromVersion, toVersion]);

  const budgets = estimate?.budgets ?? null;
  return (
    <Modal
      open={open}
      title={view === 'update-report' ? 'Generate update report' : 'Generate deep report'}
      onClose={onCancel}
      maxWidth={460}
      nested
      footer={
        <>
          <Button onClick={onCancel} data-testid="agent-run-cancel">
            Cancel
          </Button>
          <Button tone="primary" onClick={onContinue} disabled={loading} data-testid="agent-run-continue">
            Continue
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        {loading && (
          <p className={styles.statusInfo} role="status">
            Estimating cost…
          </p>
        )}
        {error && (
          <p className={styles.statusError} role="alert" data-testid="agent-run-error">
            Could not load estimate: {error}. You can still continue.
          </p>
        )}
        {estimate && !loading && !error && (
          <>
            <p className={styles.lead}>
              {estimate.maxUsd !== undefined
                ? `The AI agent explores this project's code graph with read-only tools, then writes the report for ${depName} ${fromVersion} → ${toVersion}.`
                : `One AI request for ${depName} ${fromVersion} → ${toVersion}.`}
            </p>
            <p className={styles.cost} data-testid="agent-run-expected">
              Expected cost: ~${estimate.estimatedCostUsd.toFixed(2)}
            </p>
            {estimate.maxUsd !== undefined && (
              <p className={styles.cost} data-testid="agent-run-max">
                Maximum (hard budget): ${estimate.maxUsd.toFixed(2)}
              </p>
            )}
            <p className={styles.note} data-testid="agent-run-model">
              Using {estimate.provider} {estimate.model}.
            </p>
            {budgets && (
              <p className={styles.note} data-testid="agent-run-budgets">
                Budgets: {budgets.maxToolCalls} tool calls, {budgets.maxInputTokens.toLocaleString()} input /{' '}
                {budgets.maxOutputTokens.toLocaleString()} output tokens, {Math.round(budgets.maxWallMs / 1000)} s.
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
