'use client';

import { useEffect, useState } from 'react';
import { getApiClient } from '@/lib/client/api-client';
import type { DeepReportEstimateResponse } from '@/lib/api-types';
import { Modal } from './Modal';
import { Button } from './Button';
import styles from './DeepAnalyzeConfirmModal.module.css';

interface Props {
  open: boolean;
  slug: string;
  depName: string;
  fromVersion: string;
  toVersion: string;
  onContinue: () => void;
  onCancel: () => void;
}

/**
 * First-time Deep Analyze confirmation prompt (spec §7.6, Wireframe 29).
 *
 * Shown when the user clicks "Deep Analyze" on view [D] and
 * `_config.json.ui.showDeepAnalyzeWarning` is true (default). The modal
 * fetches a pre-flight cost estimate from the BE and presents Continue /
 * Cancel. Per spec, this prompt only appears the first time per project;
 * once acknowledged the BE will set `_config.json.ui.showDeepAnalyzeWarning`
 * to false for subsequent runs (Stage 4 BE territory).
 */
export function DeepAnalyzeConfirmModal({
  open,
  slug,
  depName,
  fromVersion,
  toVersion,
  onContinue,
  onCancel
}: Props): JSX.Element | null {
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
        const res = await getApiClient().getDeepReportCostEstimate(
          slug,
          depName,
          fromVersion,
          toVersion,
          { signal: controller.signal }
        );
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
  }, [open, slug, depName, fromVersion, toVersion]);

  return (
    <Modal
      open={open}
      title="Deep Analyze"
      onClose={onCancel}
      maxWidth={440}
      nested
      footer={
        <>
          <Button onClick={onCancel} data-testid="deep-prompt-cancel">
            Cancel
          </Button>
          <Button
            tone="primary"
            onClick={onContinue}
            disabled={loading}
            data-testid="deep-prompt-continue"
          >
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
          <p className={styles.statusError} role="alert" data-testid="deep-prompt-error">
            Could not load estimate: {error}
          </p>
        )}
        {estimate && !loading && !error && (
          <>
            <p className={styles.lead}>
              This will fetch ~{estimate.totalPackages.toLocaleString()}{' '}
              transitive packages and run a deep AI analysis.
            </p>
            <p className={styles.cost} data-testid="deep-prompt-cost">
              Estimated cost: ~${estimate.estimatedCostUsd.toFixed(2)}
            </p>
            <p className={styles.note}>
              Using {estimate.provider} {estimate.model}.
            </p>
          </>
        )}
        <p className={styles.helpText}>
          This prompt only appears the first time per project. You can re-enable
          it in Settings → Behavior.
        </p>
      </div>
    </Modal>
  );
}
