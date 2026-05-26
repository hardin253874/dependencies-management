'use client';

import { useEffect, useState } from 'react';
import { getApiClient } from '@/lib/client/api-client';
import type { CveImpactEstimateResponse } from '@/lib/api-types';
import { Modal } from './Modal';
import { Button } from './Button';
import styles from './CveImpactConfirmModal.module.css';

interface Props {
  open: boolean;
  slug: string;
  depName: string;
  onContinue: () => void;
  onCancel: () => void;
}

/**
 * Confirmation prompt for view [A]'s "Analyze Usage" feature (v0.6). Same
 * shape as `DeepAnalyzeConfirmModal` — forked rather than refactored so
 * the existing Deep Analyze flow stays untouched. Pre-fetches the cost
 * estimate from the BE and shows it before the user commits to the LLM call.
 *
 * Unlike Deep Analyze, this modal always appears (no Settings toggle to
 * silence it) — the cost varies significantly with CVE count + usage spread
 * and the user should see the number every time.
 */
export function CveImpactConfirmModal({
  open,
  slug,
  depName,
  onContinue,
  onCancel
}: Props): JSX.Element | null {
  const [estimate, setEstimate] = useState<CveImpactEstimateResponse | null>(null);
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
        const res = await getApiClient().getCveImpactCostEstimate(slug, depName, {
          signal: controller.signal
        });
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
  }, [open, slug, depName]);

  return (
    <Modal
      open={open}
      title="Analyze CVE impact on your code"
      onClose={onCancel}
      maxWidth={460}
      nested
      footer={
        <>
          <Button onClick={onCancel} data-testid="cve-impact-prompt-cancel">
            Cancel
          </Button>
          <Button
            tone="primary"
            onClick={onContinue}
            disabled={loading || estimate?.cveCount === 0}
            data-testid="cve-impact-prompt-continue"
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
          <p className={styles.statusError} role="alert" data-testid="cve-impact-prompt-error">
            Could not load estimate: {error}
          </p>
        )}
        {estimate && !loading && !error && (
          <>
            <p className={styles.lead}>
              This will analyze{' '}
              <strong>{estimate.cveCount}</strong>{' '}
              CVE{estimate.cveCount === 1 ? '' : 's'} against{' '}
              <strong>{estimate.filesInUsage}</strong>{' '}
              project file{estimate.filesInUsage === 1 ? '' : 's'} that import{' '}
              <code>{depName}</code>.
            </p>
            {!estimate.usageCacheExists && (
              <p className={styles.statusInfo}>
                Usage cache missing — a project-wide code scan will run first (free, ~1 s).
              </p>
            )}
            <p className={styles.cost} data-testid="cve-impact-prompt-cost">
              Estimated cost: ~${estimate.estimatedCostUsd.toFixed(4)}
            </p>
            <p className={styles.note}>
              Using {estimate.provider} {estimate.model}.
            </p>
          </>
        )}
        <p className={styles.helpText}>
          The AI will receive ±20 lines of code around each import + use site,
          then verdict each CVE as <code>not-affected</code>,{' '}
          <code>likely-affected</code>, or <code>inconclusive</code>.
        </p>
      </div>
    </Modal>
  );
}
