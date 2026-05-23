'use client';

import { useState } from 'react';
import { getApiClient } from '@/lib/client/api-client';
import type { CachePruneResponse } from '@/lib/api-types';
import { Button } from '../Button';
import styles from './CacheSettings.module.css';

const DEFAULT_OLDER_THAN_DAYS = 30;

/**
 * Settings → Cache section (spec §7.7, Wireframe 17).
 *
 * Two-step prune flow:
 *   1. Preview → dry-run, BE returns counts only.
 *   2. Delete  → confirmed prune, BE deletes the files.
 *
 * The two-step design prevents accidental deletion. Both calls go through the
 * same `POST /api/cache/prune` endpoint with `dryRun=true|false`.
 */
export function CacheSettings(): JSX.Element {
  const [olderThanDays, setOlderThanDays] = useState<number>(DEFAULT_OLDER_THAN_DAYS);
  const [preview, setPreview] = useState<CachePruneResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteResult, setDeleteResult] = useState<CachePruneResponse | null>(null);

  const onPreview = async () => {
    setPreviewing(true);
    setError(null);
    setDeleteResult(null);
    try {
      const res = await getApiClient().pruneCache(olderThanDays, true);
      setPreview(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed.');
    } finally {
      setPreviewing(false);
    }
  };

  const onDelete = async () => {
    if (!preview) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await getApiClient().pruneCache(olderThanDays, false);
      setDeleteResult(res);
      setPreview(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed.');
    } finally {
      setDeleting(false);
    }
  };

  const previewFileCount = preview?.pruned.files ?? 0;

  return (
    <div className={styles.pane}>
      <h3 className={styles.heading}>Cache</h3>

      <p className={styles.lead}>
        Clear cached AI reports older than N days. Preview first to see how many
        files would be removed.
      </p>

      <div className={styles.row}>
        <label className={styles.label} htmlFor="prune-older-input">
          Older than
        </label>
        <input
          id="prune-older-input"
          type="number"
          min={0}
          step={1}
          value={olderThanDays}
          onChange={(e) =>
            setOlderThanDays(Math.max(0, Number.parseInt(e.target.value, 10) || 0))
          }
          className={styles.daysInput}
          data-testid="prune-older-input"
        />
        <span className={styles.daysSuffix}>days</span>
      </div>

      <div className={styles.actions}>
        <Button
          onClick={() => void onPreview()}
          disabled={previewing}
          data-testid="prune-preview"
        >
          {previewing ? 'Previewing…' : 'Preview'}
        </Button>
        <Button
          tone="destructive"
          onClick={() => void onDelete()}
          disabled={!preview || previewFileCount === 0 || deleting}
          data-testid="prune-delete"
        >
          {deleting ? 'Deleting…' : 'Delete'}
        </Button>
      </div>

      {preview && (
        <p
          className={styles.previewMessage}
          role="status"
          data-testid="prune-preview-result"
        >
          Preview: {previewFileCount} {previewFileCount === 1 ? 'report' : 'reports'}{' '}
          would be deleted ({formatBytes(preview.pruned.bytes)}).
        </p>
      )}

      {deleteResult && (
        <p
          className={styles.successMessage}
          role="status"
          data-testid="prune-delete-result"
        >
          Removed {deleteResult.pruned.files}{' '}
          {deleteResult.pruned.files === 1 ? 'report' : 'reports'} (
          {formatBytes(deleteResult.pruned.bytes)}).
        </p>
      )}

      {error && (
        <p className={styles.errorMessage} role="alert" data-testid="prune-error">
          {error}
        </p>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log10(Math.max(1, n)) / 3));
  const value = n / Math.pow(1000, i);
  const formatted = i === 0 ? Math.round(value).toString() : value.toFixed(1);
  return `${formatted} ${units[i]}`;
}
